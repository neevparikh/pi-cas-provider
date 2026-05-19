/**
 * Tiny JSON-file persistence for provider-level state that should survive
 * across pi sessions. Modeled after pi's own ~/.pi/agent/auth.json — we don't
 * piggyback on settings.json (closed schema; pi rewrites it and would drop
 * unknown keys), nor on Claude Code's config (different ownership).
 *
 * The store is best-effort: failures (read-only home, malformed JSON, ENOENT)
 * never throw. The provider just falls back to defaults.
 *
 * Schema is intentionally minimal & forward-compatible: unknown keys are
 * preserved on write so a newer pi-cas-provider can add fields without older
 * versions clobbering them.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** Persisted shape. Keep all keys optional — readers must tolerate absence. */
export interface PersistedState {
  /** Sticky fast-mode preference. Env var still wins per-launch. */
  fastMode?: boolean;
  /**
   * Okta-OAuth-routed relay configuration. When `enabled`, pi-cas asks the
   * event bus for a baseUrl + access token before each turn and routes the
   * `claude` subprocess through that endpoint, bypassing api.anthropic.com.
   * `provider` optionally pins which extension on the bus should answer
   * (e.g. "hawk"); absent means "first responder wins".
   */
  okta?: {
    enabled?: boolean;
    provider?: string;
  };
}

/** Where we persist. Overridable for tests via PI_CAS_STATE_PATH. */
export function statePath(): string {
  if (process.env.PI_CAS_STATE_PATH) return process.env.PI_CAS_STATE_PATH;
  return join(homedir(), ".pi", "agent", "pi-cas.json");
}

export function loadState(): PersistedState {
  const p = statePath();
  try {
    if (!existsSync(p)) return {};
    const raw = readFileSync(p, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") return parsed as PersistedState;
    return {};
  } catch (err) {
    // Don't make a corrupt state file fatal — log once and start clean.
    console.error(`[pi-cas] warning: could not read ${p}: ${(err as Error).message}`);
    return {};
  }
}

/**
 * Merge `patch` into the existing state and write atomically-ish.
 *
 * We re-read inside saveState so concurrent writers (rare: two pi sessions
 * toggling /cas-fast simultaneously) don't blow away each other's unrelated
 * keys. We still race on the same key — acceptable for a single-user pref.
 */
export function saveState(patch: Partial<PersistedState>): void {
  const p = statePath();
  try {
    mkdirSync(dirname(p), { recursive: true });
    const current = loadState();
    const next = { ...current, ...patch };
    writeFileSync(p, JSON.stringify(next, null, 2) + "\n", "utf8");
  } catch (err) {
    console.error(`[pi-cas] warning: could not write ${p}: ${(err as Error).message}`);
  }
}
