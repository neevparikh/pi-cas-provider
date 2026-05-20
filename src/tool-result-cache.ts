/**
 * In-memory cache of tool results emitted by the Agent SDK during a session.
 *
 * # Why
 *
 * In the stream-aligned-segmentation architecture, the SDK runs every tool
 * natively inside its own `query()`.  We capture each `user(tool_result)`
 * SDKUserMessage and stash the result here, keyed by `tool_use_id`.
 *
 * Pi's stub tools (see `stub-tools.ts`) then look up the cached result when
 * pi's agent loop "executes" them.  Pi never actually runs the tool — it
 * just retrieves what the SDK already produced.
 *
 * # Lifetime
 *
 * One global cache (module singleton) shared across all pi sessions.
 * `tool_use_id`s are model-generated and effectively unique, so cross-session
 * collisions are not a concern.  The cache is one-shot: `take()` removes the
 * entry as it's read, so memory doesn't grow unbounded over a long session.
 *
 * # Race window
 *
 * The provider's consume loop holds the segment open until every paired
 * `tool_result` has been ingested into the cache (see `event-bridge.ts`),
 * so by the time pi's stub tool calls `take()` the entry is guaranteed to
 * be present.  If for any reason it isn't (defensive case), the stub
 * returns an error tool result rather than blocking.
 */

import type { TextContent, ImageContent } from "@earendil-works/pi-ai";

/**
 * What we cache per tool_use_id, derived from the SDK's `user(tool_result)`
 * + `tool_use_result` fields.
 */
export interface CachedToolResult {
  /** Model-facing content (text and/or images) — the `content` field of the
   * SDK's `tool_result` content block. */
  content: (TextContent | ImageContent)[];
  /** Did the SDK report this tool call as an error?  Mirrors the `is_error`
   * flag on the SDK's tool_result content block. */
  isError: boolean;
  /** Original tool name from the SDK's `tool_use` block (e.g. `"Bash"`).
   * Stored so pi's stub can include it in its return for nicer display. */
  toolName: string;
  /** Structured details from `SDKUserMessage.tool_use_result` (e.g.
   * `{stdout, stderr, interrupted, isImage, noOutputExpected}` for Bash).
   * Passed through to pi's `AgentToolResult.details`. */
  details: unknown;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
const cache: Map<string, CachedToolResult> = new Map();

/** Insert a freshly-captured tool result. */
export function put(toolUseId: string, entry: CachedToolResult): void {
  cache.set(toolUseId, entry);
}

/** Remove and return the cached result, or undefined if not present.
 *
 * One-shot semantics: the entry is deleted on read.  Pi's agent loop should
 * execute each tool call exactly once. */
export function take(toolUseId: string): CachedToolResult | undefined {
  const entry = cache.get(toolUseId);
  if (entry !== undefined) cache.delete(toolUseId);
  return entry;
}

/** Peek without consuming. */
export function has(toolUseId: string): boolean {
  return cache.has(toolUseId);
}

/** Drop all entries — for tests and explicit reset. */
export function clear(): void {
  cache.clear();
}

/** Current size — for diagnostics / debug logging. */
export function size(): number {
  return cache.size;
}
