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
 * `Grep`, `Glob`).  When pi's loop "executes" the stub, it looks up the
 * cached result the SDK already produced (see `tool-result-cache.ts`) and
 * returns it instantly with no side effects.
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
 * # Disallowed CC tools
 *
 * We narrow the model's toolset (via SDK's `tools:` option in provider.ts)
 * to exactly the names registered here, so pi never receives a tool call
 * it doesn't know how to handle.
 */

import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { defineTool } from "@earendil-works/pi-coding-agent";

import { take, has } from "./tool-result-cache.js";

const DEBUG = process.env.PI_CAS_DEBUG === "1";

/** The set of CC built-in tools we expose to the model + stub for pi. */
export const SUPPORTED_CC_TOOL_NAMES = [
  "Bash",
  "Read",
  "Write",
  "Edit",
  "Grep",
  "Glob",
] as const;
export type SupportedCcToolName = (typeof SUPPORTED_CC_TOOL_NAMES)[number];

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
async function executeStub(
  toolName: SupportedCcToolName,
  toolCallId: string,
): Promise<{
  content: any[];
  details: unknown;
  terminate?: boolean;
}> {
  const entry = take(toolCallId);
  if (!entry) {
    if (DEBUG) {
      console.error(
        `[pi-cas/debug] stub ${toolName}: cache MISS for ${toolCallId} ` +
          `(this should not happen in normal flow)`,
      );
    }
    return {
      content: [
        {
          type: "text",
          text:
            `[pi-cas internal error: no cached result for ${toolName} ` +
            `call ${toolCallId}. The SDK should have produced this result ` +
            `before pi's loop got here. Please file a bug.]`,
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

const bashSchema = Type.Object(
  {
    command: Type.Optional(Type.String()),
    timeout: Type.Optional(Type.Number()),
  },
  { additionalProperties: true },
);

const readSchema = Type.Object(
  {
    file_path: Type.Optional(Type.String()),
    offset: Type.Optional(Type.Number()),
    limit: Type.Optional(Type.Number()),
  },
  { additionalProperties: true },
);

const writeSchema = Type.Object(
  {
    file_path: Type.Optional(Type.String()),
    content: Type.Optional(Type.String()),
  },
  { additionalProperties: true },
);

const editSchema = Type.Object(
  {
    file_path: Type.Optional(Type.String()),
    old_string: Type.Optional(Type.String()),
    new_string: Type.Optional(Type.String()),
    replace_all: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: true },
);

const grepSchema = Type.Object(
  {
    pattern: Type.Optional(Type.String()),
    path: Type.Optional(Type.String()),
    glob: Type.Optional(Type.String()),
  },
  { additionalProperties: true },
);

const globSchema = Type.Object(
  {
    pattern: Type.Optional(Type.String()),
    path: Type.Optional(Type.String()),
  },
  { additionalProperties: true },
);

/* ----------------------------- factories ----------------------------- */

/**
 * Build all six stub ToolDefinitions.
 *
 * Called once from `provider.ts` at extension registration; the results are
 * registered via `pi.registerTool`.  Tool definitions are stateless — all
 * runtime state lives in the shared result cache (`tool-result-cache.ts`).
 */
export function createStubTools(): ToolDefinition[] {
  return [
    defineTool({
      name: "Bash",
      label: "Bash (claude-code)",
      description:
        "Run a shell command. Executed by the Claude Agent SDK; pi-cas " +
        "retrieves the result from a per-session cache.",
      parameters: bashSchema,
      executionMode: "sequential",
      prepareArguments: (args) => (args ?? {}) as any,
      async execute(toolCallId) {
        return executeStub("Bash", toolCallId);
      },
    }),
    defineTool({
      name: "Read",
      label: "Read (claude-code)",
      description: "Read a file. Executed by the Claude Agent SDK.",
      parameters: readSchema,
      executionMode: "parallel",
      prepareArguments: (args) => (args ?? {}) as any,
      async execute(toolCallId) {
        return executeStub("Read", toolCallId);
      },
    }),
    defineTool({
      name: "Write",
      label: "Write (claude-code)",
      description: "Write a file. Executed by the Claude Agent SDK.",
      parameters: writeSchema,
      executionMode: "sequential",
      prepareArguments: (args) => (args ?? {}) as any,
      async execute(toolCallId) {
        return executeStub("Write", toolCallId);
      },
    }),
    defineTool({
      name: "Edit",
      label: "Edit (claude-code)",
      description: "Edit a file. Executed by the Claude Agent SDK.",
      parameters: editSchema,
      executionMode: "sequential",
      prepareArguments: (args) => (args ?? {}) as any,
      async execute(toolCallId) {
        return executeStub("Edit", toolCallId);
      },
    }),
    defineTool({
      name: "Grep",
      label: "Grep (claude-code)",
      description: "Search file contents. Executed by the Claude Agent SDK.",
      parameters: grepSchema,
      executionMode: "parallel",
      prepareArguments: (args) => (args ?? {}) as any,
      async execute(toolCallId) {
        return executeStub("Grep", toolCallId);
      },
    }),
    defineTool({
      name: "Glob",
      label: "Glob (claude-code)",
      description: "Find files by glob pattern. Executed by the Claude Agent SDK.",
      parameters: globSchema,
      executionMode: "parallel",
      prepareArguments: (args) => (args ?? {}) as any,
      async execute(toolCallId) {
        return executeStub("Glob", toolCallId);
      },
    }),
  ];
}

/**
 * Helper: is a model-emitted tool name something we stub for pi?
 *
 * Used by the event bridge for sanity warnings — if the SDK ever emits a
 * tool_use whose name isn't in this set, pi's loop will fail with
 * `Tool <name> not found`.
 */
export function isSupportedStubTool(name: string): name is SupportedCcToolName {
  return (SUPPORTED_CC_TOOL_NAMES as readonly string[]).includes(name);
}
