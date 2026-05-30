/**
 * Tests for the `interactive-tools` module.
 *
 * We can't easily exercise the full pi-tui overlay flow in unit tests
 * (it'd require booting a real TUI), so we focus on:
 *   - `handleCanUseTool` dispatch logic: non-AskUserQuestion is allowed
 *     by default; AskUserQuestion routes to the dialog; missing ctx
 *     denies gracefully.
 *   - `askUserQuestionDialog` short-circuit paths: empty questions,
 *     malformed entries, no-UI mode, pre-aborted signal.
 *   - User cancel / answered round-trip via a mock `ctx.ui.custom`.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
  askUserQuestionDialog,
  handleCanUseTool,
  INTERACTIVE_TOOL_NAMES_WE_HOST,
} from "../src/interactive-tools.js";

/* ----------------------------- fixtures ----------------------------- */

/**
 * Build a minimal stub `ExtensionContext` whose `ui.custom` is whatever
 * the caller passes.  Other fields are unused by the module under test
 * and stubbed to throw to surface accidental dependencies.
 */
function makeCtx(opts: {
  hasUI: boolean;
  custom?: <T>(
    factory: (
      tui: any,
      theme: any,
      kb: any,
      done: (result: T) => void,
    ) => any,
  ) => Promise<T>;
  /** When set, `ctx.ui.select` is wired to this stub. Used to exercise
   *  the non-TUI fallback path (hosts like pirouette whose `custom` is
   *  a no-op but whose `select` is real). */
  select?: (
    title: string,
    options: string[],
    opts?: { signal?: AbortSignal },
  ) => Promise<string | undefined>;
}): ExtensionContext {
  return {
    hasUI: opts.hasUI,
    ui: {
      // We only need `custom`; if a test reaches another method, that's a bug.
      custom: opts.custom ?? (() => {
        throw new Error("ctx.ui.custom called unexpectedly");
      }),
      select: opts.select ?? (() => {
        throw new Error("ctx.ui.select called unexpectedly");
      }),
    } as any,
  } as any;
}

const Q1 = {
  question: "What's your favorite color?",
  header: "Color",
  options: [
    { label: "Red", description: "the color red" },
    { label: "Blue", description: "the color blue" },
  ],
};

const Q2 = {
  question: "Pick a meal:",
  header: "Meal",
  options: [{ label: "Breakfast" }, { label: "Lunch" }, { label: "Dinner" }],
  multiSelect: true,
};

/* ----------------------------- handleCanUseTool ----------------------------- */

describe("handleCanUseTool", () => {
  const signal = new AbortController().signal;

  it("default-allows any tool name we don't know about", async () => {
    const ctx = makeCtx({ hasUI: true });
    const result = await handleCanUseTool(
      "Bash",
      { command: "ls" },
      { signal, toolUseID: "tu-1" },
      () => ctx,
    );
    expect(result).toEqual({ behavior: "allow", updatedInput: { command: "ls" } });
  });

  it("AskUserQuestion: denies when getCtx returns undefined", async () => {
    const result = await handleCanUseTool(
      "AskUserQuestion",
      { questions: [Q1] },
      { signal, toolUseID: "tu-2" },
      () => undefined,
    );
    expect(result).toMatchObject({
      behavior: "deny",
      message: expect.stringMatching(/declined to answer/i),
    });
  });

  it("AskUserQuestion: denies when ctx.hasUI is false (e.g. RPC mode)", async () => {
    const ctx = makeCtx({ hasUI: false });
    const result = await handleCanUseTool(
      "AskUserQuestion",
      { questions: [Q1] },
      { signal, toolUseID: "tu-3" },
      () => ctx,
    );
    expect(result).toMatchObject({
      behavior: "deny",
      message: expect.stringMatching(/declined to answer/i),
    });
  });

  it("AskUserQuestion: allows + populates updatedInput.answers on user pick", async () => {
    // Mock ctx.ui.custom to immediately resolve with "Red" (simulating
    // the user selecting the first option).
    const custom = vi.fn(async (factory) => {
      // We pass a stub `done` that the factory calls to finish the overlay.
      let captured: any = undefined;
      const done = (v: any) => {
        captured = v;
      };
      const fakeTui = { requestRender: () => {} };
      const fakeTheme = { fg: (_c: string, t: string) => t };
      const comp = factory(fakeTui, fakeTheme, undefined, done);
      // Simulate pressing the "1" number-key shortcut, which in
      // single-select mode picks option 1 and submits.
      comp.handleInput("1");
      return captured;
    });
    const ctx = makeCtx({ hasUI: true, custom });
    const result = await handleCanUseTool(
      "AskUserQuestion",
      { questions: [Q1] },
      { signal, toolUseID: "tu-4" },
      () => ctx,
    );
    expect(result).toEqual({
      behavior: "allow",
      updatedInput: {
        questions: [Q1],
        answers: { "What's your favorite color?": "Red" },
      },
    });
  });

  it("AskUserQuestion: denies when user cancels (esc on first question)", async () => {
    const custom = vi.fn(async (factory) => {
      let captured: any = "not-set";
      const done = (v: any) => {
        captured = v;
      };
      const fakeTui = { requestRender: () => {} };
      const fakeTheme = { fg: (_c: string, t: string) => t };
      const comp = factory(fakeTui, fakeTheme, undefined, done);
      // Escape -> done(null) (cancel).
      comp.handleInput("\u001b");
      return captured;
    });
    const ctx = makeCtx({ hasUI: true, custom });
    const result = await handleCanUseTool(
      "AskUserQuestion",
      { questions: [Q1, Q2] },
      { signal, toolUseID: "tu-5" },
      () => ctx,
    );
    expect(result).toMatchObject({
      behavior: "deny",
      message: expect.stringMatching(/declined to answer/i),
    });
  });
});

/* ----------------------------- askUserQuestionDialog ----------------------------- */

describe("askUserQuestionDialog", () => {
  const signal = new AbortController().signal;

  it("returns answered with {} when questions is missing / empty", async () => {
    const ctx = makeCtx({ hasUI: true });
    const r1 = await askUserQuestionDialog({}, ctx, signal);
    expect(r1).toEqual({ kind: "answered", answers: {} });
    const r2 = await askUserQuestionDialog({ questions: [] }, ctx, signal);
    expect(r2).toEqual({ kind: "answered", answers: {} });
  });

  it("returns cancelled when no UI is available (headless / RPC mode)", async () => {
    const ctx = makeCtx({ hasUI: false });
    const r = await askUserQuestionDialog({ questions: [Q1] }, ctx, signal);
    expect(r).toEqual({ kind: "cancelled", reason: "no-ui-available" });
  });

  it("returns cancelled when signal is pre-aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    const ctx = makeCtx({ hasUI: true });
    const r = await askUserQuestionDialog({ questions: [Q1] }, ctx, ac.signal);
    expect(r.kind).toBe("cancelled");
  });

  it("skips malformed questions (defense against bad SDK input)", async () => {
    // Question 1 is malformed (no options array) → skipped; Q2 is valid
    // and user picks option 1.
    const custom = vi.fn(async (factory) => {
      let captured: any = undefined;
      const done = (v: any) => {
        captured = v;
      };
      const fakeTui = { requestRender: () => {} };
      const fakeTheme = { fg: (_c: string, t: string) => t };
      const comp = factory(fakeTui, fakeTheme, undefined, done);
      comp.handleInput("1"); // pick "Red"
      return captured;
    });
    const ctx = makeCtx({ hasUI: true, custom });
    const r = await askUserQuestionDialog(
      // First entry malformed (missing options); second is Q1.
      { questions: [{ question: "bad", options: undefined as any }, Q1] },
      ctx,
      signal,
    );
    expect(r).toEqual({
      kind: "answered",
      answers: { "What's your favorite color?": "Red" },
    });
    // Only one ctx.ui.custom call (for the valid question).
    expect(custom).toHaveBeenCalledTimes(1);
  });

  it("multi-select: comma-joins selected option labels", async () => {
    const custom = vi.fn(async (factory) => {
      let captured: any = undefined;
      const done = (v: any) => {
        captured = v;
      };
      const fakeTui = { requestRender: () => {} };
      const fakeTheme = { fg: (_c: string, t: string) => t };
      const comp = factory(fakeTui, fakeTheme, undefined, done);
      // Toggle options 1 and 3, then Enter to submit.
      comp.handleInput("1"); // toggles option 1 (Breakfast)
      comp.handleInput("3"); // toggles option 3 (Dinner)
      comp.handleInput("\r"); // Enter
      return captured;
    });
    const ctx = makeCtx({ hasUI: true, custom });
    const r = await askUserQuestionDialog({ questions: [Q2] }, ctx, signal);
    expect(r).toEqual({
      kind: "answered",
      answers: { "Pick a meal:": "Breakfast, Dinner" },
    });
  });

  it("multi-select with no checks: Enter falls back to cursor's option", async () => {
    const custom = vi.fn(async (factory) => {
      let captured: any = undefined;
      const done = (v: any) => {
        captured = v;
      };
      const fakeTui = { requestRender: () => {} };
      const fakeTheme = { fg: (_c: string, t: string) => t };
      const comp = factory(fakeTui, fakeTheme, undefined, done);
      // Cursor starts on option 0 (Breakfast).  Hit Enter directly.
      comp.handleInput("\r");
      return captured;
    });
    const ctx = makeCtx({ hasUI: true, custom });
    const r = await askUserQuestionDialog({ questions: [Q2] }, ctx, signal);
    expect(r).toEqual({
      kind: "answered",
      answers: { "Pick a meal:": "Breakfast" },
    });
  });
});

/* ----------------------------- ui.select fallback (non-TUI hosts) ----------------------------- */

/** Non-TUI hosts (pirouette's web dashboard, etc.) implement
 *  `ExtensionUIContext` with `hasUI = true` and a real `ui.select` but
 *  a no-op `ui.custom` (returns undefined; factory never runs).  The
 *  dialog detects this and falls back to per-question `ui.select`. */
describe("askUserQuestionDialog (non-TUI ui.select fallback)", () => {
  const signal = new AbortController().signal;

  /** Pirouette-style stub: `custom` resolves to undefined synchronously
   *  and never invokes the factory. */
  const noOpCustom = async () => undefined as any;

  it("single-select: falls back to ui.select and returns the picked label", async () => {
    // Arg types declared so TypeScript infers .mock.calls[0] as a
    // 2-tuple — otherwise vi.fn infers it from the 0-arg impl and the
    // destructure below errors with "tuple of length 0 has no element".
    const select = vi.fn(async (_title: string, _options: string[]) => "Blue");
    const ctx = makeCtx({ hasUI: true, custom: noOpCustom, select });
    const r = await askUserQuestionDialog({ questions: [Q1] }, ctx, signal);
    expect(r).toEqual({
      kind: "answered",
      answers: { "What's your favorite color?": "Blue" },
    });
    expect(select).toHaveBeenCalledTimes(1);
    // Descriptions get appended to the title since `ui.select` only
    // accepts plain label strings.
    const [titleArg, optionsArg] = select.mock.calls[0];
    expect(titleArg).toContain("What's your favorite color?");
    expect(titleArg).toContain("the color red");
    expect(optionsArg).toEqual(["Red", "Blue"]);
  });

  it("single-select: returns cancelled when user dismisses ui.select (undefined)", async () => {
    const select = vi.fn(async () => undefined);
    const ctx = makeCtx({ hasUI: true, custom: noOpCustom, select });
    const r = await askUserQuestionDialog({ questions: [Q1] }, ctx, signal);
    expect(r).toEqual({ kind: "cancelled", reason: "user-cancelled" });
  });

  it("multi-select: loops with a sentinel done option and joins picks with ', '", async () => {
    // User picks "Breakfast", then "Dinner", then the sentinel done.
    // The fallback prefixes already-picked options with "✓ " in the
    // displayed label, so the test mock can verify state across calls.
    const calls: string[][] = [];
    const select = vi.fn(async (_title: string, options: string[]) => {
      calls.push(options);
      // Call 1: pick Breakfast (label is "  Breakfast" initially, no ✓ yet).
      if (calls.length === 1) return "  Breakfast";
      // Call 2: pick Dinner (label is "  Dinner" — Breakfast was toggled
      // in but Dinner wasn't yet).
      if (calls.length === 2) return "  Dinner";
      // Call 3: pick the sentinel done.
      return "(done — submit selections)";
    });
    const ctx = makeCtx({ hasUI: true, custom: noOpCustom, select });
    const r = await askUserQuestionDialog({ questions: [Q2] }, ctx, signal);
    expect(r).toEqual({
      kind: "answered",
      answers: { "Pick a meal:": "Breakfast, Dinner" },
    });
    // Sanity: by the 3rd call, Breakfast and Dinner should be ✓'d.
    expect(calls[2]).toContain("✓ Breakfast");
    expect(calls[2]).toContain("✓ Dinner");
    expect(calls[2]).toContain("  Lunch");
    expect(calls[2][3]).toBe("(done — submit selections)");
  });

  it("multi-select: cancel mid-loop maps to user-cancelled", async () => {
    const select = vi.fn(async () => undefined);
    const ctx = makeCtx({ hasUI: true, custom: noOpCustom, select });
    const r = await askUserQuestionDialog({ questions: [Q2] }, ctx, signal);
    expect(r).toEqual({ kind: "cancelled", reason: "user-cancelled" });
  });

  it("multi-select: submitting done with nothing picked cancels", async () => {
    const select = vi.fn(async () => "(done — submit selections)");
    const ctx = makeCtx({ hasUI: true, custom: noOpCustom, select });
    const r = await askUserQuestionDialog({ questions: [Q2] }, ctx, signal);
    expect(r).toEqual({ kind: "cancelled", reason: "user-cancelled" });
  });

  it("caches the fallback decision per ctx — no second probe of ui.custom", async () => {
    const custom = vi.fn(noOpCustom);
    const select = vi.fn(async () => "Red");
    const ctx = makeCtx({ hasUI: true, custom, select });
    // Two questions back-to-back; both should land via select.
    await askUserQuestionDialog({ questions: [Q1, Q1] }, ctx, signal);
    expect(custom).toHaveBeenCalledTimes(1); // probed only on the first
    expect(select).toHaveBeenCalledTimes(2); // both questions routed
  });
});

/* ----------------------------- INTERACTIVE_TOOL_NAMES_WE_HOST ----------------------------- */

describe("INTERACTIVE_TOOL_NAMES_WE_HOST", () => {
  it("includes AskUserQuestion (the only tool we currently host)", () => {
    expect(INTERACTIVE_TOOL_NAMES_WE_HOST.has("AskUserQuestion")).toBe(true);
  });
  it("does NOT include tools we haven't built UI for yet", () => {
    expect(INTERACTIVE_TOOL_NAMES_WE_HOST.has("ExitPlanMode")).toBe(false);
    expect(INTERACTIVE_TOOL_NAMES_WE_HOST.has("Bash")).toBe(false);
  });
});
