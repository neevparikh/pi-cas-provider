import { describe, it, expect } from "vitest";
import { claudeToPi, piToClaude } from "../src/tool-shim.js";

describe("claudeToPi (model emits → pi receives)", () => {
  it("Read renames file_path → path", () => {
    expect(claudeToPi("Read", { file_path: "/x/y.ts", offset: 0, limit: 10 })).toEqual({
      name: "read",
      arguments: { path: "/x/y.ts", offset: 0, limit: 10 },
    });
  });

  it("Write renames file_path → path", () => {
    expect(claudeToPi("Write", { file_path: "/x.txt", content: "hi" })).toEqual({
      name: "write",
      arguments: { path: "/x.txt", content: "hi" },
    });
  });

  it("Edit wraps single old_string/new_string into edits[] array", () => {
    const out = claudeToPi("Edit", {
      file_path: "/x.ts",
      old_string: "foo",
      new_string: "bar",
    });
    expect(out.name).toBe("edit");
    expect(out.arguments).toEqual({
      path: "/x.ts",
      edits: [{ oldText: "foo", newText: "bar" }],
    });
  });

  it("Edit drops replace_all silently (system prompt informs the model)", () => {
    const out = claudeToPi("Edit", {
      file_path: "/x.ts",
      old_string: "foo",
      new_string: "bar",
      replace_all: true,
    });
    expect((out.arguments as any).replace_all).toBeUndefined();
  });

  it("Bash converts large timeouts from ms to seconds", () => {
    const out = claudeToPi("Bash", { command: "sleep 1", timeout: 5000 });
    expect(out.arguments).toEqual({ command: "sleep 1", timeout: 5 });
  });

  it("Bash keeps small timeouts as-is (already in seconds)", () => {
    const out = claudeToPi("Bash", { command: "sleep 1", timeout: 30 });
    expect(out.arguments).toEqual({ command: "sleep 1", timeout: 30 });
  });

  it("Bash drops run_in_background, description, dangerouslyDisableSandbox", () => {
    const out = claudeToPi("Bash", {
      command: "ls",
      description: "List files",
      run_in_background: true,
      dangerouslyDisableSandbox: true,
    });
    expect(out.arguments).toEqual({ command: "ls" });
  });

  it("Grep renames -i → ignoreCase and head_limit → limit", () => {
    expect(claudeToPi("Grep", {
      pattern: "foo", "-i": true, head_limit: 50,
    })).toEqual({
      name: "grep",
      arguments: { pattern: "foo", ignoreCase: true, limit: 50 },
    });
  });

  it("Grep collapses -C and context to context (-C wins)", () => {
    expect(claudeToPi("Grep", {
      pattern: "x", "-C": 3, context: 5,
    })).toEqual({
      name: "grep",
      arguments: { pattern: "x", context: 3 },
    });
  });

  it("Grep drops unsupported CC-only options", () => {
    const out = claudeToPi("Grep", {
      pattern: "x",
      output_mode: "content",
      "-A": 2, "-B": 2, "-n": true, "-o": true,
      type: "ts", multiline: true, offset: 5,
    });
    // Only pattern survives (none of the others map)
    expect(out.arguments).toEqual({ pattern: "x" });
  });

  it("Glob maps to find, preserving args", () => {
    expect(claudeToPi("Glob", { pattern: "**/*.ts", path: "/x" })).toEqual({
      name: "find",
      arguments: { pattern: "**/*.ts", path: "/x" },
    });
  });

  it("MCP-prefixed custom tool strips the prefix", () => {
    expect(claudeToPi("mcp__pi-tools__weather", { city: "NYC" })).toEqual({
      name: "weather",
      arguments: { city: "NYC" },
    });
  });

  it("Unknown tool passes through unchanged", () => {
    expect(claudeToPi("FrobNitz", { x: 1 })).toEqual({
      name: "FrobNitz",
      arguments: { x: 1 },
    });
  });
});

describe("piToClaude (pi history → CC transcript)", () => {
  it("read → Read with file_path", () => {
    expect(piToClaude("read", { path: "/x.ts" })).toEqual({
      name: "Read",
      input: { file_path: "/x.ts" },
    });
  });

  it("edit single-edit array → CC's old_string/new_string", () => {
    expect(piToClaude("edit", {
      path: "/x.ts",
      edits: [{ oldText: "a", newText: "b" }],
    })).toEqual({
      name: "Edit",
      input: { file_path: "/x.ts", old_string: "a", new_string: "b" },
    });
  });

  it("edit with multiple edits collapses to first (best-effort historical rep)", () => {
    const out = piToClaude("edit", {
      path: "/x.ts",
      edits: [
        { oldText: "a", newText: "b" },
        { oldText: "c", newText: "d" },
      ],
    });
    expect(out.input).toEqual({ file_path: "/x.ts", old_string: "a", new_string: "b" });
  });

  it("bash converts seconds back to ms", () => {
    expect(piToClaude("bash", { command: "ls", timeout: 30 })).toEqual({
      name: "Bash",
      input: { command: "ls", timeout: 30000 },
    });
  });

  it("grep round-trips with -i and head_limit", () => {
    expect(piToClaude("grep", {
      pattern: "x", ignoreCase: true, limit: 25,
    })).toEqual({
      name: "Grep",
      input: { pattern: "x", "-i": true, head_limit: 25 },
    });
  });

  it("find drops limit (CC's Glob has no limit)", () => {
    expect(piToClaude("find", { pattern: "*.ts", path: "/x", limit: 100 })).toEqual({
      name: "Glob",
      input: { pattern: "*.ts", path: "/x" },
    });
  });

  it("custom pi tool maps to mcp__pi-tools__ prefix", () => {
    expect(piToClaude("weather", { city: "NYC" })).toEqual({
      name: "mcp__pi-tools__weather",
      input: { city: "NYC" },
    });
  });
});

describe("round trip stability for renames", () => {
  it("Read survives claudeToPi → piToClaude", () => {
    const a = { file_path: "/x", offset: 1, limit: 10 };
    const round = piToClaude(...Object.values(claudeToPi("Read", a)) as [any, any]);
    expect(round.name).toBe("Read");
    expect(round.input).toEqual(a);
  });

  it("Grep survives via the supported subset", () => {
    const a = { pattern: "x", "-i": true, head_limit: 50, context: 2 };
    const pi = claudeToPi("Grep", a);
    const cc = piToClaude(pi.name, pi.arguments);
    expect(cc.name).toBe("Grep");
    // Only the supported subset round-trips losslessly
    expect(cc.input).toEqual({ pattern: "x", "-i": true, head_limit: 50, context: 2 });
  });
});
