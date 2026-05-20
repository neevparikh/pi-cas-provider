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
  /**
   * SDK permission mode for the bundled `claude` subprocess. The Option A
   * architecture lets the SDK run all tools natively, so this controls how
   * the subprocess decides whether each tool call is allowed.
   *
   * - "bypassPermissions" (default): all tools auto-allowed. Simplest and
   *   most-tested in pi-cas.
   * - "default": SDK's auto-classifier allows obviously-safe tools; unsafe
   *   tools surface as can_use_tool control_requests (pi-cas currently does
   *   NOT route these to a pi permission UI, so they will hang — only use
   *   if you're running in a trusted sandbox where the classifier covers
   *   your needs).
   * - "acceptEdits" / "plan": niche modes inherited from Claude Code. See
   *   the SDK docs.
   *
   * Env override: PI_CAS_PERMISSION_MODE. Slash command: /cas-perm.
   */
  permissionMode?: PermissionMode;
  /**
   * Mapping from pi's session id to the SDK's session UUID we use for the
   * long-lived `query()`. Persisted so that pi restarts can resume the same
   * subprocess-managed JSONL (Claude Code's project storage under
   * ~/.claude/projects/<dirhash>/<sdk-session-id>.jsonl).
   *
   * On pi `session_start` we look up by pi's session id; if found, the next
   * `query()` is spawned with `resume: <sdkSessionId>` so the SDK replays
   * its own clean JSONL (no resume normalizer bug — SDK-managed transcripts
   * always pair tool_use with tool_result).
   *
   * On fork/compact this mapping is cleared (v1 limitation: full fork
   * fidelity needs pi-entry-id → sdk-uuid bookkeeping — deferred).
   */
  sessions?: Record<string, string>;
}

/**
 * SDK permission modes. Mirrors the bundled @anthropic-ai/claude-agent-sdk
 * `PermissionMode` union; duplicated here to avoid importing the SDK from
 * persistence.ts (keeps this module dependency-free).
 */
export type PermissionMode =
  | "default"
  | "acceptEdits"
  | "plan"
  | "bypassPermissions";

const PERMISSION_MODES: readonly PermissionMode[] = [
  "default",
  "acceptEdits",
  "plan",
  "bypassPermissions",
];

/** Returns the mode if valid, otherwise undefined. */
export function parsePermissionMode(s: string | undefined): PermissionMode | undefined {
  if (!s) return undefined;
  const trimmed = s.trim();
  return (PERMISSION_MODES as readonly string[]).includes(trimmed)
    ? (trimmed as PermissionMode)
    : undefined;
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

/**
 * Look up the SDK session UUID associated with a pi session id.  Returns
 * undefined if there's no recorded mapping (first run, or post-fork after
 * the mapping was cleared).
 */
export function getSessionMapping(piSessionId: string): string | undefined {
  const state = loadState();
  return state.sessions?.[piSessionId];
}

/**
 * Record / overwrite a pi-session → sdk-session UUID mapping.  Used after
 * spawning a fresh `query()` (the SDK emits its assigned session_id in the
 * first `system.init` event).
 */
export function setSessionMapping(piSessionId: string, sdkSessionId: string): void {
  const state = loadState();
  const sessions = { ...(state.sessions ?? {}), [piSessionId]: sdkSessionId };
  saveState({ sessions });
}

/**
 * Drop a pi session's SDK mapping.  Called on `session_shutdown` (when pi
 * tells us the session is gone for good), and on fork/compact (the SDK
 * session diverges from what's persisted, so the next `query()` should
 * spawn fresh rather than resume into stale state).
 */
export function clearSessionMapping(piSessionId: string): void {
  const state = loadState();
  if (!state.sessions || !(piSessionId in state.sessions)) return;
  const sessions = { ...state.sessions };
  delete sessions[piSessionId];
  saveState({ sessions });
}
