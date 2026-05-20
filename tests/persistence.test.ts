/**
 * Unit tests for persistence helpers (session mapping, permissionMode parsing).
 *
 * Uses PI_CAS_STATE_PATH to redirect to a temp file per test — no real ~/.pi
 * is touched.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  loadState,
  saveState,
  parsePermissionMode,
  getSessionMapping,
  setSessionMapping,
  clearSessionMapping,
} from "../src/persistence.js";

let tmpDir: string;
let statePath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "pi-cas-persistence-test-"));
  statePath = join(tmpDir, "pi-cas.json");
  process.env.PI_CAS_STATE_PATH = statePath;
});

afterEach(() => {
  delete process.env.PI_CAS_STATE_PATH;
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("parsePermissionMode", () => {
  it("accepts every documented mode", () => {
    expect(parsePermissionMode("default")).toBe("default");
    expect(parsePermissionMode("acceptEdits")).toBe("acceptEdits");
    expect(parsePermissionMode("plan")).toBe("plan");
    expect(parsePermissionMode("bypassPermissions")).toBe("bypassPermissions");
  });

  it("returns undefined for unknown / empty / undefined inputs", () => {
    expect(parsePermissionMode(undefined)).toBeUndefined();
    expect(parsePermissionMode("")).toBeUndefined();
    expect(parsePermissionMode("nope")).toBeUndefined();
    expect(parsePermissionMode("DEFAULT")).toBeUndefined(); // case-sensitive
  });

  it("trims whitespace before validating", () => {
    expect(parsePermissionMode("  default  ")).toBe("default");
    expect(parsePermissionMode("\tbypassPermissions\n")).toBe("bypassPermissions");
  });
});

describe("session mapping helpers", () => {
  it("returns undefined when no mapping exists", () => {
    expect(getSessionMapping("pi-1")).toBeUndefined();
  });

  it("records and reads a mapping", () => {
    setSessionMapping("pi-1", "sdk-uuid-1");
    expect(getSessionMapping("pi-1")).toBe("sdk-uuid-1");
  });

  it("overwrites an existing mapping for the same pi session", () => {
    setSessionMapping("pi-1", "sdk-uuid-1");
    setSessionMapping("pi-1", "sdk-uuid-2");
    expect(getSessionMapping("pi-1")).toBe("sdk-uuid-2");
  });

  it("isolates mappings per pi session id", () => {
    setSessionMapping("pi-1", "sdk-A");
    setSessionMapping("pi-2", "sdk-B");
    expect(getSessionMapping("pi-1")).toBe("sdk-A");
    expect(getSessionMapping("pi-2")).toBe("sdk-B");
  });

  it("clearSessionMapping removes only the named pi session", () => {
    setSessionMapping("pi-1", "sdk-A");
    setSessionMapping("pi-2", "sdk-B");
    clearSessionMapping("pi-1");
    expect(getSessionMapping("pi-1")).toBeUndefined();
    expect(getSessionMapping("pi-2")).toBe("sdk-B");
  });

  it("clearSessionMapping on a non-existent pi session is a no-op", () => {
    setSessionMapping("pi-1", "sdk-A");
    clearSessionMapping("pi-nope");
    expect(getSessionMapping("pi-1")).toBe("sdk-A");
  });

  it("session mappings survive an unrelated saveState patch", () => {
    setSessionMapping("pi-1", "sdk-A");
    saveState({ fastMode: true });
    expect(getSessionMapping("pi-1")).toBe("sdk-A");
    expect(loadState().fastMode).toBe(true);
  });

  it("session mappings are persisted under the `sessions` key in the JSON file", () => {
    setSessionMapping("pi-1", "sdk-A");
    const raw = readFileSync(statePath, "utf8");
    const parsed = JSON.parse(raw);
    expect(parsed.sessions).toEqual({ "pi-1": "sdk-A" });
  });
});

describe("loadState / saveState", () => {
  it("returns {} when the state file does not exist", () => {
    expect(existsSync(statePath)).toBe(false);
    expect(loadState()).toEqual({});
  });

  it("preserves unknown keys on write (forward compat)", () => {
    // Simulate a newer pi-cas version having written extra keys.
    writeFileSync(
      statePath,
      JSON.stringify({ fastMode: true, futureField: { nested: 42 } }),
      "utf8",
    );
    // Older pi-cas (this code) writes a different field.
    saveState({ permissionMode: "default" });
    const reread = JSON.parse(readFileSync(statePath, "utf8"));
    expect(reread.fastMode).toBe(true);
    expect(reread.permissionMode).toBe("default");
    expect(reread.futureField).toEqual({ nested: 42 });
  });

  it("returns {} for a malformed JSON file rather than throwing", () => {
    writeFileSync(statePath, "{ not valid json", "utf8");
    expect(loadState()).toEqual({});
  });

  it("can persist and read back permissionMode", () => {
    saveState({ permissionMode: "bypassPermissions" });
    expect(loadState().permissionMode).toBe("bypassPermissions");
  });
});
