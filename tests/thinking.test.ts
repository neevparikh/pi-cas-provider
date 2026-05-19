import { describe, it, expect } from "vitest";
import { buildThinkingConfig } from "../src/thinking.js";

// Minimal shape — buildThinkingConfig only reads `id` and `reasoning`.
const m = (id: string, reasoning: boolean) =>
  ({ id, reasoning }) as { id: string; reasoning: boolean };

describe("buildThinkingConfig", () => {
  describe("non-reasoning models", () => {
    it("returns undefined when model.reasoning is false (Haiku-class)", () => {
      expect(buildThinkingConfig(m("claude-haiku-4-5", false), "high", undefined))
        .toBeUndefined();
    });

    it("ignores thinkingBudgets on non-reasoning models", () => {
      expect(
        buildThinkingConfig(m("claude-3-5-haiku", false), "high", { high: 50000 }),
      ).toBeUndefined();
    });
  });

  describe("reasoning model, no level requested", () => {
    it("returns { type: 'disabled' } so the CLI doesn't fall back to its default", () => {
      expect(buildThinkingConfig(m("claude-opus-4-7", true), undefined, undefined))
        .toEqual({ type: "disabled" });
    });
  });

  describe("adaptive-thinking models (Opus 4.6/4.7, Sonnet 4.6)", () => {
    it.each([
      "claude-opus-4-6",
      "claude-opus-4-6-20250101",
      "claude-opus-4.6",
      "claude-opus-4-7",
      "claude-opus-4.7",
      "claude-sonnet-4-6",
      "claude-sonnet-4.6-20260101",
    ])("uses adaptive + summarized for %s", (id) => {
      expect(buildThinkingConfig(m(id, true), "high", undefined))
        .toEqual({ type: "adaptive", display: "summarized" });
    });

    it("ignores thinkingBudgets on adaptive models (budget irrelevant for adaptive)", () => {
      expect(
        buildThinkingConfig(m("claude-opus-4-7", true), "medium", { medium: 12345 }),
      ).toEqual({ type: "adaptive", display: "summarized" });
    });

    it("uses adaptive regardless of effort level", () => {
      for (const lvl of ["minimal", "low", "medium", "high", "xhigh"] as const) {
        expect(buildThinkingConfig(m("claude-opus-4-7", true), lvl, undefined))
          .toEqual({ type: "adaptive", display: "summarized" });
      }
    });
  });

  describe("budget-based models (pre-adaptive thinking models)", () => {
    it("uses { type: 'enabled', budgetTokens: 1024, display: 'summarized' } by default", () => {
      // Older thinking-capable Sonnet/Opus IDs (no 4-6/4-7/4.6 substring).
      expect(buildThinkingConfig(m("claude-sonnet-4-5", true), "high", undefined))
        .toEqual({ type: "enabled", budgetTokens: 1024, display: "summarized" });
    });

    it("honors per-level thinkingBudgets overrides", () => {
      const budgets = { minimal: 100, low: 500, medium: 5000, high: 25000 };
      expect(buildThinkingConfig(m("claude-sonnet-4-5", true), "minimal", budgets))
        .toEqual({ type: "enabled", budgetTokens: 100, display: "summarized" });
      expect(buildThinkingConfig(m("claude-sonnet-4-5", true), "low", budgets))
        .toEqual({ type: "enabled", budgetTokens: 500, display: "summarized" });
      expect(buildThinkingConfig(m("claude-sonnet-4-5", true), "medium", budgets))
        .toEqual({ type: "enabled", budgetTokens: 5000, display: "summarized" });
      expect(buildThinkingConfig(m("claude-sonnet-4-5", true), "high", budgets))
        .toEqual({ type: "enabled", budgetTokens: 25000, display: "summarized" });
    });

    it("falls back to 1024 for xhigh (not in ThinkingBudgets)", () => {
      const budgets = { high: 25000 };
      expect(buildThinkingConfig(m("claude-sonnet-4-5", true), "xhigh", budgets))
        .toEqual({ type: "enabled", budgetTokens: 1024, display: "summarized" });
    });

    it("falls back to 1024 when the requested level has no override", () => {
      const budgets = { high: 25000 };
      expect(buildThinkingConfig(m("claude-sonnet-4-5", true), "low", budgets))
        .toEqual({ type: "enabled", budgetTokens: 1024, display: "summarized" });
    });
  });
});
