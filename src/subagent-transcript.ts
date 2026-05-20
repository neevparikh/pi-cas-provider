/**
 * In-memory store of subagent transcripts collected while a Task tool is
 * running.
 *
 * # Why
 *
 * When the model uses the `Task` tool to delegate, the Agent SDK runs the
 * subagent in-process and emits the subagent's inner conversation events on
 * the same iterator as the main thread, tagged with
 * `parent_tool_use_id != null`.  By default these would be filtered out and
 * the user would only see "Task → final result" with no visibility into the
 * subagent's reasoning, tool calls, or progress.
 *
 * This module captures those events into a structured `SubagentTranscript`
 * keyed by the parent Task tool_use_id, so the Task stub's `renderResult`
 * can show the same kind of nested-transcript UX that pi-subagent shows for
 * its delegated agents (`~/repos/pi-subagent/src/index.ts`).
 *
 * # Lifecycle
 *
 *  1. Bridge sees `system.task_started` with `tool_use_id` X (the Task
 *     tool_use that triggered the subagent) → calls `start(X, meta)`.
 *  2. Bridge sees subagent typed `assistant` event with
 *     `parent_tool_use_id === X` → calls `appendAssistant(X, content,
 *     usage, model)`.
 *  3. Bridge sees subagent typed `user(tool_result)` with
 *     `parent_tool_use_id === X` → calls `appendToolResult(X, block,
 *     toolUseResult)`.
 *  4. Bridge sees `system.task_progress` / `system.task_notification` with
 *     matching `tool_use_id` → calls `appendProgress` / `markFinished`.
 *  5. Bridge ingests the main-thread (parent=null) tool_result for X →
 *     calls `take(X)` to retrieve the finished transcript and attaches it
 *     to the cache entry's `details` (under `_piCasSubagentTranscript`).
 *  6. Pi runs the Task stub.  Stub returns content+details.  Pi's renderer
 *     calls Task stub's `renderResult` which inspects
 *     `_piCasSubagentTranscript` and renders the nested view.
 *
 * # Lifetime
 *
 * Module singleton.  `take()` removes the entry as it's read — same shape
 * as `tool-result-cache.ts` so memory doesn't grow unbounded in long
 * sessions.  If a Task transcript exists but no parent tool_result ever
 * arrives (defensive), nothing forces cleanup; in practice the SDK always
 * emits the parent tool_result on subagent completion, even on error.
 *
 * # Nested subagents
 *
 * A subagent could spawn its own subagent.  The SDK would emit events
 * tagged with the INNER subagent's tool_use_id as `parent_tool_use_id`.
 * For v1 we treat each level as its own flat transcript (keyed by its
 * direct parent tool_use_id).  The outer transcript wouldn't include the
 * nested run; the nested transcript would be attached to ITS Task
 * tool_result, but the outer subagent's tool_result list would reference
 * the nested Task by id.  Rendering a nested tree is Phase B.  For v1, the
 * common case (one-level delegation) renders correctly.
 */

import type {
  AssistantMessage,
  TextContent,
  ImageContent,
  ThinkingContent,
  ToolCall,
} from "@earendil-works/pi-ai";

/**
 * One subagent's conversation captured for rendering.
 *
 * Structurally similar to pi-subagent's `SingleResult` so the renderer can
 * share most of its logic.
 */
export interface SubagentTranscript {
  /** Parent Task tool_use_id this transcript belongs to. */
  parentToolUseId: string;
  /** From `task_started.subagent_type` (e.g. "Explore", "general-purpose"). */
  subagentType?: string;
  /** From `task_started.prompt` (the delegation prompt). */
  taskPrompt?: string;
  /** From `task_started.description` (the human-readable label). */
  description?: string;
  /** SDK task_id (used to match task_progress / task_notification events). */
  taskId?: string;
  /** model id (from the first subagent assistant message that carries it). */
  model?: string;
  /** Captured messages in the order the SDK forwarded them.  Excludes the
   * SDK's `system.task_*` lifecycle messages (those go in
   * `progressEntries`). */
  messages: SubagentMessage[];
  /** Accumulated usage across all subagent assistant turns. */
  usage: SubagentUsage;
  /** Latest `task_progress.summary` if `agentProgressSummaries: true`. */
  progressSummary?: string;
  /** Final status from `task_notification` (`completed`/`failed`/`stopped`).
   * Undefined while in progress. */
  finalStatus?: "completed" | "failed" | "stopped";
  /** From `task_notification.summary` once finished. */
  finalSummary?: string;
  /** Last tool name observed via `task_progress.last_tool_name` for the
   * collapsed "running…" UI. */
  lastToolName?: string;
}

export interface SubagentUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  turns: number;
  /** total_tokens / contextTokens from latest assistant message. */
  contextTokens?: number;
}

/** A message captured from a subagent's stream. */
export type SubagentMessage =
  | {
      role: "assistant";
      content: (TextContent | ThinkingContent | ToolCall)[];
      usage?: AssistantMessage["usage"];
      model?: string;
      stopReason?: AssistantMessage["stopReason"];
    }
  | {
      role: "toolResult";
      toolCallId: string;
      content: (TextContent | ImageContent)[];
      isError: boolean;
      /** SDK's `tool_use_result` structured field (e.g. {stdout, stderr}). */
      details?: unknown;
    };

const transcripts = new Map<string, SubagentTranscript>();

/**
 * Start tracking a transcript for a Task tool_use_id.  Called when
 * `system.task_started` arrives with `tool_use_id` set.  Safe to call
 * before any subagent events have streamed; subsequent appends are
 * idempotent.
 */
export function start(
  parentToolUseId: string,
  meta: {
    subagentType?: string;
    taskPrompt?: string;
    description?: string;
    taskId?: string;
  },
): SubagentTranscript {
  const existing = transcripts.get(parentToolUseId);
  if (existing) {
    // Merge metadata if it arrives after the first append (defensive
    // against event ordering surprises).
    if (meta.subagentType && !existing.subagentType) existing.subagentType = meta.subagentType;
    if (meta.taskPrompt && !existing.taskPrompt) existing.taskPrompt = meta.taskPrompt;
    if (meta.description && !existing.description) existing.description = meta.description;
    if (meta.taskId && !existing.taskId) existing.taskId = meta.taskId;
    return existing;
  }
  const t: SubagentTranscript = {
    parentToolUseId,
    subagentType: meta.subagentType,
    taskPrompt: meta.taskPrompt,
    description: meta.description,
    taskId: meta.taskId,
    messages: [],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, turns: 0 },
  };
  transcripts.set(parentToolUseId, t);
  return t;
}

/**
 * Ensure a transcript exists for `parentToolUseId`.  Used by appenders that
 * may run before `start()` (in case `task_started` is omitted or arrives
 * late).  The caller can backfill metadata later via `start()`.
 */
function ensure(parentToolUseId: string): SubagentTranscript {
  return transcripts.get(parentToolUseId) ?? start(parentToolUseId, {});
}

/**
 * Append a typed subagent `assistant` event's content blocks.  Maps the
 * Anthropic content shape into pi's `AssistantMessage["content"]` shape so
 * the renderer can iterate without further translation.
 */
export function appendAssistant(
  parentToolUseId: string,
  betaContent: any[],
  usage: AssistantMessage["usage"] | undefined,
  model: string | undefined,
  stopReason: AssistantMessage["stopReason"] | undefined,
): void {
  const t = ensure(parentToolUseId);
  const piContent: (TextContent | ThinkingContent | ToolCall)[] = [];
  for (const b of betaContent ?? []) {
    if (!b || typeof b !== "object") continue;
    if (b.type === "text") {
      piContent.push({ type: "text", text: b.text ?? "" } as TextContent);
    } else if (b.type === "thinking") {
      piContent.push({
        type: "thinking",
        thinking: b.thinking ?? "",
        thinkingSignature: b.signature ?? "",
      } as ThinkingContent);
    } else if (b.type === "tool_use") {
      piContent.push({
        type: "toolCall",
        id: b.id,
        name: b.name,
        arguments: (b.input ?? {}) as Record<string, unknown>,
      } as ToolCall);
    }
  }
  if (piContent.length === 0 && (usage === undefined || usage === null)) {
    // Nothing renderable + no usage — skip.
    return;
  }
  t.messages.push({
    role: "assistant",
    content: piContent,
    usage,
    model,
    stopReason,
  });
  if (model && !t.model) t.model = model;
  if (usage) {
    t.usage.turns++;
    t.usage.input += usage.input ?? 0;
    t.usage.output += usage.output ?? 0;
    t.usage.cacheRead += usage.cacheRead ?? 0;
    t.usage.cacheWrite += usage.cacheWrite ?? 0;
    t.usage.total += usage.cost?.total ?? 0;
    if (typeof usage.totalTokens === "number") t.usage.contextTokens = usage.totalTokens;
  }
}

/**
 * Append a tool_result block from a typed subagent `user` event.
 */
export function appendToolResult(
  parentToolUseId: string,
  block: any,
  sdkToolUseResult?: unknown,
): void {
  if (!block || block.type !== "tool_result" || typeof block.tool_use_id !== "string") return;
  const t = ensure(parentToolUseId);
  const content = normalizeToolResultContent(block.content);
  t.messages.push({
    role: "toolResult",
    toolCallId: block.tool_use_id,
    content,
    isError: block.is_error === true,
    details: sdkToolUseResult,
  });
}

/**
 * Record a `task_progress` event's summary / last_tool_name for the
 * collapsed UI ("running… last tool: Bash").
 */
export function recordProgress(
  parentToolUseId: string,
  fields: { summary?: string; lastToolName?: string; subagentType?: string },
): void {
  const t = ensure(parentToolUseId);
  if (fields.summary) t.progressSummary = fields.summary;
  if (fields.lastToolName) t.lastToolName = fields.lastToolName;
  if (fields.subagentType && !t.subagentType) t.subagentType = fields.subagentType;
}

/**
 * Record a `task_notification` event marking the subagent's final status.
 */
export function markFinished(
  parentToolUseId: string,
  fields: { status: "completed" | "failed" | "stopped"; summary?: string },
): void {
  const t = ensure(parentToolUseId);
  t.finalStatus = fields.status;
  if (fields.summary) t.finalSummary = fields.summary;
}

/**
 * Retrieve and remove the transcript.  Called by the bridge when the
 * parent Task tool_result arrives and is being ingested into the result
 * cache.
 */
export function take(parentToolUseId: string): SubagentTranscript | undefined {
  const t = transcripts.get(parentToolUseId);
  if (t !== undefined) transcripts.delete(parentToolUseId);
  return t;
}

/** Peek without consuming.  Used by tests / diagnostics. */
export function peek(parentToolUseId: string): SubagentTranscript | undefined {
  return transcripts.get(parentToolUseId);
}

/** Drop all transcripts.  For tests. */
export function clear(): void {
  transcripts.clear();
}

/** Current count of in-flight transcripts (diagnostics). */
export function size(): number {
  return transcripts.size;
}

/** Normalize a tool_result content field into pi-compatible content blocks.
 * Mirrors the helper in event-bridge.ts; duplicated here to avoid a
 * cross-module circular import. */
function normalizeToolResultContent(c: unknown): (TextContent | ImageContent)[] {
  if (typeof c === "string") {
    return [{ type: "text", text: c } as TextContent];
  }
  if (Array.isArray(c)) {
    const blocks: (TextContent | ImageContent)[] = [];
    for (const item of c) {
      if (!item || typeof item !== "object") continue;
      if (item.type === "text") {
        blocks.push({ type: "text", text: item.text ?? "" } as TextContent);
      } else if (item.type === "image") {
        const src = (item as any).source ?? {};
        blocks.push({
          type: "image",
          data: src.data ?? "",
          mimeType: src.media_type ?? "image/png",
        } as ImageContent);
      }
    }
    return blocks;
  }
  return [{ type: "text", text: typeof c === "undefined" ? "" : JSON.stringify(c) } as TextContent];
}
