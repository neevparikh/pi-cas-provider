/**
 * Provider-level runtime configuration. Module-level state because the slash
 * commands (`/cas-fast`, etc.) toggle these at session time. Reset on /reload.
 */

import { homedir } from "node:os";
import { join } from "node:path";

import { loadState, parsePermissionMode, type PermissionMode } from "./persistence.js";

// Forward declaration: PiSession lives in provider.ts (it depends on the
// SDK Query type).  We type-alias to `any` here to avoid a circular import.
// The shape is enforced at the use site in provider.ts.
export type PiSessionRef = any;

export interface ProviderConfig {
  /** Whether fast mode should be enabled for the next request. */
  fastMode: boolean;
  /** Whether the user already saw the fast-mode-requested-but-off warning. */
  fastModeWarned: boolean;
  /** Override for CLAUDE_CONFIG_DIR. Undefined → SDK uses its default (~/.claude). */
  configDirOverride?: string;
  /** Override for ANTHROPIC_API_KEY. Undefined → inherit from process env. */
  apiKeyOverride?: string;
  /**
   * Override for ANTHROPIC_BASE_URL applied **only** in the subprocess env.
   * Undefined → inherit whatever the user has set globally. Set via
   * `PI_CAS_BASE_URL=...` to route pi-cas traffic through a proxy or alternate
   * endpoint without affecting other Anthropic-using tools on the machine.
   */
  baseUrlOverride?: string;
  /**
   * Per-pi-session long-lived `PiSession` (see provider.ts).  One entry per
   * active pi session id, populated on first `streamSimple`, torn down on
   * `session_shutdown` / fork / compact.
   *
   * Typed loosely (`PiSessionRef = any`) to avoid a circular import between
   * config.ts and provider.ts.  The concrete shape (long-lived `Query`,
   * promptQueue, etc.) is defined and enforced inside provider.ts.
   */
  sessions: Map<string, PiSessionRef>;
  /**
   * fast_mode_state reported by the API on the most recent request, if any.
   * This is ground truth: pi-cas may have *requested* fast mode, but the API
   * decides whether it actually engaged (e.g., off if extra-usage isn't
   * enabled on the org or the model doesn't support it).
   */
  lastFastModeState?: "off" | "cooldown" | "on";
  /** Model id from the most recent request, for /cas-status context. */
  lastModel?: string;
  /**
   * Okta-routed relay mode. When enabled, the streamSimple path asks the pi
   * event bus for an `{ baseUrl, accessToken }` pair before each turn and
   * routes the subprocess through that relay instead of the user's local
   * Claude Code auth. See src/relay.ts for the contract.
   */
  oktaEnabled: boolean;
  /**
   * Optional pin: when set, only the named relay responder is acceptable
   * (e.g. "hawk"). Absent / empty string means "first responder wins".
   */
  oktaProvider?: string;
  /** Provider name from the most recent successful relay turn, for /cas-status. */
  lastOktaProvider?: string;
  /** Base URL from the most recent successful relay turn, for /cas-status. */
  lastOktaBaseUrl?: string;
  /**
   * Per-process cache of the okta relay access token, used by the in-process
   * HTTP proxy's `apiKeyProvider` to rewrite `x-api-key` on every Anthropic
   * call out of the bundled `claude` subprocess. Without per-request rewrite
   * the subprocess would happily reuse the SAME ANTHROPIC_API_KEY it was
   * spawned with for the lifetime of the SDK session — and once that JWT
   * expires (~24h with pi-hawk-provider), every request 401s.
   *
   * The cache is provider-instance-scoped (one map per `registerProvider`
   * call). `fetchedAt: 0` + `token: undefined` is the "empty" state. The
   * proxy's apiKeyProvider closure reads/writes this; ensureSession seeds
   * it at session spawn so the first request doesn't re-round-trip the
   * event bus.
   *
   * Optional because non-okta provider instances don't need it; populated
   * lazily by registerProvider when `oktaEnabled`.
   */
  oktaTokenCache?: { token?: string; fetchedAt: number };
  /**
   * SDK permission mode for the bundled `claude` subprocess. In the
   * Option A architecture the SDK runs all tools natively, so this is
   * the knob that decides what's allowed without prompting.
   *
   * Defaults to "bypassPermissions" — the simplest, most-tested mode
   * for pi-cas. Configurable via `permissionMode` in pi-cas.json or
   * the `PI_CAS_PERMISSION_MODE` env var (env wins). Mutable at
   * runtime via `query.setPermissionMode()`; the long-lived subprocess
   * picks up changes without restart.
   */
  permissionMode: PermissionMode;
  /**
   * Set by `registerProvider` after the named stubs are registered.  Called
   * by the event bridge's `onUnknownToolName` hook the first time the SDK
   * emits a tool_use with a name not in {@link SUPPORTED_CC_TOOL_NAMES}.
   *
   * Idempotent: tracks an internal set of already-registered names so
   * repeated calls for the same name are no-ops.  See provider.ts where it
   * is constructed.
   */
  registerDynamicStub?: (toolName: string) => void;
  /**
   * Returns the most-recently-seen {@link ExtensionContext}, or undefined
   * if no event handler has fired yet.  Set by `registerProvider`; consumed
   * by `ensureSession` to construct the SDK's `canUseTool` hook (see
   * `interactive-tools.ts`).
   *
   * The getter pattern (vs. a direct `ctx` field) is important because we
   * want the SDK to see the LATEST ctx at the moment it invokes
   * `canUseTool`, not the one that happened to be set at session-spawn
   * time — ctx may be refreshed between turns, after compaction, etc.
   *
   * Returns `undefined` if pi-cas is running before any event has fired,
   * or if pi is in a headless mode where no UI context exists.  Callers
   * should fall back to `behavior: "deny"` in that case.
   */
  getLatestCtx?: () => import("@earendil-works/pi-coding-agent").ExtensionContext | undefined;
  /**
   * Fork bookkeeping: when pi forks a session, the `session_before_fork`
   * handler calls `forkSession()` on the SDK to create a forked copy of the
   * current SDK session and stashes the result here.  The next
   * `streamSimple` for a brand-new pi session id (which is the forked
   * branch) consumes this entry and uses the forked SDK session id as its
   * `resume` target, preserving model history across the fork.
   *
   * Cleared as soon as it's consumed.  Only one fork can be pending at a
   * time — pi forks are user-driven (one click → one fork → wait), so this
   * isn't a practical limitation.
   */
  pendingFork?: {
    /** Pi session id of the source session being forked from. */
    sourcePiSessionId: string;
    /** New SDK session UUID produced by `forkSession()`. */
    forkedSdkSessionId: string;
  };
}

/**
 * Resolve the effective permissionMode default. Precedence:
 *   1. PI_CAS_PERMISSION_MODE env var (per-launch override)
 *   2. persisted permissionMode from pi-cas.json (sticky preference)
 *   3. "bypassPermissions" — safe default for pi-cas: pi already controls
 *      what code runs, the subprocess just needs permission to do its job.
 */
function resolveInitialPermissionMode(
  persisted: PermissionMode | undefined,
): PermissionMode {
  const env = parsePermissionMode(process.env.PI_CAS_PERMISSION_MODE);
  if (env) return env;
  return persisted ?? "bypassPermissions";
}

/**
 * Resolve the effective fastMode default with this precedence:
 *   1. Explicit env var (PI_CAS_FAST_MODE in {"1","true","0","false"})
 *      — per-launch override, wins over everything.
 *   2. Persisted state from ~/.pi/agent/pi-cas.json (set via `/cas-fast on|off`)
 *      — sticky user preference across sessions.
 *   3. false — safe default.
 *
 * Env wins over persisted on purpose: it lets you flip behavior for a one-off
 * launch (`PI_CAS_FAST_MODE=0 pi ...`) without rewriting the saved preference.
 */
function resolveInitialFastMode(persisted: boolean | undefined): boolean {
  const env = process.env.PI_CAS_FAST_MODE;
  if (env === "1" || env === "true") return true;
  if (env === "0" || env === "false") return false;
  return persisted ?? false;
}

export function createDefaultConfig(): ProviderConfig {
  const persisted = loadState();
  return {
    fastMode: resolveInitialFastMode(persisted.fastMode),
    fastModeWarned: false,
    configDirOverride: process.env.PI_CAS_CLAUDE_CONFIG_DIR,
    apiKeyOverride: process.env.PI_CAS_API_KEY,
    baseUrlOverride: process.env.PI_CAS_BASE_URL,
    // Okta-relay knobs come purely from the persisted state file. No env-var
    // override on purpose: this is a deliberate "route my traffic differently"
    // setting, not a per-launch convenience like PI_CAS_FAST_MODE.
    oktaEnabled: persisted.okta?.enabled === true,
    oktaProvider:
      typeof persisted.okta?.provider === "string" && persisted.okta.provider.trim() !== ""
        ? persisted.okta.provider.trim()
        : undefined,
    permissionMode: resolveInitialPermissionMode(persisted.permissionMode),
    sessions: new Map(),
  };
}

/** Default project key passed to SessionStore — keep it stable & predictable. */
export const PROJECT_KEY = "pi-cas-provider";

/** Provider ID registered with pi. */
export const PROVIDER_ID = "pi-cas";

/** Where Claude Code persists session JSONLs by default. */
export function defaultClaudeProjectsDir(): string {
  return join(homedir(), ".claude", "projects");
}
