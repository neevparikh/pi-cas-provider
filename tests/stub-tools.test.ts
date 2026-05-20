/**
 * Unit tests for stub tools.
 *
 * Validates:
 *   - Each CC tool name in SUPPORTED_CC_TOOL_NAMES has a corresponding stub.
 *   - Stub execute() pulls the cached result by toolCallId.
 *   - Cache miss returns a clearly-marked error entry (defensive — should
 *     not happen in normal flow, but we don't want to throw).
 *   - isError flag from the cache is stuffed into details._piCasIsError so
 *     the provider's tool_result event handler can propagate it.
 *   - Side effect: execute() does NOT have any I/O — it only reads from
 *     the cache.  We verify this implicitly by not stubbing fs/spawn.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  SUPPORTED_CC_TOOL_NAMES,
  createStubTools,
  createGenericStub,
  isSupportedStubTool,
  isValidDynamicToolName,
} from "../src/stub-tools.js";
import { put, clear, type CachedToolResult } from "../src/tool-result-cache.js";

describe("stub-tools", () => {
  beforeEach(() => clear());

  it("exposes a stub for every supported CC tool name", () => {
    const stubs = createStubTools();
    expect(stubs.map((t) => t.name).sort()).toEqual([...SUPPORTED_CC_TOOL_NAMES].sort());
  });

  it("isSupportedStubTool recognizes CC names only", () => {
    expect(isSupportedStubTool("Bash")).toBe(true);
    expect(isSupportedStubTool("Read")).toBe(true);
    expect(isSupportedStubTool("bash")).toBe(false); // lowercase — pi's built-in
    expect(isSupportedStubTool("WebFetch")).toBe(false); // not stubbed
    expect(isSupportedStubTool("")).toBe(false);
  });

  it("execute() returns cached content and details", async () => {
    const cached: CachedToolResult = {
      content: [{ type: "text", text: "hello world" }],
      isError: false,
      toolName: "Bash",
      details: { stdout: "hello world", stderr: "" },
    };
    put("tu-1", cached);
    const bash = createStubTools().find((t) => t.name === "Bash")!;
    const result = await bash.execute("tu-1", { command: "echo hello" }, undefined, undefined, {} as any);
    expect(result.content).toEqual([{ type: "text", text: "hello world" }]);
    expect((result.details as any).stdout).toBe("hello world");
    // _piCasIsError flag should be present and false:
    expect((result.details as any)._piCasIsError).toBe(false);
  });

  it("execute() propagates isError into details._piCasIsError", async () => {
    put("tu-err", {
      content: [{ type: "text", text: "exit 7" }],
      isError: true,
      toolName: "Bash",
      details: "Error: Exit code 7",
    });
    const bash = createStubTools().find((t) => t.name === "Bash")!;
    const result = await bash.execute("tu-err", {}, undefined, undefined, {} as any);
    expect((result.details as any)._piCasIsError).toBe(true);
  });

  it("execute() removes the entry from cache (one-shot)", async () => {
    put("tu-1", {
      content: [{ type: "text", text: "x" }],
      isError: false,
      toolName: "Bash",
      details: {},
    });
    const bash = createStubTools().find((t) => t.name === "Bash")!;
    await bash.execute("tu-1", {}, undefined, undefined, {} as any);
    // Second call should now hit the defensive cache-miss path.
    const second = await bash.execute("tu-1", {}, undefined, undefined, {} as any);
    expect((second.details as any)?._piCasStubError).toBe("cache-miss");
  });

  it("execute() with cache miss returns a clearly-marked error result with _piCasIsError=true", async () => {
    const read = createStubTools().find((t) => t.name === "Read")!;
    const result = await read.execute("never-cached", { file_path: "/tmp/foo" }, undefined, undefined, {} as any);
    expect(result.content[0]).toMatchObject({ type: "text" });
    expect((result.content[0] as any).text).toMatch(/no cached result/i);
    expect((result.details as any)._piCasStubError).toBe("cache-miss");
    // Cache miss MUST propagate as an error so the provider's tool_result
    // handler sets isError on pi's ToolResultMessage — otherwise an internal
    // failure is silently rendered as a successful tool execution.
    expect((result.details as any)._piCasIsError).toBe(true);
  });

  it("execute() preserves a string SDK details payload under _piCasToolUseResult", async () => {
    // SDK reports some Bash failures with a plain string for tool_use_result
    // (e.g. "Error: Exit code 7").  Spreading a string would corrupt it into
    // {0:"E", 1:"r", ...}, so the stub puts it under a named field instead.
    put("tu-strerr", {
      content: [{ type: "text", text: "failed" }],
      isError: true,
      toolName: "Bash",
      details: "Error: Exit code 7",
    });
    const bash = createStubTools().find((t) => t.name === "Bash")!;
    const result = await bash.execute("tu-strerr", {}, undefined, undefined, {} as any);
    expect((result.details as any)._piCasToolUseResult).toBe("Error: Exit code 7");
    expect((result.details as any)._piCasIsError).toBe(true);
    // The string should NOT have been spread into numeric character keys.
    expect((result.details as any)["0"]).toBeUndefined();
  });

  it("execute() spreads structured SDK details (object) into pi details", async () => {
    put("tu-bash", {
      content: [{ type: "text", text: "ok" }],
      isError: false,
      toolName: "Bash",
      details: {
        stdout: "hello",
        stderr: "",
        interrupted: false,
        isImage: false,
        noOutputExpected: false,
      },
    });
    const bash = createStubTools().find((t) => t.name === "Bash")!;
    const result = await bash.execute("tu-bash", {}, undefined, undefined, {} as any);
    expect((result.details as any).stdout).toBe("hello");
    expect((result.details as any).stderr).toBe("");
    expect((result.details as any)._piCasIsError).toBe(false);
    // Should NOT have a _piCasToolUseResult field when we successfully spread.
    expect((result.details as any)._piCasToolUseResult).toBeUndefined();
  });

  describe("createGenericStub (catch-all)", () => {
    it("creates a stub with the given name and pulls cached results just like named stubs", async () => {
      const stub = createGenericStub("Task");
      expect(stub.name).toBe("Task");
      // Loose schema — accepts arbitrary arguments without validation.
      put("tu-task", {
        content: [{ type: "text", text: "subagent completed" }],
        isError: false,
        toolName: "Task",
        details: { result: "done" },
      });
      const result = await stub.execute(
        "tu-task",
        { description: "do thing", prompt: "go" } as any,
        undefined,
        undefined,
        {} as any,
      );
      expect(result.content).toEqual([{ type: "text", text: "subagent completed" }]);
      expect((result.details as any).result).toBe("done");
      expect((result.details as any)._piCasIsError).toBe(false);
      expect((result.details as any)._piCasToolName).toBe("Task");
    });

    it("cache miss path returns the same defensive error shape as named stubs", async () => {
      const stub = createGenericStub("WebFetch");
      const result = await stub.execute("never-cached", { url: "x" } as any, undefined, undefined, {} as any);
      expect((result.details as any)._piCasStubError).toBe("cache-miss");
      expect((result.details as any)._piCasIsError).toBe(true);
      expect((result.content[0] as any).text).toMatch(/no cached result for WebFetch/i);
    });

    it("conservative executionMode='sequential' (we don't know if the unknown tool is side-effecting)", () => {
      const stub = createGenericStub("UnknownThing");
      expect(stub.executionMode).toBe("sequential");
    });

    it("label / description make clear this is a dynamic stub", () => {
      const stub = createGenericStub("Foo");
      expect(stub.label).toMatch(/dynamic stub/i);
      expect(stub.description).toMatch(/catch-all/i);
    });

    it("rejects invalid tool names with a clear error", () => {
      expect(() => createGenericStub("")).toThrow(/invalid tool name/i);
      expect(() => createGenericStub("has space")).toThrow(/invalid tool name/i);
      expect(() => createGenericStub("starts-with-dash")).toThrow(/invalid tool name/i);
      // The provider should also validate before calling, but defense in depth.
    });
  });

  describe("isValidDynamicToolName", () => {
    it("accepts PascalCase CC built-in shapes", () => {
      expect(isValidDynamicToolName("Bash")).toBe(true);
      expect(isValidDynamicToolName("Task")).toBe(true);
      expect(isValidDynamicToolName("WebFetch")).toBe(true);
      expect(isValidDynamicToolName("NotebookEdit")).toBe(true);
    });
    it("accepts MCP server tool naming (mcp__server__tool)", () => {
      expect(isValidDynamicToolName("mcp__workspace__bash")).toBe(true);
      expect(isValidDynamicToolName("a_b_c_d")).toBe(true);
    });
    it("rejects empty / whitespace / punctuation / too long", () => {
      expect(isValidDynamicToolName("")).toBe(false);
      expect(isValidDynamicToolName(" ")).toBe(false);
      expect(isValidDynamicToolName("a b")).toBe(false);
      expect(isValidDynamicToolName("foo-bar")).toBe(false);
      expect(isValidDynamicToolName("foo/bar")).toBe(false);
      expect(isValidDynamicToolName("foo.bar")).toBe(false);
      expect(isValidDynamicToolName("1Bash")).toBe(false); // must start with letter
      expect(isValidDynamicToolName("a".repeat(129))).toBe(false);
      // non-string defensive
      expect(isValidDynamicToolName(undefined as unknown as string)).toBe(false);
      expect(isValidDynamicToolName(null as unknown as string)).toBe(false);
    });
  });

  it("each stub has the right executionMode", () => {
    const stubs = Object.fromEntries(createStubTools().map((t) => [t.name, t]));
    // Side-effecting tools: sequential
    expect(stubs.Bash.executionMode).toBe("sequential");
    expect(stubs.Write.executionMode).toBe("sequential");
    expect(stubs.Edit.executionMode).toBe("sequential");
    // Read-only: parallel
    expect(stubs.Read.executionMode).toBe("parallel");
    expect(stubs.Grep.executionMode).toBe("parallel");
    expect(stubs.Glob.executionMode).toBe("parallel");
  });
});
