/**
 * Unit tests for the tool-result cache.
 *
 * Verifies one-shot semantics: each `take()` consumes the entry; subsequent
 * `take()` of the same id returns undefined.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  put,
  take,
  has,
  clear,
  size,
  type CachedToolResult,
} from "../src/tool-result-cache.js";

function entry(text: string, isError = false): CachedToolResult {
  return {
    content: [{ type: "text", text }],
    isError,
    toolName: "Bash",
    details: { stdout: text },
  };
}

describe("tool-result-cache", () => {
  beforeEach(() => clear());

  it("put/take round-trips a single entry", () => {
    put("id-1", entry("hello"));
    expect(has("id-1")).toBe(true);
    const got = take("id-1");
    expect(got?.content[0]).toEqual({ type: "text", text: "hello" });
    expect(got?.isError).toBe(false);
  });

  it("take removes the entry (one-shot)", () => {
    put("id-1", entry("hello"));
    expect(take("id-1")).toBeDefined();
    expect(has("id-1")).toBe(false);
    expect(take("id-1")).toBeUndefined();
  });

  it("returns undefined for unknown ids", () => {
    expect(take("nope")).toBeUndefined();
    expect(has("nope")).toBe(false);
  });

  it("handles many concurrent entries (no cross-talk)", () => {
    put("a", entry("A"));
    put("b", entry("B", true));
    put("c", entry("C"));
    expect(size()).toBe(3);
    expect(take("b")?.isError).toBe(true);
    expect(take("a")?.content[0]).toEqual({ type: "text", text: "A" });
    expect(take("c")?.content[0]).toEqual({ type: "text", text: "C" });
    expect(size()).toBe(0);
  });

  it("clear() drops all entries", () => {
    put("a", entry("A"));
    put("b", entry("B"));
    expect(size()).toBe(2);
    clear();
    expect(size()).toBe(0);
    expect(has("a")).toBe(false);
  });

  it("preserves details payload (structured tool_use_result)", () => {
    const details = {
      stdout: "ok",
      stderr: "",
      interrupted: false,
      isImage: false,
      noOutputExpected: false,
    };
    put("id-1", {
      content: [{ type: "text", text: "ok" }],
      isError: false,
      toolName: "Bash",
      details,
    });
    expect(take("id-1")?.details).toEqual(details);
  });
});
