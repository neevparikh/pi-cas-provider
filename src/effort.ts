/**
 * Map pi's ThinkingLevel to the SDK's effort scale.
 *
 * Pi: minimal | low | medium | high | xhigh
 * SDK fallbackModelEffort: low | medium | high | xhigh | max
 *
 * "minimal" has no direct equivalent — collapse to "low".
 * "max" is reserved for Opus-only deep thinking; we never request it implicitly.
 * When pi doesn't pass a reasoning level, omit the effort knob entirely so the
 * SDK uses its own default for the chosen model.
 */
export type SdkEffort = "low" | "medium" | "high" | "xhigh" | "max";

export function mapEffort(reasoning?: string): SdkEffort | undefined {
  switch (reasoning) {
    case "minimal":
    case "low":
      return "low";
    case "medium":
      return "medium";
    case "high":
      return "high";
    case "xhigh":
      return "xhigh";
    default:
      return undefined;
  }
}
