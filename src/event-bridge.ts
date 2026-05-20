/**
 * Stream-aligned segmenting event bridge.
 *
 * Translates the Agent SDK's message stream into pi's AssistantMessageEvent
 * stream, ONE SEGMENT AT A TIME.  A "segment" is one Anthropic assistant
 * message — text + thinking + tool_use blocks emitted between an SDK
 * `message_start` and `message_stop`, plus the matching tool_result(s)
 * the SDK produces by running the tool internally.
 *
 * # Why segment per assistant message instead of per SDK turn
 *
 * The SDK's `query()` runs a multi-message turn internally: assistant
 * (text+tool_use) → SDK runs the tool → assistant (more text+maybe more
 * tools) → ... → assistant (end_turn).  The previous "Option A" bridge
 * accumulated ALL assistant content into one pi `done`, which made pi's
 * agent loop see (and try to execute) toolCall content blocks the SDK
 * had already run.
 *
 * Stream-aligned segmentation gives pi ONE assistant message per pi
 * `streamSimple` call.  Pi sees a normal text+toolCalls assistant message,
 * runs the stub tools (`stub-tools.ts`) which look up cached SDK
 * results, then loops streamSimple for the next segment.  See
 * provider.ts for how multi-segment turns are driven by pi's loop.
 *
 * # Boundary contract
 *
 * A segment is "closed" (ready to push pi `done`) when BOTH:
 *   1. We've seen `message_stop` for the current Anthropic assistant message
 *   2. For every `tool_use` block in this segment, we've ingested the
 *      matching `user(tool_result)` SDKUserMessage (cached + tracked).
 *
 * The two e2e probes (probe-stub-tools.mjs, probe-stub-tools-edge.mjs)
 * confirm `tool_result` events always arrive AFTER `message_stop` and
 * BEFORE the next `message_start`.  So we hold the segment open across
 * the (~200ms typical) gap.
 *
 * # State
 *
 * The bridge is stateful across multiple streamSimple calls within one
 * pi session.  Per-segment state is reset on each new `message_start`;
 * cross-segment state (sdkSessionId, fast_mode_state, accumulated
 * cost/usage) persists.
 */

import type {
  AssistantMessage,
  AssistantMessageEventStream,
  ImageContent,
  Model,
  TextContent,
  ThinkingContent,
  ToolCall,
} from "@earendil-works/pi-ai";
import { calculateCost } from "@earendil-works/pi-ai";

import { PROVIDER_ID } from "./config.js";
import { put as cacheToolResult, type CachedToolResult } from "./tool-result-cache.js";
import { isSupportedStubTool } from "./stub-tools.js";
import {
  appendAssistant as transcriptAppendAssistant,
  appendToolResult as transcriptAppendToolResult,
  markFinished as transcriptMarkFinished,
  recordProgress as transcriptRecordProgress,
  start as transcriptStart,
  take as transcriptTake,
} from "./subagent-transcript.js";

const DEBUG = process.env.PI_CAS_DEBUG === "1";

/** Tracked content block within the current segment. */
interface Tracked {
  /** Anthropic content_block index — resets per Anthropic assistant message. */
  index: number;
  /** Index in `output.content` (pi's view). */
  piIndex: number;
  kind: "text" | "thinking" | "tool_use";
  /** Accumulator for input_json_delta on tool_use blocks. */
  partialJson?: string;
  /** Original CC tool name for tool_use blocks. */
  toolName?: string;
}

/** Stop reason mapped to pi's vocabulary. */
type PiStopReason = AssistantMessage["stopReason"];

export interface EventBridge {
  /** Bind a new pi event stream for the next segment.  Called by provider
   * at the start of each streamSimple call.
   *
   * `model` is the model selected for THIS segment.  Pi sessions can switch
   * model mid-conversation (via the model picker / setModel control); the
   * bridge needs the current model for accurate `output.model` recording
   * and cost calculation. */
  attachStream(stream: AssistantMessageEventStream, model: Model<any>): void;

  /** Feed one SDK message. */
  handle(msg: any): void;

  /** True once message_stop has been observed for the current segment AND
   * every pending tool_result has been ingested. */
  isSegmentReady(): boolean;

  /** True once the SDK emits its `result` for the whole turn. */
  isTurnDone(): boolean;

  /** Rearm for a fresh SDK turn.  Provider calls this after draining the
   * turn-end `result` event off the iterator, so the next streamSimple's
   * consume loop doesn't see stale `turnDone=true`. */
  resetTurn(): void;

  /** Captured error message from a turn-level `result` with `is_error: true`
   * (auth failure, rate limit, etc.).  Undefined if the turn ended normally. */
  getTurnError(): string | undefined;

  /** True if the bridge has accumulated any per-segment state (a `start`
   * has been pushed to the pi stream and/or content blocks have started
   * arriving).  Used to decide whether to emit partial content alongside
   * an error or just push an error event. */
  hasPartialContent(): boolean;

  /** Return a copy of the in-progress segment's AssistantMessage (text,
   * thinking, partial tool_use blocks that have been streamed so far).
   * Used by the provider on the error path so partial content is
   * preserved instead of being discarded.  After calling this, the
   * provider should still close the stream (via `closeStreamWithError`
   * or directly) and `resetTurn` to rearm. */
  getPartialOutput(): AssistantMessage;

  /** Push an `error` event carrying the bridge's accumulated partial
   * content (if any) plus the supplied error message; ends the pi stream
   * and resets per-segment state.  Use this on the error path when the
   * SDK turn aborted mid-message; otherwise pi loses the partial text
   * the user already started seeing on screen. */
  closeStreamWithError(message: string): void;

  /** Get the pi-flavored stop reason for the current segment. */
  getSegmentStopReason(): PiStopReason;

  /** Get the tool_use_ids emitted in the segment now being closed.  Used by
   * the provider to set up phantom-toolResult detection for the next
   * streamSimple. */
  getCurrentSegmentToolUseIds(): string[];

  /** Push pi's terminal `done` event for the current segment, close the pi
   * stream, and reset per-segment state.  Returns the segment's
   * accumulated AssistantMessage (for the provider to inspect or persist). */
  closeSegment(): AssistantMessage;

  /** Session-scoped: sdk_session_id captured from `system.init`. */
  getSdkSessionId(): string | undefined;

  /** Session-scoped: latest fast_mode_state from a result message. */
  getFastModeState(): "off" | "cooldown" | "on" | undefined;

  /** Session-scoped: total cost across this turn (and beyond — accumulating). */
  getCost(): number | undefined;
}

/**
 * Per-bridge options.  All optional.
 */
export interface EventBridgeOptions {
  /**
   * Called the FIRST time the bridge observes a `tool_use` block whose name
   * isn't in {@link SUPPORTED_CC_TOOL_NAMES}.
   *
   * The provider uses this to register a catch-all stub via
   * `pi.registerTool` before pi's agent loop tries to execute the unknown
   * tool (which would otherwise crash with `Tool <name> not found`).  The
   * bridge fires this callback at `content_block_start` time — well before
   * the segment closes — so pi sees the stub by the time it processes the
   * `done` event.
   *
   * The callback should be idempotent (the bridge does NOT dedupe across
   * invocations within or across sessions).  The provider is expected to
   * track a "registered" set itself.
   *
   * The callback should not throw; the bridge does not handle errors here
   * and a throw would abort the entire SDK message processing for the
   * segment.
   */
  onUnknownToolName?: (toolName: string) => void;
}

export function createEventBridge(
  initialModel: Model<any>,
  options: EventBridgeOptions = {},
): EventBridge {
  // Current model for this segment.  Updated on `attachStream` so a
  // mid-session model switch is reflected in both the recorded
  // `output.model` and `calculateCost()` per-token rates.
  let currentModel: Model<any> = initialModel;

  // Cross-segment / cross-turn state.
  let sdkSessionId: string | undefined;
  let fastModeState: "off" | "cooldown" | "on" | undefined;
  let cost: number | undefined;
  let turnError: string | undefined;

  // Per-segment state — reset on each new Anthropic message_start.
  let stream: AssistantMessageEventStream | undefined;
  let output: AssistantMessage = freshOutput(currentModel);
  let blocks: Tracked[] = [];
  let pendingToolUseIds = new Set<string>();
  let segmentToolUseIds: string[] = [];
  let sawMessageStop = false;
  let sawAnyContentForSegment = false;
  let segmentStarted = false;
  let turnDone = false;
  let rawStopReason: string | undefined;

  function resetSegment(): void {
    output = freshOutput(currentModel);
    blocks = [];
    pendingToolUseIds = new Set();
    segmentToolUseIds = [];
    sawMessageStop = false;
    sawAnyContentForSegment = false;
    segmentStarted = false;
    rawStopReason = undefined;
  }

  function ensureStreamStarted(): void {
    if (!stream) return;
    if (segmentStarted) return;
    segmentStarted = true;
    stream.push({ type: "start", partial: output });
  }

  function handle(msg: any): void {
    // sdk_session_id (only on the very first init of the long-lived query).
    if (msg.type === "system" && msg.subtype === "init") {
      sdkSessionId = msg.session_id ?? sdkSessionId;
      return;
    }

    // **Subagent handling — typed-message path.**
    //
    // When a Task (subagent) is in flight, the SDK emits the subagent's
    // assistant/user/tool_progress messages on the same iterator as the
    // main thread, tagged with `parent_tool_use_id != null`.  We must
    // keep these OUT of pi's view of the main-thread segment (they'd
    // appear as extra tool_call blocks pi tries to execute, and their
    // nested tool_results would corrupt our pendingToolUseIds pairing).
    //
    // BUT we don't just drop them — we capture them into a per-Task-id
    // `SubagentTranscript` (see `src/subagent-transcript.ts`).  When the
    // parent Task tool_result eventually arrives (parent_tool_use_id=null),
    // the bridge attaches the collected transcript to the cache entry's
    // `details` under `_piCasSubagentTranscript`.  Pi's Task stub
    // (`src/task-stub.ts`) reads this in its `renderResult` and renders
    // the nested transcript (reasoning, tool calls, final output) the
    // same way pi-subagent's renderer does.
    //
    // This relies on the SDK forwarding subagent text/thinking — which
    // requires `forwardSubagentText: true` in SDK options.  Without it,
    // only subagent tool_use/tool_result blocks are forwarded, and the
    // rendered transcript only shows the tool calls.  See provider.ts
    // ensureSession() where the option is set.
    if (msg.parent_tool_use_id != null) {
      const parentId = String(msg.parent_tool_use_id);
      if (DEBUG) {
        console.error(
          `[pi-cas/debug] capturing subagent event: type=${msg.type} ` +
            `parent_tool_use_id=${parentId.slice(-8)} ` +
            (msg.subagent_type ? `subagent_type=${msg.subagent_type} ` : ""),
        );
      }
      // Defensive recovery: if the SDK leaked subagent tool_use blocks
      // into the main segment via SSE partials (we couldn't tell at that
      // point — SSE wraps the inner BetaMessage which doesn't carry
      // parent_tool_use_id), now that we have the typed assistant message
      // confirming "those were subagent tool_uses", remove them from
      // pendingToolUseIds so the main segment can still close.
      if (msg.type === "assistant") {
        const content = msg.message?.content;
        if (Array.isArray(content)) {
          cleanupLeakedSubagentToolUses(content);
          transcriptAppendAssistant(
            parentId,
            content,
            msg.message?.usage,
            msg.message?.model,
            msg.message?.stop_reason,
          );
        }
      } else if (msg.type === "user") {
        const content = msg.message?.content;
        if (Array.isArray(content)) {
          let first = true;
          for (const block of content) {
            if (block?.type === "tool_result") {
              transcriptAppendToolResult(
                parentId,
                block,
                first ? msg.tool_use_result : undefined,
              );
              first = false;
            }
          }
        }
      }
      // tool_progress messages tagged with parent_tool_use_id: don't
      // append to transcript (already encapsulated in tool_use_result
      // when ingested above) — just drop.
      return;
    }

    // Task lifecycle / progress system messages.  We use these to populate
    // subagent transcript metadata (subagent_type, task description,
    // running summary, final status) so the Task stub's renderResult can
    // display the same kind of UI pi-subagent shows for its delegated
    // agents.  They are NOT surfaced to pi's main message stream.
    if (msg.type === "system" && typeof msg.subtype === "string") {
      const sub = msg.subtype as string;
      const toolUseId: string | undefined =
        typeof msg.tool_use_id === "string" ? msg.tool_use_id : undefined;
      if (sub === "task_started" && toolUseId) {
        transcriptStart(toolUseId, {
          subagentType: typeof msg.subagent_type === "string" ? msg.subagent_type : undefined,
          taskPrompt: typeof msg.prompt === "string" ? msg.prompt : undefined,
          description: typeof msg.description === "string" ? msg.description : undefined,
          taskId: typeof msg.task_id === "string" ? msg.task_id : undefined,
        });
        if (DEBUG) {
          console.error(
            `[pi-cas/debug] task_started tu=${toolUseId.slice(-8)} ` +
              `subagent_type=${msg.subagent_type ?? "?"}`,
          );
        }
        return;
      }
      if (sub === "task_progress" && toolUseId) {
        transcriptRecordProgress(toolUseId, {
          summary: typeof msg.summary === "string" ? msg.summary : undefined,
          lastToolName: typeof msg.last_tool_name === "string" ? msg.last_tool_name : undefined,
          subagentType:
            typeof msg.subagent_type === "string" ? msg.subagent_type : undefined,
        });
        return;
      }
      if (sub === "task_notification" && toolUseId) {
        const status = msg.status;
        if (status === "completed" || status === "failed" || status === "stopped") {
          transcriptMarkFinished(toolUseId, {
            status,
            summary: typeof msg.summary === "string" ? msg.summary : undefined,
          });
        }
        return;
      }
      if (sub === "task_updated") {
        // Status patches; we already track the final status via
        // task_notification.  Drop with debug log.
        if (DEBUG) {
          console.error(
            `[pi-cas/debug] task_updated task_id=${String(msg.task_id ?? "?").slice(-8)}`,
          );
        }
        return;
      }
    }

    // `tool_progress` system events fire periodically for in-flight tools
    // (including main-thread tools).  We don't currently surface them.
    // The main-thread case (`parent_tool_use_id === null`) passes through
    // the earlier filter — explicitly drop here.
    if (msg.type === "tool_progress") {
      return;
    }

    // The SDK emits typed assistant message events as `type: "assistant"` AFTER
    // the streaming `stream_event` partials.  We rely on partials for most
    // accumulation; the `assistant` event is a no-op here except for the
    // diagnostic case where partials were absent.  See appendFinalBlock().
    if (msg.type === "assistant") {
      // If we somehow received no stream events for this message, fall back
      // to materializing content from the final message.  (Not expected with
      // `includePartialMessages: true`.)
      ensureStreamStarted();
      const bm = msg.message;
      if (bm?.usage) updateUsage(bm.usage);
      // Only fallback-materialize if there are no tracked content blocks yet.
      if (output.content.length === 0 && Array.isArray(bm?.content)) {
        for (const b of bm.content) appendFinalBlock(b);
      }
      return;
    }

    // SDK reports each tool's result back via a `user` SDKUserMessage whose
    // content array contains tool_result blocks.  Cache them keyed by
    // tool_use_id; clear the pending set entry.
    //
    // SDKUserMessage.tool_use_result is singular (one structured detail per
    // SDKUserMessage) and the SDK in practice sends one tool_result content
    // block per message.  We assert that pairing here: tool_use_result is
    // only attached to the FIRST tool_result block.  Subsequent blocks (if
    // any — not observed in current SDK behavior) get undefined details to
    // avoid silently cross-attributing structured details from tool A to
    // tool B.
    if (msg.type === "user") {
      const c = msg.message?.content;
      if (Array.isArray(c)) {
        let first = true;
        for (const block of c) {
          if (block.type === "tool_result") {
            ingestToolResult(block, first ? msg.tool_use_result : undefined);
            first = false;
          }
        }
      }
      return;
    }

    // SDK partial events — Anthropic SSE-shaped.
    if (msg.type === "stream_event" || msg.type === "partial_assistant") {
      const event = msg.event ?? msg;
      handleSseEvent(event);
      return;
    }

    if (msg.type === "result") {
      if (typeof msg.total_cost_usd === "number") cost = msg.total_cost_usd;
      if (msg.fast_mode_state) fastModeState = msg.fast_mode_state;
      if (msg.usage) updateUsage(msg.usage);
      turnDone = true;
      if (msg.is_error === true) {
        // SDK signaled a turn-level error (auth failure, rate limit, server
        // 5xx, etc.).  Capture a human-readable message so the provider can
        // surface it instead of pushing an empty successful done.
        const subtype = typeof msg.subtype === "string" ? msg.subtype : "error";
        const inner =
          typeof msg.result === "string"
            ? msg.result
            : typeof msg.error === "string"
              ? msg.error
              : typeof msg.error?.message === "string"
                ? msg.error.message
                : JSON.stringify(msg.result ?? msg.error ?? {}).slice(0, 500);
        turnError = `[${subtype}] ${inner}`.trim();
      }
      return;
    }
  }

  function handleSseEvent(event: any): void {
    switch (event.type) {
      case "message_start": {
        // Boundary: a new Anthropic assistant message begins.  If we were
        // mid-segment (which means provider hasn't called closeSegment yet)
        // this is a bug — but defensive: reset.
        if (sawMessageStop || sawAnyContentForSegment) {
          if (DEBUG) {
            console.error(
              "[pi-cas/debug] message_start mid-segment — provider should have " +
                "closed the previous segment first",
            );
          }
          resetSegment();
        }
        ensureStreamStarted();
        sawAnyContentForSegment = true;
        if (event.message?.usage) updateUsage(event.message.usage);
        // Tracked-block indices reset per message — already cleared by
        // resetSegment / fresh segment.
        return;
      }

      case "content_block_start": {
        sawAnyContentForSegment = true;
        ensureStreamStarted();
        const cb = event.content_block;
        const ccIdx = event.index ?? 0;
        if (cb.type === "text") {
          const piIndex = output.content.length;
          output.content.push({ type: "text", text: "" } as TextContent);
          blocks.push({ index: ccIdx, piIndex, kind: "text" });
          stream?.push({ type: "text_start", contentIndex: piIndex, partial: output });
        } else if (cb.type === "thinking") {
          const piIndex = output.content.length;
          output.content.push({
            type: "thinking",
            thinking: "",
            thinkingSignature: "",
          } as ThinkingContent);
          blocks.push({ index: ccIdx, piIndex, kind: "thinking" });
          stream?.push({ type: "thinking_start", contentIndex: piIndex, partial: output });
        } else if (cb.type === "tool_use") {
          const piIndex = output.content.length;
          if (!isSupportedStubTool(cb.name)) {
            // Notify the provider so it can register a catch-all stub before
            // pi's loop tries to execute this tool.  See EventBridgeOptions
            // docstring.  Bridge does no deduping; provider is responsible.
            if (options.onUnknownToolName) {
              try {
                options.onUnknownToolName(cb.name);
              } catch (err) {
                // Defensive: a throw here would corrupt the segment, so log
                // and continue.  pi may still crash at execute time, but
                // logging gives operators a fighting chance to diagnose.
                console.error(
                  `[pi-cas] onUnknownToolName callback threw for "${cb.name}": ${
                    err instanceof Error ? err.message : String(err)
                  }`,
                );
              }
            }
            if (DEBUG) {
              console.error(
                `[pi-cas/debug] SDK emitted unsupported tool_use name "${cb.name}". ` +
                  `Falling back to dynamic catch-all stub.`,
              );
            }
          }
          output.content.push({
            type: "toolCall",
            id: cb.id,
            name: cb.name,
            arguments: {},
          } as ToolCall);
          blocks.push({
            index: ccIdx,
            piIndex,
            kind: "tool_use",
            partialJson: "",
            toolName: cb.name,
          });
          pendingToolUseIds.add(cb.id);
          segmentToolUseIds.push(cb.id);
          stream?.push({ type: "toolcall_start", contentIndex: piIndex, partial: output });
        }
        return;
      }

      case "content_block_delta": {
        const tracked = blocks.find((b) => b.index === event.index);
        if (!tracked) return;
        const d = event.delta;
        if (d.type === "text_delta" && tracked.kind === "text") {
          const block = output.content[tracked.piIndex] as TextContent;
          block.text += d.text ?? "";
          stream?.push({
            type: "text_delta",
            contentIndex: tracked.piIndex,
            delta: d.text ?? "",
            partial: output,
          });
        } else if (d.type === "thinking_delta" && tracked.kind === "thinking") {
          const block = output.content[tracked.piIndex] as ThinkingContent;
          block.thinking += d.thinking ?? "";
          stream?.push({
            type: "thinking_delta",
            contentIndex: tracked.piIndex,
            delta: d.thinking ?? "",
            partial: output,
          });
        } else if (d.type === "signature_delta" && tracked.kind === "thinking") {
          const block = output.content[tracked.piIndex] as ThinkingContent;
          block.thinkingSignature = (block.thinkingSignature ?? "") + (d.signature ?? "");
        } else if (d.type === "input_json_delta" && tracked.kind === "tool_use") {
          tracked.partialJson = (tracked.partialJson ?? "") + (d.partial_json ?? "");
          try {
            const parsed = JSON.parse(tracked.partialJson);
            (output.content[tracked.piIndex] as ToolCall).arguments = parsed;
          } catch {
            /* incomplete json — wait for more deltas */
          }
          stream?.push({
            type: "toolcall_delta",
            contentIndex: tracked.piIndex,
            delta: d.partial_json ?? "",
            partial: output,
          });
        }
        return;
      }

      case "content_block_stop": {
        const tracked = blocks.find((b) => b.index === event.index);
        if (!tracked) return;
        if (tracked.kind === "text") {
          const block = output.content[tracked.piIndex] as TextContent;
          stream?.push({
            type: "text_end",
            contentIndex: tracked.piIndex,
            content: block.text,
            partial: output,
          });
        } else if (tracked.kind === "thinking") {
          const block = output.content[tracked.piIndex] as ThinkingContent;
          stream?.push({
            type: "thinking_end",
            contentIndex: tracked.piIndex,
            content: block.thinking,
            partial: output,
          });
        } else if (tracked.kind === "tool_use") {
          let parsedArgs: Record<string, unknown> = {};
          try {
            parsedArgs = JSON.parse(tracked.partialJson ?? "");
          } catch {
            /* fall through with empty args */
          }
          (output.content[tracked.piIndex] as ToolCall).arguments = parsedArgs;
          stream?.push({
            type: "toolcall_end",
            contentIndex: tracked.piIndex,
            toolCall: output.content[tracked.piIndex] as ToolCall,
            partial: output,
          });
        }
        return;
      }

      case "message_delta": {
        if (event.delta?.stop_reason) {
          rawStopReason = event.delta.stop_reason;
        }
        if (event.usage) updateUsage(event.usage);
        return;
      }

      case "message_stop": {
        sawMessageStop = true;
        return;
      }
    }
  }

  /**
   * Defensive recovery for the case where the SDK emitted subagent SSE
   * `stream_event` partials that we couldn't filter at the time (the
   * stream-event wrapper doesn't carry `parent_tool_use_id`).  When the
   * subsequent typed `assistant` event arrives and tells us those blocks
   * were subagent-internal, walk its tool_use ids and:
   *
   *  1. Remove them from `pendingToolUseIds` (otherwise the segment never
   *     closes — we'll never get a matching parent=null tool_result for a
   *     subagent-internal tool).
   *  2. Remove them from `segmentToolUseIds` (so they don't show up in the
   *     "phantom-detection" set for the next streamSimple).
   *  3. Remove the corresponding `output.content` entries so pi doesn't
   *     see ghost tool_call blocks.
   *
   * If the SDK never leaks subagent partials (the expected case with
   * `forwardSubagentText: false` / unset), this function is a no-op
   * because none of the listed ids will be in our tracking maps.
   */
  function cleanupLeakedSubagentToolUses(subagentContent: any[]): void {
    const subagentIds = new Set<string>();
    for (const b of subagentContent) {
      if (b?.type === "tool_use" && typeof b.id === "string") {
        subagentIds.add(b.id);
      }
    }
    if (subagentIds.size === 0) return;
    let cleaned = 0;
    for (const id of subagentIds) {
      if (pendingToolUseIds.delete(id)) cleaned++;
    }
    segmentToolUseIds = segmentToolUseIds.filter((id) => !subagentIds.has(id));
    // Walk blocks/output and drop matching tool_use entries.  Index in
    // output.content is `piIndex`; remove from both blocks[] tracking
    // and output.content.  Iterate in reverse so splices don't disturb
    // earlier indices.
    for (let i = blocks.length - 1; i >= 0; i--) {
      const tracked = blocks[i];
      if (
        tracked.kind === "tool_use" &&
        subagentIds.has((output.content[tracked.piIndex] as ToolCall).id)
      ) {
        const piIndex = tracked.piIndex;
        output.content.splice(piIndex, 1);
        blocks.splice(i, 1);
        // Shift remaining piIndex references that pointed AFTER the
        // removed slot.
        for (const other of blocks) {
          if (other.piIndex > piIndex) other.piIndex -= 1;
        }
      }
    }
    if (cleaned > 0 && DEBUG) {
      console.error(
        `[pi-cas/debug] cleaned up ${cleaned} leaked subagent tool_use(s) ` +
          `from pending set: ${[...subagentIds].map((id) => id.slice(-8)).join(",")}`,
      );
    }
  }

  function ingestToolResult(block: any, sdkToolUseResult: unknown): void {
    const id: string = block.tool_use_id;
    if (!id) return;
    const isError = block.is_error === true;
    const content = normalizeToolResultContent(block.content);
    // Resolve the tool name: we need it for pi's display.  Look it up from
    // tracked blocks in the current segment.
    const tracked = blocks.find((b) => b.kind === "tool_use" && id === (output.content[b.piIndex] as ToolCall).id);
    const toolName = tracked?.toolName ?? "Unknown";

    // If this tool_result is for a Task tool that ran a subagent, attach
    // the collected subagent transcript to the cache entry's `details`
    // (under `_piCasSubagentTranscript`).  The Task stub's renderResult
    // reads it and renders the nested transcript.  Take semantics free
    // the in-memory entry so it doesn't accumulate across long sessions.
    const subagentTranscript = transcriptTake(id);
    let details: unknown = sdkToolUseResult;
    if (subagentTranscript) {
      // Merge: preserve SDK's `tool_use_result` shape (object | string |
      // undefined) under a sibling key when it's not plain-object-shaped,
      // or splat it when it is.  The Task stub looks up
      // `_piCasSubagentTranscript` regardless of the surrounding shape.
      const sdkIsPlainObject =
        sdkToolUseResult !== null &&
        typeof sdkToolUseResult === "object" &&
        !Array.isArray(sdkToolUseResult);
      if (sdkIsPlainObject) {
        details = {
          ...(sdkToolUseResult as Record<string, unknown>),
          _piCasSubagentTranscript: subagentTranscript,
        };
      } else {
        details = {
          _piCasSubagentTranscript: subagentTranscript,
          ...(sdkToolUseResult !== undefined
            ? { _piCasToolUseResult: sdkToolUseResult }
            : {}),
        };
      }
      if (DEBUG) {
        console.error(
          `[pi-cas/debug] attached subagent transcript to ${toolName} ` +
            `tool_result (tu=${id.slice(-8)}, ${subagentTranscript.messages.length} msgs, ` +
            `status=${subagentTranscript.finalStatus ?? "?"})`,
        );
      }
    }

    const entry: CachedToolResult = {
      content,
      isError,
      toolName,
      details,
    };
    cacheToolResult(id, entry);
    pendingToolUseIds.delete(id);
  }

  function updateUsage(u: any): void {
    if (typeof u.input_tokens === "number") output.usage.input = u.input_tokens;
    if (typeof u.output_tokens === "number") output.usage.output = u.output_tokens;
    if (typeof u.cache_read_input_tokens === "number")
      output.usage.cacheRead = u.cache_read_input_tokens;
    if (typeof u.cache_creation_input_tokens === "number")
      output.usage.cacheWrite = u.cache_creation_input_tokens;
    output.usage.totalTokens =
      output.usage.input +
      output.usage.output +
      output.usage.cacheRead +
      output.usage.cacheWrite;
    calculateCost(currentModel, output.usage);
  }

  function appendFinalBlock(b: any): void {
    if (b.type === "text") {
      output.content.push({ type: "text", text: b.text ?? "" } as TextContent);
    } else if (b.type === "thinking") {
      output.content.push({
        type: "thinking",
        thinking: b.thinking ?? "",
        thinkingSignature: b.signature ?? "",
      } as ThinkingContent);
    } else if (b.type === "tool_use") {
      // Mirror the partial-event path: notify the provider so it can
      // register a catch-all stub for unknown names before pi tries to
      // execute the tool.  This branch is the diagnostic fallback for
      // SDK messages that arrived without streaming partials.
      if (!isSupportedStubTool(b.name) && options.onUnknownToolName) {
        try {
          options.onUnknownToolName(b.name);
        } catch (err) {
          console.error(
            `[pi-cas] onUnknownToolName callback threw for "${b.name}": ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }
      output.content.push({
        type: "toolCall",
        id: b.id,
        name: b.name,
        arguments: (b.input ?? {}) as Record<string, unknown>,
      } as ToolCall);
      pendingToolUseIds.add(b.id);
      segmentToolUseIds.push(b.id);
    }
  }

  function mapStopReason(raw: string | undefined): PiStopReason {
    switch (raw) {
      case "tool_use":
        return "toolUse";
      case "max_tokens":
        return "length";
      case "end_turn":
      default:
        return "stop";
    }
  }

  function isSegmentReady(): boolean {
    // Segment is ready when message_stop is observed AND every tool_use
    // emitted in this segment has its tool_result ingested.
    if (!sawMessageStop) return false;
    if (pendingToolUseIds.size > 0) return false;
    return true;
  }

  function closeSegment(): AssistantMessage {
    if (DEBUG) {
      console.error(
        `[pi-cas/debug] closing segment: ` +
          `content=${output.content.length} blocks, ` +
          `toolUseIds=${segmentToolUseIds.length}, ` +
          `stopReason=${rawStopReason}, sawMessageStop=${sawMessageStop}`,
      );
    }
    const stopReason = mapStopReason(rawStopReason);
    output.stopReason = stopReason;
    if (stream) {
      ensureStreamStarted();
      stream.push({ type: "done", reason: stopReason, message: output } as any);
      stream.end();
    }
    const finalized = output;
    // Reset for next segment.  Cross-segment state (sdkSessionId, cost, etc.)
    // is preserved.
    resetSegment();
    stream = undefined;
    return finalized;
  }

  return {
    attachStream(s, model) {
      stream = s;
      // Adopt the segment's selected model.  Mid-session switches (via
      // pi's model picker / setModel) need this so output.model and
      // calculateCost both reflect the new model, not the one we were
      // first constructed with.  If the segment is currently in-progress
      // (rare), also refresh output.model so existing accumulators stay
      // consistent with the new rates.
      const modelChanged = model.id !== currentModel.id || model.provider !== currentModel.provider;
      currentModel = model;
      if (modelChanged) {
        output.provider = model.provider;
        output.model = model.id;
      }
      // If we're starting a NEW segment (because the previous one's done was
      // pushed and the iterator is paused at a message boundary), reset segment
      // state.  If we're mid-segment (rare — provider should always close
      // before re-attaching), keep state intact.
      if (segmentStarted) {
        // Re-attaching mid-segment: push `start` with current output so the
        // new stream is well-formed.
        stream.push({ type: "start", partial: output });
      }
    },
    resetTurn(): void {
      // Called by the provider after consuming a turn-final `result` event,
      // so a subsequent streamSimple call for a new turn starts cleanly.
      // Per-segment state is already clean post-closeSegment; only the
      // cross-segment turn-level flags need clearing.
      turnDone = false;
      turnError = undefined;
    },
    getTurnError: () => turnError,
    /** Whether the bridge has accumulated any partial content for the
     * current segment.  Used by the provider's error-handling path to
     * decide whether to surface partial content vs. push an empty error. */
    hasPartialContent(): boolean {
      return segmentStarted || output.content.length > 0 || sawAnyContentForSegment;
    },
    getPartialOutput(): AssistantMessage {
      // Defensive clone: callers shouldn't mutate our internal state.
      // Content blocks are shallow-cloned (the inner text/thinking strings
      // are primitives, and ToolCall.arguments is best-effort already).
      return {
        ...output,
        content: output.content.map((c) => ({ ...c })) as AssistantMessage["content"],
        usage: { ...output.usage, cost: { ...output.usage.cost } },
      };
    },
    closeStreamWithError(message: string): void {
      output.stopReason = "error";
      output.errorMessage = message;
      if (stream) {
        ensureStreamStarted();
        stream.push({ type: "error", reason: "error", error: output } as any);
        stream.end();
      }
      resetSegment();
      stream = undefined;
    },
    handle,
    isSegmentReady,
    isTurnDone: () => turnDone,
    getSegmentStopReason: () => mapStopReason(rawStopReason),
    getCurrentSegmentToolUseIds: () => [...segmentToolUseIds],
    closeSegment,
    getSdkSessionId: () => sdkSessionId,
    getFastModeState: () => fastModeState,
    getCost: () => cost,
  };
}

/* ----------------------------- helpers ----------------------------- */

function freshOutput(model: Model<any>): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: PROVIDER_ID as any,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

/** Normalize the SDK's tool_result `content` field (string | array) into
 * pi's content block array. */
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
        // Anthropic image source { type: "base64", media_type, data }
        const src = item.source ?? {};
        blocks.push({
          type: "image",
          data: src.data ?? "",
          mimeType: src.media_type ?? "image/png",
        } as ImageContent);
      }
    }
    return blocks;
  }
  // Defensive: unknown shape → stringify.
  return [{ type: "text", text: typeof c === "undefined" ? "" : JSON.stringify(c) } as TextContent];
}
