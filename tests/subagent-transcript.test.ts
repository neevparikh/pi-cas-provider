/**
 * Unit tests for the subagent transcript collector.
 *
 * These exercise the pure-data layer: start/append/peek/take/clear.  The
 * integration with the bridge (when subagent typed events are converted
 * into transcript appends) and the rendering (Task stub `renderResult`)
 * are covered separately in `tests/event-bridge.test.ts` and by visual
 * inspection respectively.
 */

import { beforeEach, describe, expect, it } from "vitest";

import {
  appendAssistant,
  appendToolResult,
  clear,
  markFinished,
  peek,
  recordProgress,
  size,
  start,
  take,
} from "../src/subagent-transcript.js";

describe("subagent-transcript", () => {
  beforeEach(() => clear());

  it("start() creates a transcript with the given metadata", () => {
    const t = start("tu-1", {
      subagentType: "Explore",
      taskPrompt: "find X",
      description: "Search task",
      taskId: "task-A",
    });
    expect(t.parentToolUseId).toBe("tu-1");
    expect(t.subagentType).toBe("Explore");
    expect(t.taskPrompt).toBe("find X");
    expect(t.description).toBe("Search task");
    expect(t.taskId).toBe("task-A");
    expect(t.messages).toEqual([]);
    expect(t.usage).toEqual({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
      turns: 0,
    });
  });

  it("start() is idempotent: re-calling with the same id merges metadata", () => {
    const a = start("tu-1", { subagentType: "Explore" });
    const b = start("tu-1", { taskPrompt: "find X" });
    expect(a).toBe(b); // same object
    expect(b.subagentType).toBe("Explore");
    expect(b.taskPrompt).toBe("find X");
  });

  it("appendAssistant() maps Anthropic content to pi shape and accumulates usage", () => {
    appendAssistant(
      "tu-1",
      [
        { type: "text", text: "thinking out loud" },
        { type: "thinking", thinking: "internal", signature: "sig" },
        { type: "tool_use", id: "tu-inner-1", name: "Bash", input: { command: "ls" } },
      ],
      {
        input: 100,
        output: 50,
        cacheRead: 10,
        cacheWrite: 5,
        totalTokens: 165,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 },
      },
      "claude-sonnet-4-5",
      "tool_use" as any,
    );
    const t = peek("tu-1")!;
    expect(t.messages.length).toBe(1);
    const m = t.messages[0];
    if (m.role !== "assistant") throw new Error("expected assistant message");
    expect(m.content[0]).toMatchObject({ type: "text", text: "thinking out loud" });
    expect(m.content[1]).toMatchObject({
      type: "thinking",
      thinking: "internal",
      thinkingSignature: "sig",
    });
    expect(m.content[2]).toMatchObject({
      type: "toolCall",
      id: "tu-inner-1",
      name: "Bash",
      arguments: { command: "ls" },
    });
    expect(t.model).toBe("claude-sonnet-4-5");
    expect(t.usage.turns).toBe(1);
    expect(t.usage.input).toBe(100);
    expect(t.usage.output).toBe(50);
    expect(t.usage.cacheRead).toBe(10);
    expect(t.usage.cacheWrite).toBe(5);
    expect(t.usage.total).toBeCloseTo(0.01);
    expect(t.usage.contextTokens).toBe(165);
  });

  it("appendAssistant() called multiple times accumulates turns and usage", () => {
    appendAssistant(
      "tu-1",
      [{ type: "text", text: "turn 1" }],
      { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.001 } },
      "model-a",
      undefined,
    );
    appendAssistant(
      "tu-1",
      [{ type: "text", text: "turn 2" }],
      { input: 20, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 30, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.002 } },
      undefined,
      undefined,
    );
    const t = peek("tu-1")!;
    expect(t.messages.length).toBe(2);
    expect(t.usage.turns).toBe(2);
    expect(t.usage.input).toBe(30);
    expect(t.usage.output).toBe(15);
    expect(t.usage.total).toBeCloseTo(0.003);
    expect(t.model).toBe("model-a"); // first one sets it; subsequent missing models don't overwrite
  });

  it("appendAssistant() implicitly ensures a transcript exists when start() wasn't called", () => {
    appendAssistant("tu-late", [{ type: "text", text: "hello" }], undefined, undefined, undefined);
    const t = peek("tu-late");
    expect(t).toBeDefined();
    expect(t!.messages.length).toBe(1);
    expect(t!.subagentType).toBeUndefined();
  });

  it("appendAssistant() with no content and no usage is dropped (no message appended)", () => {
    start("tu-1", {});
    appendAssistant("tu-1", [], undefined, undefined, undefined);
    expect(peek("tu-1")!.messages).toEqual([]);
  });

  it("appendToolResult() captures the block with details", () => {
    appendToolResult(
      "tu-1",
      { type: "tool_result", tool_use_id: "tu-inner", content: "result text", is_error: false },
      { stdout: "result text", stderr: "" },
    );
    const t = peek("tu-1")!;
    expect(t.messages.length).toBe(1);
    const m = t.messages[0];
    if (m.role !== "toolResult") throw new Error("expected toolResult");
    expect(m.toolCallId).toBe("tu-inner");
    expect(m.content).toEqual([{ type: "text", text: "result text" }]);
    expect(m.isError).toBe(false);
    expect(m.details).toEqual({ stdout: "result text", stderr: "" });
  });

  it("appendToolResult() with is_error=true preserves the flag", () => {
    appendToolResult(
      "tu-1",
      { type: "tool_result", tool_use_id: "tu-err", content: "boom", is_error: true },
      "Error: Exit code 7",
    );
    const t = peek("tu-1")!;
    const m = t.messages[0];
    if (m.role !== "toolResult") throw new Error("expected toolResult");
    expect(m.isError).toBe(true);
    expect(m.details).toBe("Error: Exit code 7");
  });

  it("appendToolResult() normalizes array content (text + image)", () => {
    appendToolResult(
      "tu-1",
      {
        type: "tool_result",
        tool_use_id: "tu-mixed",
        content: [
          { type: "text", text: "see image:" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "ABC" } },
        ],
        is_error: false,
      },
      undefined,
    );
    const t = peek("tu-1")!;
    const m = t.messages[0];
    if (m.role !== "toolResult") throw new Error("expected toolResult");
    expect(m.content[0]).toEqual({ type: "text", text: "see image:" });
    expect(m.content[1]).toMatchObject({ type: "image", mimeType: "image/png", data: "ABC" });
  });

  it("appendToolResult() ignores malformed blocks (wrong type / missing tool_use_id)", () => {
    appendToolResult("tu-1", { type: "text", text: "not a tool result" }, undefined);
    appendToolResult("tu-1", { type: "tool_result", content: "no id" }, undefined);
    expect(size()).toBe(0); // ensure() never fired
  });

  it("recordProgress() updates the running UI metadata", () => {
    start("tu-1", {});
    recordProgress("tu-1", { summary: "looking", lastToolName: "Grep" });
    const t = peek("tu-1")!;
    expect(t.progressSummary).toBe("looking");
    expect(t.lastToolName).toBe("Grep");
    // subagentType is backfilled only if not already set:
    recordProgress("tu-1", { subagentType: "Explore" });
    expect(peek("tu-1")!.subagentType).toBe("Explore");
    recordProgress("tu-1", { subagentType: "OtherType" });
    expect(peek("tu-1")!.subagentType).toBe("Explore"); // unchanged once set
  });

  it("markFinished() records final status + summary", () => {
    start("tu-1", {});
    markFinished("tu-1", { status: "completed", summary: "done" });
    const t = peek("tu-1")!;
    expect(t.finalStatus).toBe("completed");
    expect(t.finalSummary).toBe("done");
  });

  it("take() removes and returns the transcript", () => {
    start("tu-1", { subagentType: "Explore" });
    appendAssistant("tu-1", [{ type: "text", text: "x" }], undefined, undefined, undefined);
    const t = take("tu-1");
    expect(t).toBeDefined();
    expect(t!.subagentType).toBe("Explore");
    expect(peek("tu-1")).toBeUndefined();
    expect(size()).toBe(0);
  });

  it("take() on a non-existent id returns undefined and is a no-op", () => {
    expect(take("never-existed")).toBeUndefined();
  });

  it("clear() drops all in-flight transcripts", () => {
    start("tu-1", {});
    start("tu-2", {});
    expect(size()).toBe(2);
    clear();
    expect(size()).toBe(0);
  });
});
