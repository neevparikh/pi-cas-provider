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
   * at the start of each streamSimple call. */
  attachStream(stream: AssistantMessageEventStream): void;

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

export function createEventBridge(model: Model<any>): EventBridge {
  // Cross-segment / cross-turn state.
  let sdkSessionId: string | undefined;
  let fastModeState: "off" | "cooldown" | "on" | undefined;
  let cost: number | undefined;

  // Per-segment state — reset on each new Anthropic message_start.
  let stream: AssistantMessageEventStream | undefined;
  let output: AssistantMessage = freshOutput(model);
  let blocks: Tracked[] = [];
  let pendingToolUseIds = new Set<string>();
  let segmentToolUseIds: string[] = [];
  let sawMessageStop = false;
  let sawAnyContentForSegment = false;
  let segmentStarted = false;
  let turnDone = false;
  let rawStopReason: string | undefined;

  function resetSegment(): void {
    output = freshOutput(model);
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
    if (msg.type === "user") {
      const c = msg.message?.content;
      if (Array.isArray(c)) {
        for (const block of c) {
          if (block.type === "tool_result") {
            ingestToolResult(block, msg.tool_use_result);
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
            if (DEBUG) {
              console.error(
                `[pi-cas/debug] WARN: SDK emitted unsupported tool_use name "${cb.name}". ` +
                  `Pi will fail to execute (Tool ${cb.name} not found). ` +
                  `Add it to SUPPORTED_CC_TOOL_NAMES if it should be supported.`,
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

  function ingestToolResult(block: any, sdkToolUseResult: unknown): void {
    const id: string = block.tool_use_id;
    if (!id) return;
    const isError = block.is_error === true;
    const content = normalizeToolResultContent(block.content);
    // Resolve the tool name: we need it for pi's display.  Look it up from
    // tracked blocks in the current segment.
    const tracked = blocks.find((b) => b.kind === "tool_use" && id === (output.content[b.piIndex] as ToolCall).id);
    const toolName = tracked?.toolName ?? "Unknown";
    const entry: CachedToolResult = {
      content,
      isError,
      toolName,
      details: sdkToolUseResult,
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
    calculateCost(model, output.usage);
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
    attachStream(s) {
      stream = s;
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
      // cross-segment turnDone flag needs clearing.
      turnDone = false;
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
