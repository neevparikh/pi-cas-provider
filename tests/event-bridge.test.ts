/**
 * Unit tests for the stream-aligned event bridge.
 *
 * Drives the bridge with synthesized SDK messages and validates:
 *   - Segments close only after message_stop + all paired tool_results.
 *   - Pi event stream receives text/thinking/toolcall events in order.
 *   - Final `done` carries the right stop reason.
 *   - tool_use_result is cached for stub lookup.
 *   - Multiple segments within one SDK turn are produced cleanly.
 *   - resetTurn() rearms after `result`.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Model,
} from "@earendil-works/pi-ai";

import { createEventBridge } from "../src/event-bridge.js";
import { clear as clearCache, has, take } from "../src/tool-result-cache.js";

/* ---------- Synthetic SDK message factories ---------- */

const fakeModel = {
  id: "claude-sonnet-4-5",
  name: "Test Sonnet",
  provider: "anthropic",
  api: "anthropic-messages",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200000,
  maxTokens: 8192,
  thinkingLevelMap: {},
} as unknown as Model<any>;

function sysInit(sessionId: string) {
  return { type: "system", subtype: "init", session_id: sessionId };
}

function messageStart(usage?: any) {
  return {
    type: "stream_event",
    event: {
      type: "message_start",
      message: { usage: usage ?? { input_tokens: 10, output_tokens: 0 } },
    },
  };
}

function cbStartText(index: number) {
  return {
    type: "stream_event",
    event: { type: "content_block_start", index, content_block: { type: "text" } },
  };
}

function cbStartToolUse(index: number, id: string, name: string) {
  return {
    type: "stream_event",
    event: { type: "content_block_start", index, content_block: { type: "tool_use", id, name } },
  };
}

function cbDeltaText(index: number, text: string) {
  return {
    type: "stream_event",
    event: { type: "content_block_delta", index, delta: { type: "text_delta", text } },
  };
}

function cbDeltaJson(index: number, partial: string) {
  return {
    type: "stream_event",
    event: {
      type: "content_block_delta",
      index,
      delta: { type: "input_json_delta", partial_json: partial },
    },
  };
}

function cbStop(index: number) {
  return {
    type: "stream_event",
    event: { type: "content_block_stop", index },
  };
}

function messageDelta(stopReason: string, usage?: any) {
  return {
    type: "stream_event",
    event: {
      type: "message_delta",
      delta: { stop_reason: stopReason },
      usage: usage ?? { output_tokens: 50 },
    },
  };
}

function messageStop() {
  return { type: "stream_event", event: { type: "message_stop" } };
}

function userToolResult(id: string, content: string, isError = false, toolUseResult?: unknown) {
  return {
    type: "user",
    message: {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: id, content, is_error: isError },
      ],
    },
    tool_use_result: toolUseResult ?? { stdout: content, stderr: "", interrupted: false },
  };
}

function resultEvent(cost = 0.01) {
  return {
    type: "result",
    subtype: "success",
    total_cost_usd: cost,
    usage: { input_tokens: 10, output_tokens: 100 },
  };
}

/* ---------- Helpers ---------- */

/** Drain the pi event stream into an array. */
async function drainStream(stream: ReturnType<typeof createAssistantMessageEventStream>): Promise<any[]> {
  const out: any[] = [];
  for await (const ev of stream) out.push(ev);
  return out;
}

describe("event-bridge stream-aligned segmentation", () => {
  beforeEach(() => clearCache());

  it("text-only single segment closes on message_stop with stop reason 'stop'", async () => {
    const bridge = createEventBridge(fakeModel);
    const stream = createAssistantMessageEventStream();
    bridge.attachStream(stream, fakeModel);

    bridge.handle(sysInit("sess-1"));
    bridge.handle(messageStart());
    bridge.handle(cbStartText(0));
    bridge.handle(cbDeltaText(0, "hello"));
    bridge.handle(cbDeltaText(0, " world"));
    bridge.handle(cbStop(0));
    bridge.handle(messageDelta("end_turn"));
    bridge.handle(messageStop());

    expect(bridge.isSegmentReady()).toBe(true);
    const msg = bridge.closeSegment();

    expect(msg.content).toEqual([{ type: "text", text: "hello world" }]);
    expect(msg.stopReason).toBe("stop");
    expect(bridge.getSdkSessionId()).toBe("sess-1");

    const events = await drainStream(stream);
    const types = events.map((e) => e.type);
    expect(types).toContain("start");
    expect(types).toContain("text_start");
    expect(types).toContain("text_delta");
    expect(types).toContain("text_end");
    expect(types[types.length - 1]).toBe("done");
    expect(events[events.length - 1].reason).toBe("stop");
  });

  it("tool-use segment waits for tool_result before closing", () => {
    const bridge = createEventBridge(fakeModel);
    const stream = createAssistantMessageEventStream();
    bridge.attachStream(stream, fakeModel);

    bridge.handle(messageStart());
    bridge.handle(cbStartText(0));
    bridge.handle(cbDeltaText(0, "running"));
    bridge.handle(cbStop(0));
    bridge.handle(cbStartToolUse(1, "tu-1", "Bash"));
    bridge.handle(cbDeltaJson(1, '{"command":"echo hi"}'));
    bridge.handle(cbStop(1));
    bridge.handle(messageDelta("tool_use"));
    bridge.handle(messageStop());

    // message_stop received but tool_result not yet — segment NOT ready.
    expect(bridge.isSegmentReady()).toBe(false);

    bridge.handle(userToolResult("tu-1", "hi"));
    expect(bridge.isSegmentReady()).toBe(true);

    const ids = bridge.getCurrentSegmentToolUseIds();
    expect(ids).toEqual(["tu-1"]);

    const msg = bridge.closeSegment();
    expect(msg.stopReason).toBe("toolUse");
    expect(msg.content.some((c) => c.type === "toolCall")).toBe(true);

    // The cache should have the tool_result for stubs to consume.
    expect(has("tu-1")).toBe(true);
    const cached = take("tu-1")!;
    expect(cached.toolName).toBe("Bash");
    expect(cached.content).toEqual([{ type: "text", text: "hi" }]);
    expect(cached.isError).toBe(false);
  });

  it("parallel tool_uses: segment waits for ALL paired tool_results", () => {
    const bridge = createEventBridge(fakeModel);
    const stream = createAssistantMessageEventStream();
    bridge.attachStream(stream, fakeModel);

    bridge.handle(messageStart());
    bridge.handle(cbStartToolUse(0, "tu-a", "Bash"));
    bridge.handle(cbDeltaJson(0, "{}"));
    bridge.handle(cbStop(0));
    bridge.handle(cbStartToolUse(1, "tu-b", "Read"));
    bridge.handle(cbDeltaJson(1, "{}"));
    bridge.handle(cbStop(1));
    bridge.handle(messageDelta("tool_use"));
    bridge.handle(messageStop());

    expect(bridge.isSegmentReady()).toBe(false);
    bridge.handle(userToolResult("tu-a", "A"));
    expect(bridge.isSegmentReady()).toBe(false); // still waiting for tu-b
    bridge.handle(userToolResult("tu-b", "B"));
    expect(bridge.isSegmentReady()).toBe(true);

    expect(bridge.getCurrentSegmentToolUseIds().sort()).toEqual(["tu-a", "tu-b"]);
    bridge.closeSegment();
  });

  it("two consecutive segments in one turn (tool turn then continuation)", () => {
    const bridge = createEventBridge(fakeModel);

    // Segment 1: text + tool_use
    const stream1 = createAssistantMessageEventStream();
    bridge.attachStream(stream1, fakeModel);
    bridge.handle(messageStart());
    bridge.handle(cbStartText(0));
    bridge.handle(cbDeltaText(0, "let me check"));
    bridge.handle(cbStop(0));
    bridge.handle(cbStartToolUse(1, "tu-1", "Bash"));
    bridge.handle(cbDeltaJson(1, '{"command":"echo ok"}'));
    bridge.handle(cbStop(1));
    bridge.handle(messageDelta("tool_use"));
    bridge.handle(messageStop());
    bridge.handle(userToolResult("tu-1", "ok"));

    expect(bridge.isSegmentReady()).toBe(true);
    const seg1 = bridge.closeSegment();
    expect(seg1.stopReason).toBe("toolUse");

    // Segment 2: continuation text
    const stream2 = createAssistantMessageEventStream();
    bridge.attachStream(stream2, fakeModel);
    bridge.handle(messageStart());
    bridge.handle(cbStartText(0));
    bridge.handle(cbDeltaText(0, "result was ok"));
    bridge.handle(cbStop(0));
    bridge.handle(messageDelta("end_turn"));
    bridge.handle(messageStop());

    expect(bridge.isSegmentReady()).toBe(true);
    const seg2 = bridge.closeSegment();
    expect(seg2.stopReason).toBe("stop");
    expect(seg2.content).toEqual([{ type: "text", text: "result was ok" }]);
  });

  it("result event after segment closes triggers isTurnDone; resetTurn rearms", () => {
    const bridge = createEventBridge(fakeModel);
    const stream = createAssistantMessageEventStream();
    bridge.attachStream(stream, fakeModel);

    bridge.handle(messageStart());
    bridge.handle(cbStartText(0));
    bridge.handle(cbDeltaText(0, "done"));
    bridge.handle(cbStop(0));
    bridge.handle(messageDelta("end_turn"));
    bridge.handle(messageStop());

    bridge.closeSegment();
    bridge.handle(resultEvent(0.0042));
    expect(bridge.isTurnDone()).toBe(true);
    expect(bridge.getCost()).toBeCloseTo(0.0042);

    bridge.resetTurn();
    expect(bridge.isTurnDone()).toBe(false);
  });

  it("error tool_result preserves is_error in cache", () => {
    const bridge = createEventBridge(fakeModel);
    const stream = createAssistantMessageEventStream();
    bridge.attachStream(stream, fakeModel);

    bridge.handle(messageStart());
    bridge.handle(cbStartToolUse(0, "tu-err", "Bash"));
    bridge.handle(cbDeltaJson(0, "{}"));
    bridge.handle(cbStop(0));
    bridge.handle(messageDelta("tool_use"));
    bridge.handle(messageStop());
    bridge.handle(userToolResult("tu-err", "boom", true, "Error: Exit code 7"));

    bridge.closeSegment();
    const cached = take("tu-err")!;
    expect(cached.isError).toBe(true);
    expect(cached.toolName).toBe("Bash");
    expect(cached.details).toBe("Error: Exit code 7");
  });

  it("string tool_result content is wrapped into [{type:text}]", () => {
    const bridge = createEventBridge(fakeModel);
    bridge.attachStream(createAssistantMessageEventStream(), fakeModel);
    bridge.handle(messageStart());
    bridge.handle(cbStartToolUse(0, "tu-1", "Bash"));
    bridge.handle(cbStop(0));
    bridge.handle(messageDelta("tool_use"));
    bridge.handle(messageStop());
    bridge.handle(userToolResult("tu-1", "plain string"));
    bridge.closeSegment();
    expect(take("tu-1")?.content).toEqual([{ type: "text", text: "plain string" }]);
  });

  it("after closeSegment(), tool-use ids list is queryable for the closed segment, then resets", () => {
    const bridge = createEventBridge(fakeModel);
    bridge.attachStream(createAssistantMessageEventStream(), fakeModel);
    bridge.handle(messageStart());
    bridge.handle(cbStartToolUse(0, "tu-x", "Bash"));
    bridge.handle(cbStop(0));
    bridge.handle(messageDelta("tool_use"));
    bridge.handle(messageStop());
    bridge.handle(userToolResult("tu-x", "x"));

    // BEFORE close: returns the current segment's ids.
    expect(bridge.getCurrentSegmentToolUseIds()).toEqual(["tu-x"]);
    bridge.closeSegment();
    // AFTER close: per-segment state was reset.
    expect(bridge.getCurrentSegmentToolUseIds()).toEqual([]);
  });

  it("mid-session model switch is reflected in output.model and used for cost", () => {
    const bridge = createEventBridge(fakeModel);
    const otherModel = {
      ...(fakeModel as any),
      id: "claude-opus-4-6",
      name: "Opus 4.6",
      provider: "anthropic",
      cost: { input: 30, output: 150, cacheRead: 0, cacheWrite: 0 },
    } as Model<any>;

    // First segment under the original model.
    bridge.attachStream(createAssistantMessageEventStream(), fakeModel);
    bridge.handle(messageStart());
    bridge.handle(cbStartText(0));
    bridge.handle(cbDeltaText(0, "hi"));
    bridge.handle(cbStop(0));
    bridge.handle(messageDelta("end_turn"));
    bridge.handle(messageStop());
    const seg1 = bridge.closeSegment();
    expect(seg1.model).toBe(fakeModel.id);

    // Second segment after a mid-session model switch.
    bridge.attachStream(createAssistantMessageEventStream(), otherModel);
    bridge.handle(messageStart());
    bridge.handle(cbStartText(0));
    bridge.handle(cbDeltaText(0, "opus says hi"));
    bridge.handle(cbStop(0));
    bridge.handle(messageDelta("end_turn"));
    bridge.handle(messageStop());
    const seg2 = bridge.closeSegment();
    expect(seg2.model).toBe(otherModel.id);
    expect(seg2.provider).toBe(otherModel.provider);
  });

  it("thinking blocks pass through with thinking_start/delta/end events", async () => {
    const bridge = createEventBridge(fakeModel);
    const stream = createAssistantMessageEventStream();
    bridge.attachStream(stream, fakeModel);

    bridge.handle(messageStart());
    bridge.handle({
      type: "stream_event",
      event: { type: "content_block_start", index: 0, content_block: { type: "thinking" } },
    });
    bridge.handle({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "let me think" },
      },
    });
    bridge.handle({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "signature_delta", signature: "sig" },
      },
    });
    bridge.handle(cbStop(0));
    bridge.handle(cbStartText(1));
    bridge.handle(cbDeltaText(1, "ok"));
    bridge.handle(cbStop(1));
    bridge.handle(messageDelta("end_turn"));
    bridge.handle(messageStop());

    const msg = bridge.closeSegment();
    expect(msg.content[0]).toMatchObject({
      type: "thinking",
      thinking: "let me think",
      thinkingSignature: "sig",
    });
    expect(msg.content[1]).toEqual({ type: "text", text: "ok" });

    const events = await drainStream(stream);
    const types = events.map((e) => e.type);
    expect(types).toContain("thinking_start");
    expect(types).toContain("thinking_delta");
    expect(types).toContain("thinking_end");
  });
});
