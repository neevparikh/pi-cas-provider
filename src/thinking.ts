/**
 * Build the SDK `thinking` option from pi's per-turn settings.
 *
 * Pi exposes two relevant knobs on `SimpleStreamOptions`:
 *   - `reasoning?: ThinkingLevel`     ("minimal"|"low"|"medium"|"high"|"xhigh")
 *   - `thinkingBudgets?: ThinkingBudgets`  (per-level token budgets)
 *
 * We translate them to the Claude Agent SDK's `ThinkingConfig`, mirroring
 * pi-ai's own native Anthropic provider semantics (see
 * `node_modules/@earendil-works/pi-ai/dist/providers/anthropic.js`) so the
 * subprocess behaves the same as if pi were talking to Anthropic directly:
 *
 *   reasoning absent + model.reasoning  →  { type: "disabled" }
 *      (pi-ai sends `thinkingEnabled: false` which becomes `thinking.type: "disabled"`)
 *
 *   reasoning set + adaptive model      →  { type: "adaptive", display: "summarized" }
 *      Adaptive-thinking models are Opus 4.6/4.7 and Sonnet 4.6+. Effort level
 *      is conveyed via the SDK's separate `effort` field (see effort.ts), not
 *      duplicated here.
 *
 *   reasoning set + older model         →  { type: "enabled", budgetTokens, display: "summarized" }
 *      Budget-based path for pre-adaptive thinking models. We pick the budget
 *      from `thinkingBudgets[level]`, falling back to 1024 (pi-ai's default).
 *
 *   !model.reasoning                    →  undefined
 *      Model can't think at all; leave the SDK alone so it doesn't reject
 *      `--thinking adaptive` for a non-thinking model.
 *
 * **Why `display: "summarized"` by default.** Pi-ai's native Anthropic provider
 * hardcodes the same default, citing that Opus 4.7 / Mythos preview behave
 * inconsistently without it (older Claude 4 models defaulted to "summarized"
 * server-side). Matching that default keeps pi-cas behavior consistent with
 * the rest of pi.
 *
 * **Why not pass `display` through from pi.** Pi has no `thinkingDisplay`
 * field on its public types — only a renderer-side `hideThinkingBlock` boolean
 * that controls whether the TUI shows thinking, not what the API returns.
 * So there's nothing to plumb; "summarized" is the right default for everyone.
 */

import type { Options } from "@anthropic-ai/claude-agent-sdk";
import type { Model, ThinkingBudgets } from "@earendil-works/pi-ai";

/** Default budget when the user didn't specify one for the chosen level. */
const DEFAULT_BUDGET_TOKENS = 1024;

/** Mirrors pi-ai's `supportsAdaptiveThinking` predicate. */
function supportsAdaptiveThinking(modelId: string): boolean {
  return (
    modelId.includes("opus-4-6") ||
    modelId.includes("opus-4.6") ||
    modelId.includes("opus-4-7") ||
    modelId.includes("opus-4.7") ||
    modelId.includes("sonnet-4-6") ||
    modelId.includes("sonnet-4.6")
  );
}

/**
 * Resolve a budget token count for the requested level. Uses the per-level
 * override if present, otherwise the default. Only used on the budget-based
 * path (non-adaptive models).
 */
function resolveBudgetTokens(
  reasoning: string,
  thinkingBudgets: ThinkingBudgets | undefined,
): number {
  if (!thinkingBudgets) return DEFAULT_BUDGET_TOKENS;
  switch (reasoning) {
    case "minimal": return thinkingBudgets.minimal ?? DEFAULT_BUDGET_TOKENS;
    case "low":     return thinkingBudgets.low     ?? DEFAULT_BUDGET_TOKENS;
    case "medium":  return thinkingBudgets.medium  ?? DEFAULT_BUDGET_TOKENS;
    case "high":    return thinkingBudgets.high    ?? DEFAULT_BUDGET_TOKENS;
    // "xhigh" has no entry in ThinkingBudgets — fall through to default.
    default:        return DEFAULT_BUDGET_TOKENS;
  }
}

/**
 * Produce the `thinking` field for `Options`, or `undefined` if the model
 * doesn't support thinking at all (in which case we leave the SDK to its
 * default behavior — passing `{ type: "disabled" }` to a non-reasoning model
 * is harmless but unnecessary noise on the CLI command line).
 */
export function buildThinkingConfig(
  model: Pick<Model<any>, "id" | "reasoning">,
  reasoning: string | undefined,
  thinkingBudgets: ThinkingBudgets | undefined,
): Options["thinking"] | undefined {
  if (!model.reasoning) return undefined;

  // Pi user explicitly turned thinking off (or the session-level
  // ThinkingLevel is "off" — pi only forwards `reasoning` when the user has
  // a level set, so undefined here means "no thinking this turn").
  if (!reasoning) {
    return { type: "disabled" };
  }

  const display = "summarized" as const;

  if (supportsAdaptiveThinking(model.id)) {
    return { type: "adaptive", display };
  }

  return {
    type: "enabled",
    budgetTokens: resolveBudgetTokens(reasoning, thinkingBudgets),
    display,
  };
}
