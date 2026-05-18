/**
 * Provider-level runtime configuration. Module-level state because the slash
 * commands (`/cas-fast`, etc.) toggle these at session time. Reset on /reload.
 */

import { homedir } from "node:os";
import { join } from "node:path";

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
   * Per-pi-session SDK session id, set the first time we get a request with a
   * given pi sessionId. Lets the SDK's transcript stay consistent across turns,
   * though we re-inject history each turn via sessionStore.load() regardless.
   */
  sdkSessionIds: Map<string, string>;
}

export function createDefaultConfig(): ProviderConfig {
  return {
    fastMode: process.env.PI_CAS_FAST_MODE === "1" || process.env.PI_CAS_FAST_MODE === "true",
    fastModeWarned: false,
    configDirOverride: process.env.PI_CAS_CLAUDE_CONFIG_DIR,
    apiKeyOverride: process.env.PI_CAS_API_KEY,
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
