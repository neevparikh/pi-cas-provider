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
  /** Subscription type from claude auth status, if any (e.g. "pro", "max"). */
  subscriptionType?: string | null;
  /** Whether the org has the entitlement that gates fastMode. Best-effort. */
  hasExtraUsage?: boolean;
  /** Raw error if status check failed. */
  error?: string;
}

/**
 * How API requests will be billed under the detected auth.
 *
 * The Anthropic TOS forbids using **subscription-scoped** Claude Code credentials
 * (Pro/Max OAuth) for third-party agents. It does NOT forbid the Console-OAuth
 * flow, which is just a friendlier way to mint an API key bound to your
 * Anthropic Console org — same billing surface as a hand-pasted ANTHROPIC_API_KEY.
 *
 * We distinguish:
 *   - "api_key"       — raw ANTHROPIC_API_KEY (env or stored). Always fine.
 *   - "console_oauth" — `claude /login` against Anthropic Console; subscriptionType
 *                       is null and apiKeySource says "/login managed key".
 *                       Billing = Console / API rates. Fine for this provider.
 *   - "subscription"  — `claude /login` bound to a Pro/Max subscription. Billing
 *                       hits the subscription; TOS scopes those credentials to
 *                       Claude Code. We refuse to use this silently and warn loudly.
 *   - "unknown"       — we couldn't tell. Treated as "ok but warn".
 */
export type BillingMode = "api_key" | "console_oauth" | "subscription" | "unknown";

export function classifyBilling(s: AuthStatus): BillingMode {
  if (!s.loggedIn) return "unknown";
  if (s.authMethod === "api_key") return "api_key";
  // Pro/Max subscription: subscriptionType is non-null/non-empty.
  if (s.subscriptionType) return "subscription";
  // Console OAuth: Claude Code minted/managed an API key for us via the OAuth
  // flow. The signal we trust most is apiKeySource containing "managed key".
  // (We also accept missing subscriptionType + claude.ai as a fallback.)
  const managed = (s.apiKeySource ?? "").toLowerCase().includes("managed key");
  if (managed) return "console_oauth";
  if (s.authMethod === "claude.ai" && s.subscriptionType == null) return "console_oauth";
  return "unknown";
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
      // null is meaningful here ("no subscription") — preserve it instead of
      // collapsing to undefined, since classifyBilling() distinguishes them.
      subscriptionType:
        parsed.subscriptionType === undefined ? undefined : parsed.subscriptionType,
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

/** Human-readable label for a BillingMode, used in banner + details. */
function billingLabel(mode: BillingMode): string {
  switch (mode) {
    case "api_key":
      return "API key (Console billing)";
    case "console_oauth":
      return "Console OAuth (Console billing)";
    case "subscription":
      return "Pro/Max subscription — NOT supported for this provider";
    case "unknown":
      return "unknown auth source";
  }
}

/** Single-line description for startup banner. */
export function formatAuthBanner(s: AuthStatus): string {
  if (!s.loggedIn) {
    return "not authenticated — run `claude /login` (pick Console) or set ANTHROPIC_API_KEY";
  }
  const who = s.email ?? "<api-key user>";
  const org = s.orgName ? ` — ${s.orgName}` : "";
  return `${who} via ${billingLabel(classifyBilling(s))}${org}`;
}

/** Multi-line block for the `/cas-auth` slash command. */
export function formatAuthDetails(s: AuthStatus, opts: {
  configDir?: string;
  apiKeyOverride: boolean;
}): string {
  const mode = classifyBilling(s);
  const lines: string[] = ["pi-cas-provider auth:"];
  lines.push(`  logged in:        ${s.loggedIn ? "yes" : "no"}`);
  lines.push(`  billing mode:     ${billingLabel(mode)}`);
  if (s.authMethod)    lines.push(`  raw method:       ${s.authMethod}`);
  if (s.apiKeySource)  lines.push(`  key source:       ${s.apiKeySource}`);
  if (s.subscriptionType != null) lines.push(`  subscription:     ${s.subscriptionType}`);
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

  // Mode-specific guidance.
  lines.push("");
  switch (mode) {
    case "api_key":
      lines.push("OK — raw API key, billed to your Console org.");
      break;
    case "console_oauth":
      lines.push("OK — Console OAuth (Claude Code manages an API key bound to your Console org).");
      lines.push("Billing is identical to a hand-pasted ANTHROPIC_API_KEY.");
      break;
    case "subscription":
      lines.push("⚠︎  This auth is a Claude.ai subscription (Pro/Max). The Anthropic TOS");
      lines.push("    scopes those credentials to Claude Code as a product; using them through");
      lines.push("    this provider is not intended use. Sign out and either:");
      lines.push("      - `claude /login` and pick the Anthropic Console flow, or");
      lines.push("      - set ANTHROPIC_API_KEY (or PI_CAS_API_KEY) to a Console key.");
      break;
    case "unknown":
      lines.push("Could not classify auth method. If fast mode behaves unexpectedly,");
      lines.push("  set ANTHROPIC_API_KEY (or PI_CAS_API_KEY) to a Console API key explicitly.");
      break;
  }
  lines.push("");
  lines.push("To switch accounts: `claude /login` outside pi, then `/reload` here.");
  return lines.join("\n");
}
