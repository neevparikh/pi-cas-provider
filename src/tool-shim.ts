/**
 * Bidirectional translation between Claude Code's built-in tools and pi's tools.
 *
 * The model is trained to use Claude Code's tool names (Read/Write/Edit/Bash/Grep/Glob)
 * fluently — keeping those names preserves that fluency. We translate to pi's names
 * and argument shapes at the provider boundary in both directions:
 *
 *   inbound  (model → pi):  claudeToPi()  — converts emitted tool_use blocks
 *   outbound (pi → model):  piToClaude()  — converts historic toolCalls for transcript
 *
 * The 6 Claude Code tools that map to pi's 6 built-ins:
 *   Read  → read    (file_path → path)
 *   Write → write   (file_path → path)
 *   Edit  → edit    (file_path → path; old_string/new_string → edits[].oldText/newText)
 *   Bash  → bash    (timeout ms → s; other args dropped)
 *   Grep  → grep    (-i → ignoreCase; -C/context → context; head_limit → limit; many CC opts dropped)
 *   Glob  → find    (name change only)
 *
 * Custom pi tools — anything not in the 6 — are exposed via an MCP server in v0.1+.
 * For v0 they fall through unchanged (custom tools won't be visible to Claude).
 */

/** Names of Claude Code tools that should be allowed (whitelisted) — the 6 mapped tools. */
export const ALLOWED_CC_TOOLS = ["Read", "Write", "Edit", "Bash", "Grep", "Glob"] as const;

/**
 * Claude Code tools that pi cannot execute. Listed in `disallowedTools` so the model
 * never sees them in the API request. Without this they leak into context and the
 * model may attempt to call them.
 */
export const DISALLOWED_CC_TOOLS = [
  "Agent",
  "AskUserQuestion",
  "CronCreate",
  "CronDelete",
  "CronList",
  "EnterPlanMode",
  "EnterWorktree",
  "ExitPlanMode",
  "ExitWorktree",
  "Monitor",
  "NotebookEdit",
  "PushNotification",
  "ScheduleWakeup",
  "Skill",
  "TaskCreate",
  "TaskGet",
  "TaskList",
  "TaskOutput",
  "TaskStop",
  "TaskUpdate",
  "WebFetch",
  "WebSearch",
] as const;

/** Map from Claude Code tool name to pi tool name. */
const CC_TO_PI_NAME: Record<string, string> = {
  Read: "read",
  Write: "write",
  Edit: "edit",
  Bash: "bash",
  Grep: "grep",
  Glob: "find",
};

/** Reverse map: pi tool name → Claude Code tool name. */
const PI_TO_CC_NAME: Record<string, string> = Object.fromEntries(
  Object.entries(CC_TO_PI_NAME).map(([cc, pi]) => [pi, cc]),
);

/** A normalized (name, args) pair. */
export interface ToolCallShape {
  name: string;
  arguments: Record<string, unknown>;
}

/**
 * Translate a tool call emitted by Claude (Claude Code tool name + CC-shaped input)
 * into pi's expected shape. Returns `null` if the name is not a known mapping AND
 * not an MCP-prefixed custom tool — caller should decide whether to forward as-is.
 */
export function claudeToPi(ccName: string, input: Record<string, unknown>): ToolCallShape {
  switch (ccName) {
    case "Read":
      return { name: "read", arguments: renameKey(input, "file_path", "path") };

    case "Write":
      return { name: "write", arguments: renameKey(input, "file_path", "path") };

    case "Edit": {
      // CC takes a single {old_string, new_string, replace_all?}.
      // Pi takes {path, edits: [{oldText, newText}]}.
      const path = input.file_path ?? input.path;
      const oldText = input.old_string;
      const newText = input.new_string;
      const out: Record<string, unknown> = {
        path,
        edits: [{ oldText, newText }],
      };
      // replace_all silently dropped — system-prompt block tells model about this
      return { name: "edit", arguments: out };
    }

    case "Bash": {
      const out: Record<string, unknown> = { command: input.command };
      if (typeof input.timeout === "number") {
        // CC timeout is in ms (max 600000). Pi timeout is in seconds.
        // Heuristic: any value > 600 must be ms (no one wants a 10+ minute timeout
        // expressed in seconds via a tool). For <= 600, assume the model already
        // accounted for the unit difference (we tell it in the system prompt).
        out.timeout = input.timeout > 600 ? Math.round(input.timeout / 1000) : input.timeout;
      }
      // description, run_in_background, dangerouslyDisableSandbox silently dropped
      return { name: "bash", arguments: out };
    }

    case "Grep": {
      const out: Record<string, unknown> = { pattern: input.pattern };
      if (input.path !== undefined) out.path = input.path;
      if (input.glob !== undefined) out.glob = input.glob;
      if (input["-i"] !== undefined) out.ignoreCase = input["-i"];
      // CC has -C and context; both mean symmetric. Either maps to pi's `context`.
      if (input["-C"] !== undefined) out.context = input["-C"];
      else if (input.context !== undefined) out.context = input.context;
      if (input.head_limit !== undefined) out.limit = input.head_limit;
      // -A, -B, -n, -o, type, multiline, offset, output_mode silently dropped
      return { name: "grep", arguments: out };
    }

    case "Glob": {
      // Pi's find accepts pattern + path + limit; CC's Glob has pattern + path only.
      return { name: "find", arguments: { ...input } };
    }

    default: {
      // mcp__<server>__<tool> prefix → strip and forward (v0.1 custom tools path)
      const MCP_PREFIX = "mcp__pi-tools__";
      if (ccName.startsWith(MCP_PREFIX)) {
        return { name: ccName.slice(MCP_PREFIX.length), arguments: input };
      }
      // Unknown — pass through. Pi will reject if it doesn't recognize the tool.
      return { name: ccName, arguments: input };
    }
  }
}

/**
 * Translate a pi tool call (pi name + pi-shaped args) into a Claude Code-shaped
 * tool_use block. Used when materializing pi's conversation history into the
 * Claude Code transcript JSONL — the model expects to see its native tool names.
 */
export function piToClaude(piName: string, args: Record<string, unknown>): {
  name: string;
  input: Record<string, unknown>;
} {
  switch (piName) {
    case "read":
      return { name: "Read", input: renameKey(args, "path", "file_path") };

    case "write":
      return { name: "Write", input: renameKey(args, "path", "file_path") };

    case "edit": {
      // pi: {path, edits: [{oldText, newText}, ...]}
      // → CC: assistant historically emitted N separate {old_string, new_string} Edits.
      // We collapse to the FIRST edit only — pi's batched edits don't have a single
      // CC equivalent. Multiple-edit-in-one-call history is rare in practice and
      // doesn't affect the model's understanding of the conversation flow.
      const edits = Array.isArray(args.edits) ? (args.edits as any[]) : [];
      const first = edits[0] ?? {};
      const out: Record<string, unknown> = {
        file_path: args.path,
        old_string: first.oldText ?? "",
        new_string: first.newText ?? "",
      };
      return { name: "Edit", input: out };
    }

    case "bash": {
      const out: Record<string, unknown> = { command: args.command };
      if (typeof args.timeout === "number") {
        // pi: seconds → CC historical record: ms
        out.timeout = args.timeout * 1000;
      }
      return { name: "Bash", input: out };
    }

    case "grep": {
      const out: Record<string, unknown> = { pattern: args.pattern };
      if (args.path !== undefined) out.path = args.path;
      if (args.glob !== undefined) out.glob = args.glob;
      if (args.ignoreCase !== undefined) out["-i"] = args.ignoreCase;
      if (args.context !== undefined) out.context = args.context;
      if (args.limit !== undefined) out.head_limit = args.limit;
      return { name: "Grep", input: out };
    }

    case "find": {
      const { limit: _limit, ...rest } = args; // CC has no limit
      return { name: "Glob", input: rest };
    }

    default: {
      // Custom pi tool → MCP-prefixed name so the (future) MCP-side will pick it up.
      // For v0 this just means the historic call shows up with the prefixed name;
      // the model has never seen this tool in the current API request anyway.
      return { name: PI_TO_CC_NAME[piName] ?? `mcp__pi-tools__${piName}`, input: args };
    }
  }
}

/** Helper: rename a single key in a flat object, preserving all other keys. */
function renameKey(
  obj: Record<string, unknown>,
  from: string,
  to: string,
): Record<string, unknown> {
  if (!(from in obj)) return { ...obj };
  const { [from]: value, ...rest } = obj;
  return { ...rest, [to]: value };
}
