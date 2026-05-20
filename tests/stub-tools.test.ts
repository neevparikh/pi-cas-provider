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
  isSupportedStubTool,
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

  it("execute() with cache miss returns a clearly-marked error result", async () => {
    const read = createStubTools().find((t) => t.name === "Read")!;
    const result = await read.execute("never-cached", { file_path: "/tmp/foo" }, undefined, undefined, {} as any);
    expect(result.content[0]).toMatchObject({ type: "text" });
    expect((result.content[0] as any).text).toMatch(/no cached result/i);
    expect((result.details as any)._piCasStubError).toBe("cache-miss");
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
