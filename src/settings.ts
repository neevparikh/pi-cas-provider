/**
 * Build the SDK option fragments needed to enable Claude Code's `fastMode`.
 *
 * Recipe (validated empirically against Opus 4.6 / 4.7):
 *   1. Pass `--settings '{"fastMode":true}'` to the bundled CLI via `extraArgs`.
 *   2. For Opus 4.7 specifically, also set `CLAUDE_CODE_ENABLE_OPUS_4_7_FAST_MODE=1`
 *      in the subprocess env, otherwise /fast runs on Opus 4.6.
 *
 * The CLI's own `~/.claude/settings.json` is the lowest-precedence source; the
 * `extraArgs.settings` override beats it. We use extraArgs (not managedSettings)
 * because managedSettings filters non-policy keys.
 */

export interface FastModeOpts {
  /** Subset of CLI args (without leading --), in the SDK's Record<string, string|null> shape. */
  extraArgs?: Record<string, string | null>;
  /** Env vars to merge into the subprocess environment. */
  env?: Record<string, string>;
}

export function buildFastModeOptions(fastMode: boolean, modelId: string): FastModeOpts {
  if (!fastMode) return {};

  const out: FastModeOpts = {
    extraArgs: { settings: JSON.stringify({ fastMode: true }) },
  };

  // Opus 4.7 also needs an env var until it becomes the fast-mode default.
  if (modelId.includes("opus-4-7")) {
    out.env = { CLAUDE_CODE_ENABLE_OPUS_4_7_FAST_MODE: "1" };
  }
  return out;
}

/**
 * Models that support fast mode. The CLI silently keeps fast_mode_state="off"
 * if the model isn't supported, regardless of the setting.
 */
export function modelSupportsFastMode(modelId: string): boolean {
  return modelId.includes("opus-4-6") || modelId.includes("opus-4-7");
}
