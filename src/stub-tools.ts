/**
 * Stub tool definitions for pi's agent loop.
 *
 * # Why
 *
 * In the stream-aligned-segmentation architecture, the SDK runs every tool
 * natively inside its long-lived `query()`.  But pi's agent loop
 * (`pi-agent-core/dist/agent-loop.js:113-117`) unconditionally executes every
 * `toolCall` block in an assistant message via its own tool registry — it
 * does NOT have any notion of "this tool was already executed externally,
 * just display it."
 *
 * To satisfy pi's invariant without re-running the tool, we register a stub
 * tool for each CC built-in tool name (`Bash`, `Read`, `Write`, `Edit`,
 * `Grep`, `Glob`, `WebFetch`, ...).  When pi's loop "executes" the stub, it
 * looks up the cached result the SDK already produced (see
 * `tool-result-cache.ts`) and returns it instantly with no side effects.
 *
 * # Naming convention
 *
 * The stubs use the CC PascalCase names (`Bash`, `Read`, ...).  Pi's
 * built-in tools use lowercase names (`bash`, `read`, ...).  The two sets
 * coexist without collision; the model never sees pi's lowercase names
 * (only the SDK's tools[] entries are sent to the API), so the model only
 * emits PascalCase names that match our stubs.
 *
 * # Schema looseness
 *
 * The SDK already validates tool arguments against the real CC schemas
 * before executing the tool.  Anything the SDK passes us is therefore
 * well-formed; the stub doesn't need to re-validate.  We use loose schemas
 * (Type.Object with additionalProperties allowed) so we don't have to keep
 * pi's view of the schema in lockstep with whatever CC version the
 * subprocess happens to be running.
 *
 * # Why pre-register every known CC tool name (not rely on the catch-all)
 *
 * pi-agent-core's `runAgentLoop` takes a one-shot snapshot of `tools` at
 * the start of each prompt (`agent.js:271-277` → `tools: this._state.tools.slice()`)
 * and the agent-loop's `currentContext.tools` never re-reads from any live
 * source thereafter.  So if pi-cas tries to `pi.registerTool(...)` a
 * brand-new stub mid-segment — e.g. for an `AskUserQuestion` tool_use we
 * hadn't anticipated — the registration updates `extension.tools` and
 * `_toolRegistry`, but the snapshot is stale.  Pi then looks up the tool
 * in the stale snapshot, doesn't find it, and reports `Tool X not found`.
 *
 * To work around that, we pre-register a stub for EVERY known CC tool the
 * subprocess might emit (see {@link SUPPORTED_CC_TOOL_NAMES}).  The list
 * is derived from the strings in `@anthropic-ai/claude-agent-sdk-darwin-arm64/claude`,
 * i.e. the bundled subprocess itself.  The dynamic catch-all
 * ({@link createGenericStub}) is kept only as a defense-in-depth fallback
 * for genuinely novel tools (MCP servers, future SDK additions); it will
 * only work on the SECOND occurrence of an unknown name, when the snapshot
 * for the next prompt picks it up.
 */

import { Type } from "typebox";
import type { Component } from "@earendil-works/pi-tui";
import { Text } from "@earendil-works/pi-tui";
import type { Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { defineTool } from "@earendil-works/pi-coding-agent";

import {
  take,
  size as cacheSize,
  keysSnapshot as cacheKeys,
} from "./tool-result-cache.js";

const DEBUG = process.env.PI_CAS_DEBUG === "1";

/**
 * Per-tool metadata for every CC tool name the SDK preset can surface
 * (extracted from strings in the bundled `claude` subprocess binary).
 *
 * The `executionMode` choice controls how pi schedules tool calls in the
 * same assistant message:
 *  - `parallel`: pure read-only or otherwise safe to interleave (Read,
 *    Grep, Glob, WebFetch, WebSearch, MCP reads).
 *  - `sequential`: anything with side effects, anything user-facing (UI
 *    prompts), or anything we're unsure about.  When in doubt, sequential
 *    is the safe choice — the cost is mild loss of concurrency, never
 *    correctness.
 *
 * The execution mode of the stub doesn't affect the real tool's behavior
 * (the SDK already ran it before pi sees it); it only affects whether pi
 * runs our cache-lookup stubs in parallel.  Cache lookups are O(1) and
 * non-blocking, so `parallel` is essentially free where it's safe.
 */
const TOOL_METADATA: Record<string, { executionMode: "sequential" | "parallel" }> = {
  // -- six "core" tools (the original SUPPORTED set) ----------------
  Bash: { executionMode: "sequential" },
  Read: { executionMode: "parallel" },
  Write: { executionMode: "sequential" },
  Edit: { executionMode: "sequential" },
  Grep: { executionMode: "parallel" },
  Glob: { executionMode: "parallel" },
  // -- web / search ------------------------------------------------
  WebFetch: { executionMode: "parallel" },
  WebSearch: { executionMode: "parallel" },
  // -- notebooks ---------------------------------------------------
  NotebookEdit: { executionMode: "sequential" },
  // -- todo list ---------------------------------------------------
  TodoWrite: { executionMode: "sequential" },
  // -- plan mode ---------------------------------------------------
  ExitPlanMode: { executionMode: "sequential" },
  EnterPlanMode: { executionMode: "sequential" },
  // -- user-facing prompts (cannot be parallelized) ----------------
  AskUserQuestion: { executionMode: "sequential" },
  PushNotification: { executionMode: "sequential" },
  // -- skills / scheduling -----------------------------------------
  Skill: { executionMode: "sequential" },
  ScheduleWakeup: { executionMode: "sequential" },
  Monitor: { executionMode: "sequential" },
  // -- cron --------------------------------------------------------
  CronCreate: { executionMode: "sequential" },
  CronDelete: { executionMode: "sequential" },
  CronList: { executionMode: "parallel" },
  // -- worktrees ---------------------------------------------------
  EnterWorktree: { executionMode: "sequential" },
  ExitWorktree: { executionMode: "sequential" },
  // -- pi-style task tracking (these are CC's own task tools, distinct
  //    from the subagent dispatcher `Agent` / legacy `Task`) -------
  TaskCreate: { executionMode: "sequential" },
  TaskGet: { executionMode: "parallel" },
  TaskList: { executionMode: "parallel" },
  TaskUpdate: { executionMode: "sequential" },
  TaskStop: { executionMode: "sequential" },
  TaskOutput: { executionMode: "sequential" },
  // -- MCP ---------------------------------------------------------
  // (Real `mcp__server__tool` names are dynamic; only the catch-all
  // path can register stubs for those, and only after pi's snapshot
  // picks them up on the next prompt.)
};

/**
 * Tools the SDK runs as "client-side" — they require the host application
 * to render a UI and provide a user answer.  In subprocess mode (where
 * pi-cas runs the SDK), the SDK normally surfaces an error tool_result
 * for these instead of actually rendering UI.  We don't currently provide
 * a UI bridge for them.
 *
 * Listed for diagnostic purposes only — used by {@link executeStub} to
 * produce a more helpful error message on cache miss.
 */
const INTERACTIVE_TOOL_NAMES: ReadonlySet<string> = new Set([
  "AskUserQuestion",
  "PushNotification",
  "ExitPlanMode",
  "EnterPlanMode",
]);

/**
 * The set of CC built-in tool names we statically pre-register stubs for.
 *
 * Why pre-register everything: see file docstring's "Why pre-register..."
 * section.  TL;DR — pi-agent-core snapshots `tools` once per prompt, so
 * dynamic stubs registered mid-segment don't reach the executor.
 *
 * Why we don't include `Agent` / `Task` here: those have a richer custom
 * stub (see `src/task-stub.ts`) registered separately by the provider —
 * including them here would cause a double-register.
 */
export const SUPPORTED_CC_TOOL_NAMES = Object.keys(TOOL_METADATA) as readonly string[];
export type SupportedCcToolName = (typeof SUPPORTED_CC_TOOL_NAMES)[number];

/**
 * Regex guarding which model-emitted tool names we will accept for dynamic
 * stub registration via {@link createGenericStub}.  This is a *safety belt*,
 * not a security boundary — the SDK already validates tool names against its
 * own registry before emitting `tool_use` blocks.  But pi's `registerTool`
 * happily accepts any string as a name, and bad names (with whitespace,
 * slashes, etc.) could collide with internal pi conventions or break tool
 * matching in pi's UI.  CC tool names are PascalCase identifiers with
 * underscores in MCP tools (e.g. `mcp__server__tool`); we accept that shape.
 */
const VALID_DYNAMIC_TOOL_NAME = /^[A-Za-z][A-Za-z0-9_]*$/;

/* ----------------------------- shared helpers ----------------------------- */

/**
 * Generic execute() for every stub.  Looks the SDK-cached result up by tool
 * use id, returns it as a pi `AgentToolResult`.
 *
 * The cache is populated by the event bridge as soon as the SDK emits the
 * matching `user(tool_result)` SDKUserMessage, which (per our two e2e
 * probes) always arrives BEFORE we push the segment's `done` to pi.  So
 * the cache miss path is defensive only.
 */
export async function executeStub(
  toolName: string,
  toolCallId: string,
): Promise<{
  content: any[];
  details: unknown;
}> {
  const entry = take(toolCallId);
  if (!entry) {
    // Cache miss — the SDK didn't emit a tool_result for this tool_use by
    // the time pi's executor reached us, OR something cleared/took our
    // entry first.  Always log (not just under DEBUG) since it's an
    // unrecoverable internal error worth a paper trail in production.
    const otherKeys = cacheKeys();
    console.error(
      `[pi-cas] stub ${toolName}: CACHE MISS for ${toolCallId} ` +
        `(cache.size=${cacheSize()}, other keys=[${otherKeys.join(", ")}])`,
    );
    const isInteractive = INTERACTIVE_TOOL_NAMES.has(toolName);
    const hint = isInteractive
      ? ` Note: ${toolName} is an interactive tool; pi-cas runs the SDK ` +
        `in subprocess mode which normally surfaces an error tool_result ` +
        `for these.  If this keeps happening, run pi with PI_CAS_DEBUG=1 ` +
        `to capture the bridge's event trace.`
      : "";
    return {
      content: [
        {
          type: "text",
          text:
            `[pi-cas internal error: no cached result for ${toolName} ` +
            `call ${toolCallId}. The SDK should have produced this result ` +
            `before pi's loop got here. Please file a bug.${hint}]`,
        },
      ],
      // Mark as error so pi-cas's tool_result hook propagates isError=true
      // to pi's ToolResultMessage — a cache miss is a real internal failure
      // and should surface to the user/UI as such, not as a silent
      // "successful" tool execution.
      details: {
        _piCasStubError: "cache-miss",
        _piCasIsError: true,
        _piCasToolName: toolName,
        toolCallId,
      },
    };
  }
  if (DEBUG) {
    console.error(
      `[pi-cas/debug] stub ${toolName}: cache HIT for ${toolCallId} ` +
        `(isError=${entry.isError}, ${entry.content.length} blocks)`,
    );
  }
  // Pi's agent-core conveys errors via thrown exceptions (per the
  // AgentTool.execute contract).  But our "error" tool results are not
  // execution failures of the stub — they're successful retrievals of an
  // error result the SDK produced.  Returning them as content with the
  // error flag stuffed into details is the closest analogue; pi-coding-
  // agent's `tool_result` event handler reads `_piCasIsError` post-hoc
  // (see provider.ts) and overrides ToolResultMessage.isError accordingly.
  // We do NOT throw, because that would surface to the user as a
  // pi-cas-internal error rather than as the model's tool failing its task.
  //
  // Detail-shape handling: SDKUserMessage.tool_use_result is structured
  // (e.g. {stdout, stderr, ...} for Bash) for success and a plain string
  // for some failures ("Error: Exit code 7").  Spreading a string into
  // an object would corrupt it into {0: "E", 1: "r", ...}, so we only
  // spread when the SDK detail is a non-null plain object.  For other
  // shapes (string, array, undefined, primitive), we preserve the
  // original under `_piCasToolUseResult` so callers can still introspect.
  const sdkDetails = entry.details;
  const detailsIsPlainObject =
    sdkDetails !== null && typeof sdkDetails === "object" && !Array.isArray(sdkDetails);
  const details: Record<string, unknown> = detailsIsPlainObject
    ? { ...(sdkDetails as Record<string, unknown>) }
    : {};
  if (!detailsIsPlainObject && sdkDetails !== undefined) {
    details._piCasToolUseResult = sdkDetails;
  }
  details._piCasIsError = entry.isError;
  details._piCasToolName = entry.toolName;
  return {
    content: entry.content,
    details,
  };
}

/* ----------------------------- per-tool schemas ----------------------------- */

// Loose schemas: we don't validate or constrain — the SDK already did.
//
// (Why not Type.Any?  Pi's harness uses `Static<TSchema>` to type-check the
// params arg.  Object-with-passthrough gives a more useful Static type
// while still accepting anything.)

const looseSchema = Type.Object({}, { additionalProperties: true });

/* ----------------------------- factories ----------------------------- */

/**
 * Build a stub ToolDefinition for one CC tool name.
 *
 * The stub's behavior is identical for every name (cache-lookup execute);
 * the only per-tool customization is `executionMode` (from
 * {@link TOOL_METADATA}) and `renderCall` (which formats the model's
 * arguments — Bash command, file path, URL, etc. — so pi shows what the
 * call was *about*, not just the bare tool name).
 */
function createNamedStub(name: string): ToolDefinition {
  const metadata = TOOL_METADATA[name] ?? { executionMode: "sequential" };
  return defineTool({
    name,
    label: `${name} (claude-code)`,
    description:
      `${name} tool. Executed by the Claude Agent SDK; pi-cas retrieves ` +
      "the result from a per-session cache.",
    parameters: looseSchema,
    executionMode: metadata.executionMode,
    prepareArguments: (args) => (args ?? {}) as any,
    async execute(toolCallId) {
      return executeStub(name, toolCallId);
    },
    renderCall(args, theme) {
      return renderToolCallText(name, (args ?? {}) as Record<string, unknown>, theme);
    },
  });
}

/**
 * Build all named CC stub ToolDefinitions.
 *
 * Called once from `provider.ts` at extension registration; the results are
 * registered via `pi.registerTool`.  Tool definitions are stateless — all
 * runtime state lives in the shared result cache (`tool-result-cache.ts`).
 */
export function createStubTools(): ToolDefinition[] {
  return SUPPORTED_CC_TOOL_NAMES.map(createNamedStub);
}

/**
 * Helper: is a model-emitted tool name something we stub for pi?
 *
 * Used by the event bridge for sanity warnings — if the SDK ever emits a
 * tool_use whose name isn't in this set, pi's loop will fail with
 * `Tool <name> not found` UNLESS our catch-all dynamic registration runs
 * (which only helps on a SUBSEQUENT prompt — see file docstring).
 */
export function isSupportedStubTool(name: string): name is SupportedCcToolName {
  return Object.prototype.hasOwnProperty.call(TOOL_METADATA, name);
}

/**
 * Validate that `name` is shaped like a CC built-in or MCP tool name and is
 * safe to register dynamically.  See {@link VALID_DYNAMIC_TOOL_NAME}.
 */
export function isValidDynamicToolName(name: string): boolean {
  if (typeof name !== "string" || name.length === 0 || name.length > 128) return false;
  return VALID_DYNAMIC_TOOL_NAME.test(name);
}

/**
 * Build a generic catch-all stub for a tool name we didn't anticipate.
 *
 * Used by {@link createEventBridge} via its `onUnknownToolName` callback:
 * when the SDK emits a `tool_use` block whose name isn't in
 * {@link SUPPORTED_CC_TOOL_NAMES}, the provider registers one of these stubs
 * with pi just-in-time, so pi's agent loop has a tool to execute and won't
 * crash with `Tool <name> not found`.
 *
 * **Caveat — see file docstring "Why pre-register every known CC tool name":**
 * pi-agent-core takes a one-shot tool snapshot at the start of each prompt.
 * A dynamic registration mid-segment will NOT reach the executor for that
 * prompt — pi has already snapshotted the tool list.  The stub will only
 * be visible on the NEXT prompt, after pi takes a fresh snapshot.
 *
 * So this path is best-effort:
 *  - First time the unknown tool fires: pi reports "Tool X not found" and
 *    surfaces an error tool_result.  The dynamic stub is registered, but
 *    too late for THIS prompt.
 *  - Second time (in a subsequent prompt): the snapshot includes our stub,
 *    pi executes it, the cache lookup succeeds.
 *
 * For tools we know about, pre-register them statically in
 * {@link TOOL_METADATA} instead.
 *
 * The stub's `execute()` looks up the SDK-cached result by toolCallId just
 * like the named stubs.  The schema is the loosest possible
 * (additionalProperties: true on an empty object), since the SDK has already
 * validated the model's arguments against the real tool's schema.
 */
export function createGenericStub(name: string): ToolDefinition {
  if (!isValidDynamicToolName(name)) {
    // We should never get here — the provider checks before calling — but
    // throw loudly if we do, since otherwise pi.registerTool would happily
    // accept a name that may collide with internal conventions.
    throw new Error(
      `pi-cas: refusing to create generic stub for invalid tool name: ${JSON.stringify(name)}`,
    );
  }
  return defineTool({
    name,
    label: `${name} (claude-code, dynamic stub)`,
    description:
      `Catch-all stub for the "${name}" tool, registered by pi-cas at ` +
      "runtime after the Claude Agent SDK emitted a tool_use block with " +
      "this name.  The SDK executes the tool natively; pi-cas retrieves " +
      "the result from a per-session cache.",
    parameters: looseSchema,
    // Conservative default: assume tools we don't know about could have
    // side effects.  Run sequentially so pi doesn't race their cache
    // lookups against each other or against side-effecting siblings.
    executionMode: "sequential",
    prepareArguments: (args) => (args ?? {}) as any,
    async execute(toolCallId) {
      return executeStub(name, toolCallId);
    },
    renderCall(args, theme) {
      return renderToolCallText(name, (args ?? {}) as Record<string, unknown>, theme);
    },
  });
}

/* ----------------------------- renderCall formatting ----------------------------- */

/**
 * Render a tool call's arguments as a short one-line summary suitable for
 * pi's tool-call display.  Pi already shows the tool's label on its own
 * line (e.g. "Bash (claude-code)"); we render the INPUT — the actual
 * command, file path, URL, query — so the user can see what the call was
 * about without expanding.
 *
 * Format is modeled on pi-subagent's `formatToolCall` and on what each CC
 * tool's UI shows in the regular CC client:
 *
 *   Bash             $ git log --oneline -10
 *   Read             ~/repos/foo/bar.ts:42-100
 *   Write            ~/repos/foo/bar.ts (250 lines)
 *   Edit             ~/repos/foo/bar.ts
 *   Grep             /pattern/ in src
 *   Glob             **\/*.ts in .
 *   AskUserQuestion  Which approach? (+ 2 more questions)
 *   TodoWrite        5 todos (3 in_progress)
 *   WebFetch         https://example.com/docs
 *   WebSearch        "claude code release notes"
 *
 * Returned as a {@link Component} (pi-tui `Text`) so pi can lay it out
 * alongside the standard tool framing.
 */
export function renderToolCallText(
  toolName: string,
  args: Record<string, unknown>,
  theme: Theme,
): Component {
  return new Text(formatToolCall(toolName, args, theme), 0, 0);
}

/**
 * Compact per-call formatting modeled on pi-subagent's `formatToolCall`,
 * adapted to CC's PascalCase tool names.  Returns a single line (or
 * multi-line for tools where that's more informative, like AskUserQuestion).
 *
 * Exported for reuse in {@link createTaskStub}'s subagent transcript
 * renderer (each transcript line shows the subagent's tool call in this
 * same compact form).
 */
export function formatToolCall(
  toolName: string,
  rawArgs: unknown,
  theme: Pick<Theme, "fg">,
): string {
  const fg = theme.fg.bind(theme);
  const home = process.env.HOME ?? "";
  const shortenPath = (p: string) =>
    home && p.startsWith(home) ? `~${p.slice(home.length)}` : p;
  const truncate = (s: string, n: number) =>
    s.length > n ? `${s.slice(0, n)}...` : s;

  // Defensive: `args` may not be a plain object during partial-streaming
  // (we initialize to `{}` and reparse on each `input_json_delta`, but the
  // model's incremental JSON can transiently make values weird shapes —
  // e.g. a partial array whose first complete parse has `questions` as a
  // string before the full structure arrives).  Every per-tool branch below
  // should defend against args being undefined/null/primitive/array; we
  // hoist the safe-getter here.
  const isObj = (v: unknown): v is Record<string, unknown> =>
    v !== null && typeof v === "object" && !Array.isArray(v);
  const isStr = (v: unknown): v is string => typeof v === "string";
  const args: Record<string, unknown> = isObj(rawArgs) ? rawArgs : {};
  // Coerce "array-like-but-actually-a-string-or-missing" into a clean
  // array; lets each branch trust that what it iterates is a real array.
  const asArray = <T = unknown>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);

  switch (toolName) {
    /* -- core file/shell tools ------------------------------------- */
    case "Bash": {
      const command = (args.command as string) ?? "...";
      return fg("muted", "$ ") + fg("toolOutput", truncate(command, 120));
    }
    case "Read": {
      const filePath = shortenPath((args.file_path as string) ?? "...");
      const offset = args.offset as number | undefined;
      const limit = args.limit as number | undefined;
      let text = fg("accent", filePath);
      if (offset !== undefined || limit !== undefined) {
        const startLine = offset ?? 1;
        const endLine = limit !== undefined ? startLine + limit - 1 : "";
        text += fg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
      }
      return text;
    }
    case "Write": {
      const filePath = shortenPath((args.file_path as string) ?? "...");
      const content = (args.content as string) ?? "";
      const lines = content ? content.split("\n").length : 0;
      let text = fg("accent", filePath);
      if (lines > 1) text += fg("dim", ` (${lines} lines)`);
      return text;
    }
    case "Edit": {
      const filePath = shortenPath((args.file_path as string) ?? "...");
      // For single-string edits, show a tiny preview of what we're searching
      // for, since the path alone doesn't disambiguate multiple edits in
      // the same file.
      const oldStr = (args.old_string as string) ?? "";
      const replaceAll = args.replace_all === true;
      let text = fg("accent", filePath);
      if (oldStr) {
        const firstLine = oldStr.split("\n")[0]?.trim() ?? "";
        text += fg("dim", ` ${truncate(firstLine, 40)}`);
      }
      if (replaceAll) text += fg("warning", " (all)");
      return text;
    }
    case "Grep": {
      const pattern = (args.pattern as string) ?? "";
      const path = shortenPath((args.path as string) ?? ".");
      const glob = args.glob as string | undefined;
      let text = fg("accent", `/${pattern}/`) + fg("dim", ` in ${path}`);
      if (glob) text += fg("dim", ` --glob ${glob}`);
      return text;
    }
    case "Glob": {
      const pattern = (args.pattern as string) ?? "*";
      const path = shortenPath((args.path as string) ?? ".");
      return fg("accent", pattern) + fg("dim", ` in ${path}`);
    }
    /* -- subagent (Task / Agent) ----------------------------------- */
    case "Task":
    case "Agent": {
      const subType = (args.subagent_type as string) ?? "default";
      const desc = ((args.description as string) ?? (args.prompt as string) ?? "").slice(0, 60);
      return fg("accent", subType) + fg("dim", ` ${desc}`);
    }
    /* -- web / search ---------------------------------------------- */
    case "WebFetch": {
      const url = (args.url as string) ?? "...";
      return fg("accent", truncate(url, 100));
    }
    case "WebSearch": {
      const query = (args.query as string) ?? "...";
      return fg("accent", `"${truncate(query, 100)}"`);
    }
    /* -- notebooks ------------------------------------------------- */
    case "NotebookEdit": {
      const path = shortenPath((args.notebook_path as string) ?? "...");
      const cellId = args.cell_id as string | undefined;
      const editMode = (args.edit_mode as string | undefined) ?? "replace";
      let text = fg("accent", path) + fg("dim", ` [${editMode}]`);
      if (cellId) text += fg("dim", ` cell=${truncate(cellId, 20)}`);
      return text;
    }
    /* -- todo list ------------------------------------------------- */
    case "TodoWrite": {
      const todos = asArray<unknown>(args.todos);
      const statusOf = (t: unknown): string | undefined =>
        isObj(t) && isStr(t.status) ? t.status : undefined;
      const total = todos.length;
      const inProgress = todos.filter((t) => statusOf(t) === "in_progress").length;
      const completed = todos.filter((t) => statusOf(t) === "completed").length;
      const parts = [`${total} todo${total === 1 ? "" : "s"}`];
      if (inProgress > 0) parts.push(`${inProgress} in_progress`);
      if (completed > 0) parts.push(`${completed} done`);
      return fg("accent", parts.join(", "));
    }
    /* -- user prompts ---------------------------------------------- */
    case "AskUserQuestion": {
      const questions = asArray<unknown>(args.questions);
      if (questions.length === 0) return fg("muted", "(no questions)");
      const firstQuestion = isObj(questions[0]) && isStr(questions[0].question)
        ? questions[0].question
        : "";
      const first = truncate(firstQuestion, 100);
      let text = first ? fg("accent", first) : fg("muted", "(streaming...)");
      if (questions.length > 1) {
        text += fg("dim", ` (+${questions.length - 1} more)`);
      }
      return text;
    }
    case "PushNotification": {
      const message = isStr(args.message) ? args.message : "";
      return fg("accent", truncate(message, 120));
    }
    /* -- plan mode ------------------------------------------------- */
    case "ExitPlanMode": {
      const plan = (args.plan as string) ?? "";
      const firstLine = plan.split("\n")[0]?.trim() ?? "";
      return fg("dim", truncate(firstLine, 100));
    }
    case "EnterPlanMode": {
      return fg("dim", "(enter plan mode)");
    }
    /* -- skills / scheduling --------------------------------------- */
    case "Skill": {
      const skill = (args.skill as string) ?? "?";
      const skillArgs = (args.args as string) ?? "";
      let text = fg("accent", skill);
      if (skillArgs) text += fg("dim", ` ${truncate(skillArgs, 80)}`);
      return text;
    }
    case "ScheduleWakeup": {
      const delay = args.delaySeconds as number | undefined;
      const reason = (args.reason as string) ?? "";
      let text = fg("accent", delay !== undefined ? `+${delay}s` : "?");
      if (reason) text += fg("dim", ` ${truncate(reason, 80)}`);
      return text;
    }
    case "Monitor": {
      const description = (args.description as string) ?? "";
      const cmd = (args.command as string) ?? "";
      let text = fg("accent", truncate(description, 60));
      if (cmd) text += "\n" + fg("muted", "$ ") + fg("dim", truncate(cmd, 80));
      return text;
    }
    /* -- cron ------------------------------------------------------ */
    case "CronCreate": {
      const cron = (args.cron as string) ?? "?";
      const prompt = (args.prompt as string) ?? "";
      return fg("accent", cron) + (prompt ? fg("dim", ` → ${truncate(prompt, 80)}`) : "");
    }
    case "CronDelete": {
      const id = (args.id as string) ?? "?";
      return fg("accent", id);
    }
    case "CronList": {
      return fg("dim", "(list cron jobs)");
    }
    /* -- worktrees ------------------------------------------------- */
    case "EnterWorktree": {
      const name = (args.name as string) ?? (args.path as string) ?? "(auto)";
      return fg("accent", name);
    }
    case "ExitWorktree": {
      const action = (args.action as string) ?? "?";
      const discard = args.discard_changes === true ? " (discarding changes)" : "";
      return fg("accent", action) + fg("warning", discard);
    }
    /* -- CC's task tracking ---------------------------------------- */
    case "TaskCreate": {
      const subject = (args.subject as string) ?? "...";
      return fg("accent", truncate(subject, 100));
    }
    case "TaskGet": {
      const id = (args.taskId as string) ?? "?";
      return fg("accent", id);
    }
    case "TaskUpdate": {
      const id = (args.taskId as string) ?? "?";
      const status = args.status as string | undefined;
      let text = fg("accent", id);
      if (status) text += fg("dim", ` → ${status}`);
      return text;
    }
    case "TaskList": {
      return fg("dim", "(list tasks)");
    }
    case "TaskOutput":
    case "TaskStop": {
      const id = (args.task_id as string) ?? (args.shell_id as string) ?? "?";
      return fg("accent", id);
    }
    /* -- generic fallback ------------------------------------------ */
    default: {
      // Strip out very large fields (full file contents, base64, etc.) so the
      // JSON preview is informative rather than overwhelming.
      const trimmed: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(args ?? {})) {
        if (typeof v === "string" && v.length > 80) {
          trimmed[k] = `${v.slice(0, 60)}...`;
        } else {
          trimmed[k] = v;
        }
      }
      const argsStr = JSON.stringify(trimmed);
      return fg("dim", truncate(argsStr, 120));
    }
  }
}
