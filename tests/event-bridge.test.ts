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
import { clear as clearTranscripts, peek as peekTranscript } from "../src/subagent-transcript.js";

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
  beforeEach(() => {
    clearCache();
    clearTranscripts();
  });

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

  it("regression (H1): stale turnDone after end_turn segment must not leak into next turn", () => {
    // The actual bug fixed during dev: after segment 2 closed at end_turn,
    // the provider drained the SDK's `result` event, which set turnDone=true.
    // Without resetTurn(), the next streamSimple's consume loop would see
    // isSegmentReady() true (via stale flags) and return an empty assistant
    // message for segment 3.  This test exercises the failure shape directly.
    const bridge = createEventBridge(fakeModel);

    // Turn 1 — single end_turn segment.
    bridge.attachStream(createAssistantMessageEventStream(), fakeModel);
    bridge.handle(messageStart());
    bridge.handle(cbStartText(0));
    bridge.handle(cbDeltaText(0, "turn 1"));
    bridge.handle(cbStop(0));
    bridge.handle(messageDelta("end_turn"));
    bridge.handle(messageStop());
    expect(bridge.isSegmentReady()).toBe(true);
    bridge.closeSegment();
    // Provider would drain result here:
    bridge.handle(resultEvent());
    expect(bridge.isTurnDone()).toBe(true);
    // Without resetTurn, a new attachStream would observe stale state:
    bridge.resetTurn();
    expect(bridge.isTurnDone()).toBe(false);

    // Turn 2 — the formerly-broken segment 3.  Should consume real events,
    // not exit immediately on stale flags.
    bridge.attachStream(createAssistantMessageEventStream(), fakeModel);
    // Before any events, segment is NOT ready and turn is NOT done.
    expect(bridge.isSegmentReady()).toBe(false);
    expect(bridge.isTurnDone()).toBe(false);
    bridge.handle(messageStart());
    bridge.handle(cbStartText(0));
    bridge.handle(cbDeltaText(0, "turn 2 content"));
    bridge.handle(cbStop(0));
    bridge.handle(messageDelta("end_turn"));
    bridge.handle(messageStop());
    expect(bridge.isSegmentReady()).toBe(true);
    const seg = bridge.closeSegment();
    expect((seg.content[0] as any).text).toBe("turn 2 content");
  });

  it("H2: turn-level error result is captured and exposed via getTurnError", () => {
    const bridge = createEventBridge(fakeModel);
    bridge.attachStream(createAssistantMessageEventStream(), fakeModel);
    // SDK reports a turn-level error before ANY assistant message_start
    // (e.g., auth failure, rate limit during request, server 5xx).
    bridge.handle({
      type: "result",
      subtype: "error_max_turns",
      is_error: true,
      result: "rate limit exceeded",
      total_cost_usd: 0,
    });
    expect(bridge.isTurnDone()).toBe(true);
    expect(bridge.isSegmentReady()).toBe(false);  // no segment ever started
    expect(bridge.hasPartialContent()).toBe(false);
    const err = bridge.getTurnError();
    expect(err).toBeDefined();
    expect(err).toMatch(/rate limit/i);
  });

  it("H2: turn-level error after partial content surfaces both error and partial flag", () => {
    const bridge = createEventBridge(fakeModel);
    bridge.attachStream(createAssistantMessageEventStream(), fakeModel);
    bridge.handle(messageStart());
    bridge.handle(cbStartText(0));
    bridge.handle(cbDeltaText(0, "streaming started"));
    // Suppose the connection dropped mid-stream; SDK emits an error result
    // without ever sending message_stop.
    bridge.handle({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      error: { message: "connection lost" },
    });
    expect(bridge.isTurnDone()).toBe(true);
    expect(bridge.isSegmentReady()).toBe(false);  // no message_stop arrived
    expect(bridge.hasPartialContent()).toBe(true);
    expect(bridge.getTurnError()).toMatch(/connection lost/i);
  });

  it("closeStreamWithError preserves partial content (text already streamed) in the error event", async () => {
    const bridge = createEventBridge(fakeModel);
    const stream = createAssistantMessageEventStream();
    bridge.attachStream(stream, fakeModel);

    // Some text streamed before the SDK errored out.
    bridge.handle(messageStart());
    bridge.handle(cbStartText(0));
    bridge.handle(cbDeltaText(0, "partial answer"));
    // No content_block_stop, no message_stop — connection dropped here.

    // Provider's error path: close with the captured turn error.
    bridge.closeStreamWithError("network: connection reset");

    const events: any[] = [];
    for await (const ev of stream) events.push(ev);
    const last = events[events.length - 1];
    expect(last.type).toBe("error");
    expect(last.error.errorMessage).toMatch(/connection reset/i);
    // Partial content is preserved on the error message so pi can render
    // whatever the user had already seen on screen.
    expect(last.error.content.length).toBeGreaterThan(0);
    expect((last.error.content[0] as any).text).toBe("partial answer");
    expect(last.error.stopReason).toBe("error");
  });

  it("closeStreamWithError with no partial content emits an error event with empty content", async () => {
    const bridge = createEventBridge(fakeModel);
    const stream = createAssistantMessageEventStream();
    bridge.attachStream(stream, fakeModel);
    bridge.closeStreamWithError("auth failure");
    const events: any[] = [];
    for await (const ev of stream) events.push(ev);
    const last = events[events.length - 1];
    expect(last.type).toBe("error");
    expect(last.error.errorMessage).toMatch(/auth failure/);
    expect(last.error.content).toEqual([]);
  });

  it("H2: resetTurn clears turnError state", () => {
    const bridge = createEventBridge(fakeModel);
    bridge.attachStream(createAssistantMessageEventStream(), fakeModel);
    bridge.handle({ type: "result", is_error: true, result: "x" });
    expect(bridge.getTurnError()).toBeDefined();
    bridge.resetTurn();
    expect(bridge.getTurnError()).toBeUndefined();
    expect(bridge.isTurnDone()).toBe(false);
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

  describe("subagent event capture (parent_tool_use_id != null)", () => {
    // The SDK emits subagent inner messages on the same iterator as the
    // main thread, tagged with `parent_tool_use_id != null`.  The bridge
    // must (a) keep them OUT of pi's main-segment output and (b) capture
    // them into a SubagentTranscript that gets attached to the Task
    // tool_result's cache entry — so the Task stub's renderResult can
    // display the nested transcript (text, tool calls, final output).
    // See `src/subagent-transcript.ts` and `src/task-stub.ts`.

    function typedAssistantMessage(
      content: any[],
      parentToolUseId: string | null,
      opts: { usage?: any; model?: string } = {},
    ) {
      return {
        type: "assistant",
        parent_tool_use_id: parentToolUseId,
        message: {
          content,
          usage: opts.usage ?? { input_tokens: 5, output_tokens: 10 },
          ...(opts.model ? { model: opts.model } : {}),
        },
      };
    }

    function typedUserToolResult(
      blocks: any[],
      parentToolUseId: string | null,
      toolUseResult?: unknown,
    ) {
      return {
        type: "user",
        parent_tool_use_id: parentToolUseId,
        message: { role: "user", content: blocks },
        ...(toolUseResult !== undefined ? { tool_use_result: toolUseResult } : {}),
      };
    }

    function taskStartedSystem(
      toolUseId: string,
      opts: { taskId?: string; subagentType?: string; prompt?: string } = {},
    ) {
      return {
        type: "system",
        subtype: "task_started",
        task_id: opts.taskId ?? "task-1",
        tool_use_id: toolUseId,
        ...(opts.subagentType ? { subagent_type: opts.subagentType } : {}),
        ...(opts.prompt ? { prompt: opts.prompt } : {}),
      };
    }

    function taskNotificationSystem(
      toolUseId: string,
      status: string,
      opts: { taskId?: string; summary?: string } = {},
    ) {
      return {
        type: "system",
        subtype: "task_notification",
        task_id: opts.taskId ?? "task-1",
        tool_use_id: toolUseId,
        status,
        ...(opts.summary ? { summary: opts.summary } : {}),
      };
    }

    it("subagent events are captured into a transcript and attached to the Task tool_result cache entry", () => {
      const bridge = createEventBridge(fakeModel);
      bridge.attachStream(createAssistantMessageEventStream(), fakeModel);

      // Main thread emits a Task tool_use.
      bridge.handle(messageStart());
      bridge.handle(cbStartText(0));
      bridge.handle(cbDeltaText(0, "Let me delegate"));
      bridge.handle(cbStop(0));
      bridge.handle(cbStartToolUse(1, "tu-task", "Task"));
      bridge.handle(cbDeltaJson(1, '{"description":"do thing"}'));
      bridge.handle(cbStop(1));
      bridge.handle(messageDelta("tool_use"));
      bridge.handle(messageStop());

      // SDK runs Task internally; emits subagent task_started + subagent
      // typed assistant/user events tagged with parent_tool_use_id="tu-task".
      bridge.handle(
        taskStartedSystem("tu-task", {
          subagentType: "Explore",
          prompt: "Find every typebox import",
        }),
      );
      bridge.handle(
        typedAssistantMessage(
          [
            { type: "text", text: "subagent inner reasoning" },
            { type: "tool_use", id: "tu-inner", name: "Bash", input: { command: "ls" } },
          ],
          "tu-task",
          { model: "claude-sonnet-4-5" },
        ),
      );
      bridge.handle(
        typedUserToolResult(
          [{ type: "tool_result", tool_use_id: "tu-inner", content: "subagent inner result" }],
          "tu-task",
          { stdout: "subagent inner result", stderr: "" },
        ),
      );
      bridge.handle(
        typedAssistantMessage(
          [{ type: "text", text: "Final answer from subagent." }],
          "tu-task",
        ),
      );
      bridge.handle(
        taskNotificationSystem("tu-task", "completed", { summary: "All done." }),
      );

      // Subagent done; SDK emits the parent Task tool_result.
      bridge.handle(userToolResult("tu-task", "subagent final summary"));

      expect(bridge.isSegmentReady()).toBe(true);
      const msg = bridge.closeSegment();

      // Main segment contains ONLY the main-thread text + Task tool_use.
      expect(msg.content.length).toBe(2);
      expect(msg.content[0]).toMatchObject({ type: "text", text: "Let me delegate" });
      expect(msg.content[1]).toMatchObject({ type: "toolCall", name: "Task", id: "tu-task" });
      // Subagent-internal tool_use_id should NEVER have appeared in the
      // segment's tracked ids.
      expect(has("tu-inner")).toBe(false);

      // The cache entry for the Task tool_use should have the subagent
      // transcript attached under details._piCasSubagentTranscript.
      const cached = take("tu-task")!;
      expect(cached.toolName).toBe("Task");
      const details = cached.details as Record<string, unknown>;
      const transcript = details._piCasSubagentTranscript as any;
      expect(transcript).toBeDefined();
      expect(transcript.subagentType).toBe("Explore");
      expect(transcript.taskPrompt).toBe("Find every typebox import");
      expect(transcript.finalStatus).toBe("completed");
      expect(transcript.finalSummary).toBe("All done.");
      expect(transcript.model).toBe("claude-sonnet-4-5");
      expect(transcript.messages.length).toBe(3); // 2 assistant + 1 toolResult
      expect(transcript.messages[0]).toMatchObject({
        role: "assistant",
      });
      expect(transcript.messages[1]).toMatchObject({
        role: "toolResult",
        toolCallId: "tu-inner",
        isError: false,
      });
      expect(transcript.usage.turns).toBe(2);
      // The transcript should have been removed from the in-memory store
      // after being attached to the cache entry.
      expect(peekTranscript("tu-task")).toBeUndefined();
    });

    it("typed subagent events do not leak into pi's main-segment output", () => {
      const bridge = createEventBridge(fakeModel);
      bridge.attachStream(createAssistantMessageEventStream(), fakeModel);

      bridge.handle(messageStart());
      bridge.handle(cbStartText(0));
      bridge.handle(cbDeltaText(0, "main"));
      bridge.handle(cbStop(0));
      bridge.handle(cbStartToolUse(1, "tu-task", "Task"));
      bridge.handle(cbStop(1));
      bridge.handle(messageDelta("tool_use"));
      bridge.handle(messageStop());

      bridge.handle(taskStartedSystem("tu-task"));
      bridge.handle(
        typedAssistantMessage(
          [{ type: "text", text: "this should NOT appear in main output" }],
          "tu-task",
        ),
      );
      bridge.handle(userToolResult("tu-task", "x"));

      const seg = bridge.closeSegment();
      // Main output excludes the subagent text.
      const allText = seg.content
        .filter((c) => c.type === "text")
        .map((c) => (c as any).text)
        .join("\n");
      expect(allText).toBe("main");
      expect(allText).not.toContain("subagent");
      expect(allText).not.toContain("NOT appear");
    });

    it("when there is no subagent transcript, the Task tool_result cache entry has no _piCasSubagentTranscript", () => {
      // E.g., model emits Task but the SDK doesn't run a subagent (or
      // forwardSubagentText is off and only the parent result arrives).
      // The cache entry should still be usable; renderer falls back to
      // plain text.
      const bridge = createEventBridge(fakeModel);
      bridge.attachStream(createAssistantMessageEventStream(), fakeModel);
      bridge.handle(messageStart());
      bridge.handle(cbStartToolUse(0, "tu-task", "Task"));
      bridge.handle(cbStop(0));
      bridge.handle(messageDelta("tool_use"));
      bridge.handle(messageStop());
      // No subagent events; just the parent tool_result.
      bridge.handle(userToolResult("tu-task", "raw summary"));
      bridge.closeSegment();
      const cached = take("tu-task")!;
      const details = cached.details as Record<string, unknown> | undefined;
      // details may be undefined or shaped however the SDK reported it,
      // but it should NOT contain the transcript field.
      if (details && typeof details === "object") {
        expect((details as any)._piCasSubagentTranscript).toBeUndefined();
      }
    });

    it("task_progress updates the transcript (summary, lastToolName) for the running UI", () => {
      const bridge = createEventBridge(fakeModel);
      bridge.attachStream(createAssistantMessageEventStream(), fakeModel);
      bridge.handle(messageStart());
      bridge.handle(cbStartToolUse(0, "tu-task", "Task"));
      bridge.handle(cbStop(0));
      bridge.handle(messageDelta("tool_use"));
      bridge.handle(messageStop());

      bridge.handle(taskStartedSystem("tu-task", { subagentType: "Explore" }));
      bridge.handle({
        type: "system",
        subtype: "task_progress",
        task_id: "task-1",
        tool_use_id: "tu-task",
        description: "progress",
        summary: "looking up usages",
        last_tool_name: "Grep",
        usage: { total_tokens: 100, tool_uses: 2, duration_ms: 1000 },
      });

      // Peek BEFORE the parent tool_result arrives (transcript still in store).
      const inProgress = peekTranscript("tu-task")!;
      expect(inProgress.progressSummary).toBe("looking up usages");
      expect(inProgress.lastToolName).toBe("Grep");
      expect(inProgress.subagentType).toBe("Explore");

      bridge.handle(userToolResult("tu-task", "done"));
      bridge.closeSegment();

      // After ingestion the transcript moves to the cache entry.
      const cached = take("tu-task")!;
      const transcript = (cached.details as any)._piCasSubagentTranscript;
      expect(transcript.progressSummary).toBe("looking up usages");
      expect(transcript.lastToolName).toBe("Grep");
    });

    it("system task_updated is dropped silently (no transcript mutation)", () => {
      const bridge = createEventBridge(fakeModel);
      bridge.attachStream(createAssistantMessageEventStream(), fakeModel);
      bridge.handle(messageStart());
      bridge.handle(cbStartText(0));
      bridge.handle(cbDeltaText(0, "ok"));
      bridge.handle(cbStop(0));
      bridge.handle({
        type: "system",
        subtype: "task_updated",
        task_id: "task-A",
        patch: { status: "running" },
      });
      bridge.handle(messageDelta("end_turn"));
      bridge.handle(messageStop());
      const seg = bridge.closeSegment();
      expect(seg.content).toEqual([{ type: "text", text: "ok" }]);
    });

    it("tool_progress events (subagent or main-thread) are dropped", () => {
      const bridge = createEventBridge(fakeModel);
      bridge.attachStream(createAssistantMessageEventStream(), fakeModel);
      bridge.handle(messageStart());
      bridge.handle(cbStartText(0));
      bridge.handle(cbDeltaText(0, "hi"));
      bridge.handle(cbStop(0));
      // Main-thread tool_progress (parent_tool_use_id=null) and subagent
      // (parent != null).  Neither should surface.
      bridge.handle({
        type: "tool_progress",
        tool_use_id: "tu-1",
        tool_name: "Bash",
        parent_tool_use_id: null,
        elapsed_time_seconds: 1.5,
      });
      bridge.handle({
        type: "tool_progress",
        tool_use_id: "tu-2",
        tool_name: "Read",
        parent_tool_use_id: "tu-task",
        elapsed_time_seconds: 0.5,
      });
      bridge.handle(messageDelta("end_turn"));
      bridge.handle(messageStop());
      const seg = bridge.closeSegment();
      expect(seg.content).toEqual([{ type: "text", text: "hi" }]);
    });

    it("defensive: if SSE partials leaked a subagent tool_use, the typed-assistant cleanup removes it from pending", () => {
      // Simulate the SDK leaking subagent SSE partials (hypothetical:
      // current SDK shouldn't, but the bridge is defensive in case
      // future versions or `forwardSubagentText: true` change behavior).
      const bridge = createEventBridge(fakeModel);
      const stream = createAssistantMessageEventStream();
      bridge.attachStream(stream, fakeModel);

      // Main thread Task call.
      bridge.handle(messageStart());
      bridge.handle(cbStartToolUse(0, "tu-task", "Task"));
      bridge.handle(cbStop(0));
      bridge.handle(messageDelta("tool_use"));
      bridge.handle(messageStop());

      // Simulate "leaked" subagent SSE partials BEFORE the typed
      // assistant message arrives.  These get added to pendingToolUseIds
      // (the bridge can't tell yet that they're subagent-internal).
      // Here we feed them via the same SSE path as the main thread would.
      // To avoid mid-segment defensive-reset (`message_start` with state)
      // we add them as a SEPARATE SSE message_start that the bridge will
      // also track — they'll end up in pendingToolUseIds.
      //
      // Note: in reality, the bridge's `message_start` defensive-reset
      // would clear the prior pending set.  This test is somewhat
      // contrived — we're really testing that the cleanup function
      // doesn't blow up if it runs in a clean state and that it does
      // remove ids when present.  Direct call-shape test:

      // Manually push a fake leaked id into pendingToolUseIds via the
      // public surface: feed a fresh segment whose tool_use we'll then
      // try to clean up.

      // Reset: close & start a new segment.
      bridge.handle(userToolResult("tu-task", "task done"));
      bridge.closeSegment();

      // Now an independent segment with a tool_use we'll pretend is
      // "actually a subagent leak".
      bridge.attachStream(createAssistantMessageEventStream(), fakeModel);
      bridge.handle(messageStart());
      bridge.handle(cbStartToolUse(0, "tu-leak", "Bash"));
      bridge.handle(cbStop(0));
      bridge.handle(messageDelta("tool_use"));
      bridge.handle(messageStop());
      // Without intervention, segment is NOT ready (tool_result missing).
      expect(bridge.isSegmentReady()).toBe(false);

      // Now the SDK reveals (via typed assistant with parent != null)
      // that "tu-leak" was actually a subagent tool_use.  Cleanup should
      // remove it from pending and from output.content.
      bridge.handle(
        typedAssistantMessage(
          [{ type: "tool_use", id: "tu-leak", name: "Bash", input: {} }],
          "tu-some-parent",
        ),
      );

      // Now segment IS ready (no pending tool_results expected).
      expect(bridge.isSegmentReady()).toBe(true);
      const seg = bridge.closeSegment();
      // The leaked tool_use was removed from output.content.
      expect(seg.content.find((c) => (c as any).id === "tu-leak")).toBeUndefined();
    });
  });

  describe("onUnknownToolName callback (catch-all stub plumbing)", () => {
    it("fires on a tool_use whose name is NOT in SUPPORTED_CC_TOOL_NAMES", () => {
      const calls: string[] = [];
      const bridge = createEventBridge(fakeModel, {
        onUnknownToolName: (name) => calls.push(name),
      });
      bridge.attachStream(createAssistantMessageEventStream(), fakeModel);
      bridge.handle(messageStart());
      bridge.handle(cbStartToolUse(0, "tu-1", "Task")); // <- not in supported set
      bridge.handle(cbStop(0));
      bridge.handle(messageDelta("tool_use"));
      bridge.handle(messageStop());
      bridge.handle(userToolResult("tu-1", "result"));
      bridge.closeSegment();
      expect(calls).toEqual(["Task"]);
    });

    it("does NOT fire on supported names like Bash/Read/etc", () => {
      const calls: string[] = [];
      const bridge = createEventBridge(fakeModel, {
        onUnknownToolName: (name) => calls.push(name),
      });
      bridge.attachStream(createAssistantMessageEventStream(), fakeModel);
      bridge.handle(messageStart());
      bridge.handle(cbStartToolUse(0, "tu-1", "Bash"));
      bridge.handle(cbStop(0));
      bridge.handle(cbStartToolUse(1, "tu-2", "Read"));
      bridge.handle(cbStop(1));
      bridge.handle(messageDelta("tool_use"));
      bridge.handle(messageStop());
      bridge.handle(userToolResult("tu-1", "a"));
      bridge.handle(userToolResult("tu-2", "b"));
      bridge.closeSegment();
      expect(calls).toEqual([]);
    });

    it("does NOT dedupe; provider is responsible (fires once per occurrence)", () => {
      // Per the EventBridgeOptions docstring contract: the bridge does no
      // deduping.  This test pins the contract so a future "optimization"
      // can't change semantics silently.
      const calls: string[] = [];
      const bridge = createEventBridge(fakeModel, {
        onUnknownToolName: (name) => calls.push(name),
      });
      bridge.attachStream(createAssistantMessageEventStream(), fakeModel);
      bridge.handle(messageStart());
      bridge.handle(cbStartToolUse(0, "tu-1", "Task"));
      bridge.handle(cbStop(0));
      bridge.handle(cbStartToolUse(1, "tu-2", "Task")); // same name again
      bridge.handle(cbStop(1));
      bridge.handle(messageDelta("tool_use"));
      bridge.handle(messageStop());
      bridge.handle(userToolResult("tu-1", "a"));
      bridge.handle(userToolResult("tu-2", "b"));
      bridge.closeSegment();
      expect(calls).toEqual(["Task", "Task"]);
    });

    it("a throw in the callback is caught and logged; segment processing continues", () => {
      // We don't want a misbehaving provider hook to corrupt the segment.
      const bridge = createEventBridge(fakeModel, {
        onUnknownToolName: () => {
          throw new Error("boom");
        },
      });
      bridge.attachStream(createAssistantMessageEventStream(), fakeModel);
      bridge.handle(messageStart());
      // Should not throw out of bridge.handle:
      expect(() => bridge.handle(cbStartToolUse(0, "tu-1", "Task"))).not.toThrow();
      bridge.handle(cbStop(0));
      bridge.handle(messageDelta("tool_use"));
      bridge.handle(messageStop());
      bridge.handle(userToolResult("tu-1", "ok"));
      expect(bridge.isSegmentReady()).toBe(true);
    });

    it("works without an onUnknownToolName callback (backward compatible default)", () => {
      const bridge = createEventBridge(fakeModel); // no options arg at all
      bridge.attachStream(createAssistantMessageEventStream(), fakeModel);
      bridge.handle(messageStart());
      expect(() => bridge.handle(cbStartToolUse(0, "tu-1", "Task"))).not.toThrow();
      bridge.handle(cbStop(0));
      bridge.handle(messageDelta("tool_use"));
      bridge.handle(messageStop());
      bridge.handle(userToolResult("tu-1", "ok"));
      expect(bridge.isSegmentReady()).toBe(true);
    });
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
