/**
 * Translate the Agent SDK's message stream into pi's AssistantMessageEvent stream.
 *
 * The SDK emits typed SDKMessage values. We care about:
 *   - system.init           → capture session_id for resume continuity
 *   - stream_event (partial)→ Anthropic SSE-shaped events (content_block_*, etc.)
 *   - assistant             → final assistant turn (fallback if no partials)
 *   - result                → final usage + total_cost_usd + fast_mode_state
 *
 * Pi expects events in this order:
 *   start → (text|thinking|toolcall)_(start|delta|end)+ → done|error
 */

import type {
  AssistantMessage,
  AssistantMessageEventStream,
  Model,
  TextContent,
  ThinkingContent,
  ToolCall,
} from "@earendil-works/pi-ai";
import { calculateCost } from "@earendil-works/pi-ai";

import { PROVIDER_ID } from "./config.js";

/**
 * In the Option A architecture the SDK runs Claude Code's built-in tools
 * natively, so we no longer need to translate tool names + argument schemas
 * back and forth between pi's and CC's conventions.  Pi sees the CC names
 * directly (Bash, Read, Write, ...) and pi-cas just forwards stream events.
 * If a future iteration wants pi to display the tool calls with friendlier
 * labels, that's a presentation concern, not a translation concern.
 */
function passThroughTool(name: string, args: Record<string, unknown>): {
  name: string;
  arguments: Record<string, unknown>;
} {
  return { name, arguments: args };
}

interface Tracked {
  index: number;                // Anthropic content_block index
  piIndex: number;              // index in output.content
  kind: "text" | "thinking" | "tool_use";
  partialJson?: string;         // accumulator for tool_use input_json_delta
  claudeName?: string;          // for tool_use: original CC name before mapping
}

export interface EventBridge {
  /** Feed one SDK message into the bridge. */
  handle(msg: any): void;
  /** Final AssistantMessage accumulated so far. */
  getOutput(): AssistantMessage;
  /** Session id captured from system.init (if any). */
  getSdkSessionId(): string | undefined;
  /** fast_mode_state from the result message (if any). */
  getFastModeState(): "off" | "cooldown" | "on" | undefined;
  /** Total cost reported by the result message (if any). */
  getCost(): number | undefined;
}

export function createEventBridge(
  stream: AssistantMessageEventStream,
  model: Model<any>,
): EventBridge {
  const output: AssistantMessage = {
    role: "assistant",
    content: [],
    api: PROVIDER_ID as any,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };

  const blocks: Tracked[] = [];
  let started = false;
  let sdkSessionId: string | undefined;
  let fastModeState: "off" | "cooldown" | "on" | undefined;
  let cost: number | undefined;

  const ensureStarted = () => {
    if (started) return;
    started = true;
    stream.push({ type: "start", partial: output });
  };

  function handle(msg: any): void {
    // System init carries the session id we'll want to reuse across pi turns.
    if (msg.type === "system" && msg.subtype === "init") {
      sdkSessionId = msg.session_id ?? sdkSessionId;
      return;
    }

    // Partial assistant events — Anthropic SSE-shaped, wrapped by the SDK as
    // `stream_event`. Names vary across SDK versions; handle both shapes.
    if (msg.type === "stream_event" || msg.type === "partial_assistant") {
      ensureStarted();
      const event = msg.event ?? msg;
      handleSseEvent(event);
      return;
    }

    // Final full assistant message — used as a fallback if partials were absent.
    if (msg.type === "assistant") {
      ensureStarted();
      const bm = msg.message;
      if (bm?.usage) updateUsage(bm.usage);
      if (bm?.stop_reason) output.stopReason = mapStopReason(bm.stop_reason);

      // If we never saw any partial events, materialize content here.
      if (output.content.length === 0 && Array.isArray(bm?.content)) {
        for (const b of bm.content) appendFinalBlock(b);
      }
      return;
    }

    if (msg.type === "result") {
      if (typeof msg.total_cost_usd === "number") cost = msg.total_cost_usd;
      if (msg.fast_mode_state) fastModeState = msg.fast_mode_state;
      if (msg.usage) updateUsage(msg.usage);
      return;
    }
  }

  function handleSseEvent(event: any): void {
    switch (event.type) {
      case "content_block_start": {
        const cb = event.content_block;
        const ccIdx = event.index ?? 0;
        if (cb.type === "text") {
          const piIndex = output.content.length;
          output.content.push({ type: "text", text: "" } as TextContent);
          blocks.push({ index: ccIdx, piIndex, kind: "text" });
          stream.push({ type: "text_start", contentIndex: piIndex, partial: output });
        } else if (cb.type === "thinking") {
          const piIndex = output.content.length;
          output.content.push({
            type: "thinking", thinking: "", thinkingSignature: "",
          } as ThinkingContent);
          blocks.push({ index: ccIdx, piIndex, kind: "thinking" });
          stream.push({ type: "thinking_start", contentIndex: piIndex, partial: output });
        } else if (cb.type === "tool_use") {
          // Translate name now so pi sees its own tool names.
          // We'll translate args at content_block_stop once we have the full JSON.
          const piIndex = output.content.length;
          const { name } = passThroughTool(cb.name, {});
          output.content.push({
            type: "toolCall", id: cb.id, name, arguments: {},
          } as ToolCall);
          blocks.push({
            index: ccIdx, piIndex, kind: "tool_use",
            partialJson: "", claudeName: cb.name,
          });
          stream.push({ type: "toolcall_start", contentIndex: piIndex, partial: output });
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
          stream.push({
            type: "text_delta", contentIndex: tracked.piIndex,
            delta: d.text ?? "", partial: output,
          });
        } else if (d.type === "thinking_delta" && tracked.kind === "thinking") {
          const block = output.content[tracked.piIndex] as ThinkingContent;
          block.thinking += d.thinking ?? "";
          stream.push({
            type: "thinking_delta", contentIndex: tracked.piIndex,
            delta: d.thinking ?? "", partial: output,
          });
        } else if (d.type === "signature_delta" && tracked.kind === "thinking") {
          const block = output.content[tracked.piIndex] as ThinkingContent;
          block.thinkingSignature = (block.thinkingSignature ?? "") + (d.signature ?? "");
        } else if (d.type === "input_json_delta" && tracked.kind === "tool_use") {
          tracked.partialJson = (tracked.partialJson ?? "") + (d.partial_json ?? "");
          // Best-effort parse so pi sees partial args during streaming.
          try {
            const parsed = JSON.parse(tracked.partialJson);
            (output.content[tracked.piIndex] as ToolCall).arguments = parsed;
          } catch { /* not yet valid JSON */ }
          stream.push({
            type: "toolcall_delta", contentIndex: tracked.piIndex,
            delta: d.partial_json ?? "", partial: output,
          });
        }
        return;
      }

      case "content_block_stop": {
        const tracked = blocks.find((b) => b.index === event.index);
        if (!tracked) return;

        if (tracked.kind === "text") {
          const block = output.content[tracked.piIndex] as TextContent;
          stream.push({
            type: "text_end", contentIndex: tracked.piIndex,
            content: block.text, partial: output,
          });
        } else if (tracked.kind === "thinking") {
          const block = output.content[tracked.piIndex] as ThinkingContent;
          stream.push({
            type: "thinking_end", contentIndex: tracked.piIndex,
            content: block.thinking, partial: output,
          });
        } else if (tracked.kind === "tool_use") {
          // Final parse + arg translation (Claude → pi).
          let parsedArgs: Record<string, unknown> = {};
          try { parsedArgs = JSON.parse(tracked.partialJson ?? ""); }
          catch { /* leave empty */ }
          const { arguments: piArgs } = passThroughTool(tracked.claudeName ?? "", parsedArgs);
          (output.content[tracked.piIndex] as ToolCall).arguments = piArgs;
          stream.push({
            type: "toolcall_end", contentIndex: tracked.piIndex,
            toolCall: output.content[tracked.piIndex] as ToolCall, partial: output,
          });
        }
        return;
      }

      case "message_delta": {
        if (event.delta?.stop_reason) {
          output.stopReason = mapStopReason(event.delta.stop_reason);
        }
        if (event.usage) updateUsage(event.usage);
        return;
      }

      case "message_stop": {
        // No-op: provider pushes `done` after the SDK iterator finishes so that
        // pi's tool execution can proceed only after we've seen the final result.
        return;
      }

      case "message_start": {
        // Anthropic resets `content_block` indices at every assistant
        // message boundary.  In the Option A architecture, one streamSimple
        // call may produce MULTIPLE assistant messages (text+tool_use, then
        // tool ran, then final text — each is its own Anthropic message
        // with content_block index starting at 0).  Without clearing our
        // tracked block list here, the second message's content_block
        // index=0 would collide with the first message's text block and
        // route its deltas to the wrong pi content entry — most visibly
        // dropping the final-text reply on tool turns.
        //
        // We do NOT clear `output.content` itself: pi's view of the turn
        // is the concatenation of all assistant content across the multi-
        // message turn, so we keep appending.  Only the index-keyed
        // tracked-block bookkeeping resets.
        if (event.message?.usage) updateUsage(event.message.usage);
        blocks.length = 0;
        return;
      }
    }
  }

  function appendFinalBlock(b: any): void {
    if (b.type === "text") {
      output.content.push({ type: "text", text: b.text ?? "" } as TextContent);
    } else if (b.type === "thinking") {
      output.content.push({
        type: "thinking", thinking: b.thinking ?? "",
        thinkingSignature: b.signature ?? "",
      } as ThinkingContent);
    } else if (b.type === "tool_use") {
      const { name, arguments: piArgs } = passThroughTool(b.name, b.input ?? {});
      output.content.push({
        type: "toolCall", id: b.id, name, arguments: piArgs,
      } as ToolCall);
    }
  }

  function updateUsage(u: any): void {
    if (typeof u.input_tokens === "number") output.usage.input = u.input_tokens;
    if (typeof u.output_tokens === "number") output.usage.output = u.output_tokens;
    if (typeof u.cache_read_input_tokens === "number")
      output.usage.cacheRead = u.cache_read_input_tokens;
    if (typeof u.cache_creation_input_tokens === "number")
      output.usage.cacheWrite = u.cache_creation_input_tokens;
    output.usage.totalTokens =
      output.usage.input + output.usage.output +
      output.usage.cacheRead + output.usage.cacheWrite;
    calculateCost(model, output.usage);
  }

  return {
    handle,
    getOutput: () => output,
    getSdkSessionId: () => sdkSessionId,
    getFastModeState: () => fastModeState,
    getCost: () => cost,
  };
}

function mapStopReason(reason: string): AssistantMessage["stopReason"] {
  switch (reason) {
    case "tool_use": return "toolUse";
    case "max_tokens": return "length";
    case "end_turn":
    default: return "stop";
  }
}
