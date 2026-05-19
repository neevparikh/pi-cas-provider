/**
 * Provider-level runtime configuration. Module-level state because the slash
 * commands (`/cas-fast`, etc.) toggle these at session time. Reset on /reload.
 */

import { homedir } from "node:os";
import { join } from "node:path";

import { loadState } from "./persistence.js";

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
   * Per-pi-session SDK session id, set the first time we get a request with a
   * given pi sessionId. Lets the SDK's transcript stay consistent across turns,
   * though we re-inject history each turn via sessionStore.load() regardless.
   */
  sdkSessionIds: Map<string, string>;
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
    sdkSessionIds: new Map(),
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
