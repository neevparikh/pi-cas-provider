/**
 * Auth inspection. The provider does NOT implement login — it inherits from the
 * bundled `claude` CLI's existing auth. This module just queries `claude auth status`
 * and surfaces the result for banners and the `/cas-auth` slash command.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface AuthStatus {
  loggedIn: boolean;
  authMethod?: string;       // "api_key" | "claude.ai" | ...
  apiProvider?: string;      // "firstParty" | "bedrock" | "vertex" | ...
  apiKeySource?: string;
  email?: string;
  orgId?: string;
  orgName?: string;
  /** Whether the org has the entitlement that gates fastMode. Best-effort. */
  hasExtraUsage?: boolean;
  /** Raw error if status check failed. */
  error?: string;
}

/**
 * Read the auth status the same way Claude Code does. Falls back to env-only
 * detection if the CLI is missing.
 */
export function getAuthStatus(env?: NodeJS.ProcessEnv): AuthStatus {
  const e = env ?? process.env;
  try {
    const raw = execFileSync("claude", ["auth", "status"], {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 5000,
      env: e,
      encoding: "utf-8",
    });
    const parsed = JSON.parse(raw);
    const out: AuthStatus = {
      loggedIn: !!parsed.loggedIn,
      authMethod: parsed.authMethod,
      apiProvider: parsed.apiProvider,
      apiKeySource: parsed.apiKeySource,
      email: parsed.email,
      orgId: parsed.orgId,
      orgName: parsed.orgName,
    };
    out.hasExtraUsage = detectExtraUsage(out.authMethod);
    return out;
  } catch (err) {
    return {
      loggedIn: !!e.ANTHROPIC_API_KEY,
      authMethod: e.ANTHROPIC_API_KEY ? "api_key" : undefined,
      apiKeySource: e.ANTHROPIC_API_KEY ? "ANTHROPIC_API_KEY" : undefined,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Look up `hasExtraUsageEnabled` from the OAuth account record in `~/.claude.json`,
 * if present. This is the gating flag for fastMode availability.
 *
 * IMPORTANT: this flag is only meaningful for OAuth (Pro/Max/Team/Console) users.
 * For API-key users the entitlement lives at the org level on Anthropic's side
 * and is NOT visible from this local file. We return undefined ("unknown") for
 * those users and rely on the runtime `fast_mode_state` reported by the API.
 *
 * Returns:
 *   true       — extra usage definitively enabled (OAuth user, flag set true)
 *   false      — extra usage definitively disabled (OAuth user, flag set false)
 *   undefined  — unknown (API-key user, or no oauthAccount block, or read error)
 */
function detectExtraUsage(authMethod?: string): boolean | undefined {
  // For API-key auth, this local file does not reflect entitlement state.
  // Return undefined and let the runtime fast_mode_state be the source of truth.
  if (authMethod === "api_key") return undefined;
  try {
    const path = join(homedir(), ".claude.json");
    if (!existsSync(path)) return undefined;
    const data = JSON.parse(readFileSync(path, "utf-8"));
    const oauth = data?.oauthAccount;
    if (!oauth || typeof oauth.hasExtraUsageEnabled !== "boolean") return undefined;
    return oauth.hasExtraUsageEnabled;
  } catch {
    return undefined;
  }
}

/** Single-line description for startup banner. */
export function formatAuthBanner(s: AuthStatus): string {
  if (!s.loggedIn) {
    return "not authenticated — run `claude /login` or set ANTHROPIC_API_KEY";
  }
  const who = s.email ?? "<api-key user>";
  const method = s.authMethod ?? "unknown";
  const org = s.orgName ? ` (${s.orgName})` : "";
  return `${who} via ${method}${org}`;
}

/** Multi-line block for the `/cas-auth` slash command. */
export function formatAuthDetails(s: AuthStatus, opts: {
  configDir?: string;
  apiKeyOverride: boolean;
}): string {
  const lines: string[] = ["pi-cas-provider auth:"];
  lines.push(`  logged in:        ${s.loggedIn ? "yes" : "no"}`);
  if (s.authMethod)    lines.push(`  method:           ${s.authMethod}`);
  if (s.apiKeySource)  lines.push(`  key source:       ${s.apiKeySource}`);
  if (s.apiProvider)   lines.push(`  api provider:     ${s.apiProvider}`);
  if (s.email)         lines.push(`  email:            ${s.email}`);
  if (s.orgName)       lines.push(`  org:              ${s.orgName}`);
  lines.push(`  extra usage:      ${
    s.hasExtraUsage === undefined ? "unknown (decided at request time)" :
    s.hasExtraUsage ? "enabled — fast mode eligible" :
    "disabled — fast mode unavailable"
  }`);
  lines.push(`  CLAUDE_CONFIG_DIR: ${opts.configDir ?? "(default ~/.claude)"}`);
  lines.push(`  api key override:  ${opts.apiKeyOverride ? "PI_CAS_API_KEY set" : "no"}`);
  if (s.error) lines.push(`  error:            ${s.error}`);
  lines.push("");
  lines.push("To switch accounts: `claude /login` outside pi, then `/reload` here.");
  return lines.join("\n");
}
