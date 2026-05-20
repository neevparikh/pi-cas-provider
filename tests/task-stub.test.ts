/**
 * Unit tests for the Task stub.
 *
 * The renderer is hard to assert against without running a TUI, so we
 * focus on:
 *   - Tool definition shape (name, schema, executionMode, has renderResult).
 *   - execute() delegates to executeStub and surfaces cached content +
 *     details (including any `_piCasSubagentTranscript` attached by the
 *     bridge).
 *   - `formatToolCall` helper produces stable strings for known tool
 *     names.
 */

import { beforeEach, describe, expect, it } from "vitest";

import { clear as clearCache, put } from "../src/tool-result-cache.js";
import { createTaskStub, TASK_TOOL_NAME } from "../src/task-stub.js";
import { formatToolCall } from "../src/stub-tools.js";

const noopTheme = {
  fg: (_color: any, text: string) => text,
  bold: (text: string) => text,
};

describe("task-stub", () => {
  beforeEach(() => clearCache());

  it("registers as the Task tool with the expected shape", () => {
    const stub = createTaskStub();
    expect(stub.name).toBe(TASK_TOOL_NAME);
    expect(stub.label).toMatch(/Task/);
    expect(stub.description).toMatch(/subagent/i);
    expect(stub.executionMode).toBe("sequential");
    expect(typeof stub.renderResult).toBe("function");
    expect(typeof stub.renderCall).toBe("function");
  });

  it("execute() returns the cached content + details (with subagent transcript when present)", async () => {
    const transcript = {
      parentToolUseId: "tu-task",
      subagentType: "Explore",
      messages: [],
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, turns: 0 },
      finalStatus: "completed" as const,
    };
    put("tu-task", {
      content: [{ type: "text", text: "subagent summary" }],
      isError: false,
      toolName: "Task",
      details: { _piCasSubagentTranscript: transcript, other: "fields" },
    });
    const stub = createTaskStub();
    const result = await stub.execute(
      "tu-task",
      { description: "do thing", prompt: "go", subagent_type: "Explore" } as any,
      undefined,
      undefined,
      {} as any,
    );
    expect(result.content).toEqual([{ type: "text", text: "subagent summary" }]);
    const d = result.details as Record<string, unknown>;
    expect(d._piCasSubagentTranscript).toBe(transcript);
    expect(d.other).toBe("fields"); // spread of existing details
    expect(d._piCasIsError).toBe(false);
    expect(d._piCasToolName).toBe("Task");
  });

  it("execute() cache miss returns the same defensive shape as named stubs (isError flag set)", async () => {
    const stub = createTaskStub();
    const result = await stub.execute("never-cached", {} as any, undefined, undefined, {} as any);
    expect((result.details as any)._piCasStubError).toBe("cache-miss");
    expect((result.details as any)._piCasIsError).toBe(true);
  });

  it("renderCall returns a Component (not assertable visually; smoke test)", () => {
    const stub = createTaskStub();
    const comp = stub.renderCall!(
      { description: "do thing", subagent_type: "Explore" } as any,
      noopTheme as any,
      {} as any,
    );
    expect(comp).toBeDefined();
  });

  it("renderResult with no transcript still returns a Component (fallback path)", () => {
    const stub = createTaskStub();
    const comp = stub.renderResult!(
      {
        content: [{ type: "text", text: "raw summary" }],
        details: {},
      },
      { expanded: false, isPartial: false },
      noopTheme as any,
      {} as any,
    );
    expect(comp).toBeDefined();
  });

  it("renderResult with a transcript returns a Component (both collapsed + expanded)", () => {
    const stub = createTaskStub();
    const transcript = {
      parentToolUseId: "tu-task",
      subagentType: "Explore",
      taskPrompt: "find X",
      description: "Search",
      messages: [
        {
          role: "assistant" as const,
          content: [
            { type: "text", text: "let me look" } as any,
            { type: "toolCall", id: "tu-1", name: "Bash", arguments: { command: "ls" } } as any,
          ],
        },
        {
          role: "toolResult" as const,
          toolCallId: "tu-1",
          content: [{ type: "text", text: "file1\nfile2" } as any],
          isError: false,
        },
        {
          role: "assistant" as const,
          content: [{ type: "text", text: "Found 2 files" } as any],
        },
      ],
      usage: { input: 50, output: 30, cacheRead: 0, cacheWrite: 0, total: 0.001, turns: 2 },
      finalStatus: "completed" as const,
      model: "claude-sonnet-4-5",
    };
    const result = {
      content: [{ type: "text", text: "summary" }],
      details: { _piCasSubagentTranscript: transcript },
    };
    const collapsed = stub.renderResult!(
      result as any,
      { expanded: false, isPartial: false },
      noopTheme as any,
      {} as any,
    );
    const expanded = stub.renderResult!(
      result as any,
      { expanded: true, isPartial: false },
      noopTheme as any,
      {} as any,
    );
    expect(collapsed).toBeDefined();
    expect(expanded).toBeDefined();
  });
});

describe("formatToolCall", () => {
  it("renders Bash as `$ <command>` with truncation past 60 chars", () => {
    const s = formatToolCall("Bash", { command: "echo hello" }, noopTheme);
    expect(s).toContain("$ ");
    expect(s).toContain("echo hello");
    const long = "x".repeat(200);
    const ls = formatToolCall("Bash", { command: long }, noopTheme);
    expect(ls).toContain("...");
  });

  // Note: the formatter renders ONLY the input (file path, command, URL,
  // etc.) — not the tool name.  Pi already displays the tool's label on its
  // own line (e.g. "Bash (claude-code)"); duplicating it here would be noise.

  it("renders Read with file path (and optional offset/limit annotation)", () => {
    const s = formatToolCall("Read", { file_path: "/tmp/foo.txt" }, noopTheme);
    expect(s).toContain("/tmp/foo.txt");
    const s2 = formatToolCall("Read", { file_path: "/tmp/x", offset: 10, limit: 5 }, noopTheme);
    expect(s2).toMatch(/:10-14/);
  });

  it("renders Write with line count when content has > 1 line", () => {
    const s = formatToolCall("Write", { file_path: "/tmp/x", content: "a\nb\nc" }, noopTheme);
    expect(s).toContain("/tmp/x");
    expect(s).toContain("3 lines");
  });

  it("renders Edit with file path and optional old_string preview", () => {
    const s = formatToolCall("Edit", { file_path: "/tmp/x" }, noopTheme);
    expect(s).toContain("/tmp/x");
    const s2 = formatToolCall(
      "Edit",
      { file_path: "/tmp/x", old_string: "const foo = 1", replace_all: true },
      noopTheme,
    );
    expect(s2).toContain("/tmp/x");
    expect(s2).toContain("const foo = 1");
    expect(s2).toContain("(all)");
  });

  it("renders Grep as `/pattern/ in <path>`", () => {
    const s = formatToolCall("Grep", { pattern: "foo", path: "/tmp" }, noopTheme);
    expect(s).toContain("/foo/");
    expect(s).toContain("/tmp");
  });

  it("renders Glob with pattern", () => {
    const s = formatToolCall("Glob", { pattern: "*.ts" }, noopTheme);
    expect(s).toContain("*.ts");
  });

  it("renders nested Task with subagent type + description", () => {
    const s = formatToolCall(
      "Task",
      { subagent_type: "Explore", description: "find stuff" },
      noopTheme,
    );
    expect(s).toContain("Explore");
    expect(s).toContain("find stuff");
  });

  it("renders Agent like Task (subagent dispatcher alias)", () => {
    const s = formatToolCall(
      "Agent",
      { subagent_type: "Explore", description: "find stuff" },
      noopTheme,
    );
    expect(s).toContain("Explore");
    expect(s).toContain("find stuff");
  });

  it("renders WebFetch with URL", () => {
    const s = formatToolCall("WebFetch", { url: "https://example.com" }, noopTheme);
    expect(s).toContain("https://example.com");
  });

  it("renders WebSearch with quoted query", () => {
    const s = formatToolCall("WebSearch", { query: "claude code" }, noopTheme);
    expect(s).toContain("\"claude code\"");
  });

  it("renders AskUserQuestion with first question + count of additional", () => {
    const s = formatToolCall(
      "AskUserQuestion",
      {
        questions: [
          { question: "Which library?" },
          { question: "Which approach?" },
          { question: "Which timeout?" },
        ],
      },
      noopTheme,
    );
    expect(s).toContain("Which library?");
    expect(s).toContain("+2 more");
  });

  it("renders TodoWrite with todo count + in_progress count", () => {
    const s = formatToolCall(
      "TodoWrite",
      {
        todos: [
          { status: "completed" },
          { status: "completed" },
          { status: "in_progress" },
          { status: "pending" },
        ],
      },
      noopTheme,
    );
    expect(s).toContain("4 todos");
    expect(s).toContain("1 in_progress");
    expect(s).toContain("2 done");
  });

  it("falls back to JSON preview for unknown tool names", () => {
    const s = formatToolCall("SomeNovelTool", { foo: "bar", n: 42 }, noopTheme);
    expect(s).toContain("foo");
    expect(s).toContain("bar");
    expect(s).toContain("42");
  });

  describe("defensive rendering for partial/weird args (no crashes)", () => {
    // During streaming, `arguments` starts as `{}` and is re-parsed on each
    // input_json_delta.  Some intermediate parses can leave values in weird
    // shapes — e.g. `questions` as a string if the model briefly emits a
    // stringified subobject.  These tests pin the contract that the
    // renderer NEVER throws and NEVER produces nonsensical output like
    // `(+335 more)` from a string length.

    it("AskUserQuestion: handles questions=undefined", () => {
      const s = formatToolCall("AskUserQuestion", {}, noopTheme);
      expect(s).not.toMatch(/\+\d+ more/);
      expect(s).toMatch(/no questions/);
    });

    it("AskUserQuestion: handles questions as a string (NOT an array)", () => {
      // This is the shape that caused the original `(+335 more)` bug — a
      // 336-char string that the model emitted as the questions value
      // before streaming completed.
      const stringy = "x".repeat(336);
      const s = formatToolCall("AskUserQuestion", { questions: stringy }, noopTheme);
      expect(s).not.toMatch(/\+\d+ more/);
      // Should fall back to "no questions" since it's not an array.
      expect(s).toMatch(/no questions/);
    });

    it("AskUserQuestion: handles questions as an empty array", () => {
      const s = formatToolCall("AskUserQuestion", { questions: [] }, noopTheme);
      expect(s).toMatch(/no questions/);
    });

    it("AskUserQuestion: handles questions[0] missing the question field", () => {
      const s = formatToolCall("AskUserQuestion", { questions: [{}, {}] }, noopTheme);
      // First question text is empty — should show streaming placeholder + count.
      expect(s).toMatch(/streaming/);
      expect(s).toMatch(/\+1 more/);
    });

    it("AskUserQuestion: handles questions[0] as a string (not an object)", () => {
      const s = formatToolCall(
        "AskUserQuestion",
        { questions: ["foo", "bar"] },
        noopTheme,
      );
      // questions[0] is a string — isObj fails, falls back gracefully.
      expect(s).toMatch(/streaming|no questions/);
      // Should NOT crash or produce numeric character keys.
    });

    it("TodoWrite: handles todos=undefined / wrong shape", () => {
      expect(formatToolCall("TodoWrite", {}, noopTheme)).toMatch(/0 todos/);
      expect(formatToolCall("TodoWrite", { todos: "x" }, noopTheme)).toMatch(/0 todos/);
      expect(formatToolCall("TodoWrite", { todos: ["str", null] }, noopTheme)).toMatch(/2 todos/);
    });

    it("all tools: tolerate args being null / string / array / undefined", () => {
      // Every tool name should produce SOME string output without throwing,
      // even when args isn't a plain object.
      const names = [
        "Bash",
        "Read",
        "Write",
        "Edit",
        "Grep",
        "Glob",
        "WebFetch",
        "WebSearch",
        "NotebookEdit",
        "TodoWrite",
        "AskUserQuestion",
        "PushNotification",
        "ExitPlanMode",
        "EnterPlanMode",
        "Skill",
        "ScheduleWakeup",
        "Monitor",
        "CronCreate",
        "CronDelete",
        "CronList",
        "EnterWorktree",
        "ExitWorktree",
        "TaskCreate",
        "TaskGet",
        "TaskList",
        "TaskUpdate",
        "TaskStop",
        "TaskOutput",
        "Task",
        "Agent",
        "SomeUnknownTool",
      ];
      for (const weird of [undefined, null, "a string", [], ["x"], 42]) {
        for (const name of names) {
          expect(() => formatToolCall(name, weird as unknown, noopTheme)).not.toThrow();
        }
      }
    });
  });

  it("home directory paths are shortened to ~", () => {
    const home = process.env.HOME ?? "";
    if (!home) return; // skip in unusual environments
    const s = formatToolCall("Read", { file_path: `${home}/foo.txt` }, noopTheme);
    expect(s).toContain("~/foo.txt");
  });
});
