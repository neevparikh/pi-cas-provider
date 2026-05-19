/**
 * Cross-extension contract for fetching an "Anthropic Messages-API compatible
 * OAuth-routed relay endpoint" via pi's event bus.
 *
 * Motivation: when an Okta-backed (or otherwise OAuth-backed) extension
 * already manages access tokens and a relay base URL, pi-cas-provider can
 * route the bundled `claude` subprocess through that relay instead of talking
 * to `api.anthropic.com` directly. This sidesteps the managed-key refresh
 * hazard of Claude Code's own /login flow and lets organizations bill through
 * their existing OAuth-gated proxy (e.g. a middleman API).
 *
 * The protocol is deliberately neutral \u2014 channels are named "relay-*", not
 * "okta-*" or "hawk-*" \u2014 because the contract is just "I need an
 * Anthropic-Messages-compatible endpoint and a credential to put in
 * x-api-key". Any provider can answer.
 *
 * Current known responder: pi-hawk-provider (Okta + METR middleman).
 *
 * Flow:
 *   1. pi-cas emits `pi-cas:relay-request` with a freshly minted requestId
 *      and an optional `preferredProvider` (e.g. "hawk") to pin.
 *   2. Any listening extension that can satisfy the request emits
 *      `pi-cas:relay-response` with the same requestId, identifying itself
 *      via the `provider` field. If the request pinned a provider, others
 *      should stay quiet.
 *   3. pi-cas resolves on the first matching response; everything else is
 *      ignored. A timer guards against silent failure (no listener loaded).
 *
 * The responder is responsible for refreshing its OAuth token before
 * responding, so the access token returned here is good-to-use immediately.
 * If the responder cannot refresh (network down, refresh token revoked) it
 * should emit `ok: false` with an `error` message rather than time out, so
 * the user gets a clear failure instead of a confusing wait.
 */

import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Channel names. Exported for symmetry with responders implementing the protocol. */
export const RELAY_REQUEST_CHANNEL = "pi-cas:relay-request";
export const RELAY_RESPONSE_CHANNEL = "pi-cas:relay-response";

/** Sent by pi-cas to ask the bus for a relay endpoint. */
export interface RelayRequest {
  /** Opaque id; responders must echo this back unchanged. */
  requestId: string;
  /**
   * If set, only the named provider should respond. Other listeners should
   * ignore this request entirely (don't even reply with ok:false). This lets
   * the user pin a specific responder via pi-cas.json without bidding wars.
   */
  preferredProvider?: string;
}

/** Sent by a responder. Echoed `requestId` lets pi-cas match it to a pending request. */
export interface RelayResponse {
  requestId: string;
  /** Self-identification, e.g. "hawk". Used for diagnostics and for matching against `preferredProvider`. */
  provider: string;
  /** True on success. On false, `baseUrl`/`accessToken` will be absent and `error` should be set. */
  ok: boolean;
  /** Anthropic-Messages-compatible endpoint, e.g. "https://relay.example.com/anthropic". No trailing slash required. */
  baseUrl?: string;
  /** Goes into the `x-api-key` header. Must be valid for at least one turn (responder refreshes as needed). */
  accessToken?: string;
  /** Human-readable failure reason. Set when `ok: false`. */
  error?: string;
}

/** Successful resolution of `requestRelay`. */
export interface RelayConfig {
  baseUrl: string;
  accessToken: string;
  /** Which extension answered. Useful for diagnostics + the auth banner. */
  provider: string;
}

export interface RequestRelayOpts {
  /** If set, the matching responder must self-identify as this. */
  preferredProvider?: string;
  /** Default 5000ms. The responder should refresh before answering, so anything longer than this is suspicious. */
  timeoutMs?: number;
}

/**
 * Ask the event bus for a relay endpoint and return the first matching response.
 *
 * Throws on:
 *   - timeout (no responder, or responder is hung on refresh)
 *   - responder reported `ok: false` (e.g. refresh failed)
 *   - malformed response (missing baseUrl/accessToken despite ok:true)
 *
 * The thrown error message is end-user friendly \u2014 callers can surface it
 * directly to the user via pi.sendMessage.
 */
export async function requestRelay(
  pi: ExtensionAPI,
  opts: RequestRelayOpts = {},
): Promise<RelayConfig> {
  const requestId = randomUUID();
  const timeoutMs = opts.timeoutMs ?? 5000;
  const preferredProvider = opts.preferredProvider;

  return new Promise<RelayConfig>((resolve, reject) => {
    let settled = false;

    // `on()` returns its own unsubscribe; we keep a handle so the timeout and
    // the response handler can both tear it down.
    const unsubscribe = pi.events.on(RELAY_RESPONSE_CHANNEL, (raw) => {
      if (settled) return;
      // Tolerate stray emissions from misbehaving responders: only act on
      // well-formed payloads matching our requestId.
      if (!isRelayResponse(raw)) return;
      if (raw.requestId !== requestId) return;
      if (preferredProvider && raw.provider !== preferredProvider) return;

      settled = true;
      cleanup();

      if (!raw.ok) {
        reject(
          new Error(
            raw.error
              ? `relay provider "${raw.provider}" reported error: ${raw.error}`
              : `relay provider "${raw.provider}" returned ok:false (no error message)`,
          ),
        );
        return;
      }
      if (!raw.baseUrl || !raw.accessToken) {
        reject(
          new Error(
            `relay provider "${raw.provider}" returned ok:true but missing baseUrl/accessToken`,
          ),
        );
        return;
      }
      resolve({ baseUrl: raw.baseUrl, accessToken: raw.accessToken, provider: raw.provider });
    });

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(
        new Error(
          preferredProvider
            ? `no relay provider named "${preferredProvider}" responded within ${timeoutMs}ms ` +
              `(is the extension loaded? run \`pi install pi-hawk-provider\` or check /reload)`
            : `no relay provider responded within ${timeoutMs}ms ` +
              `(pi-cas okta mode is on but no extension is listening on ${RELAY_REQUEST_CHANNEL})`,
        ),
      );
    }, timeoutMs);

    function cleanup(): void {
      clearTimeout(timer);
      unsubscribe();
    }

    // Emit after wiring the listener so we never miss a synchronous response.
    const req: RelayRequest = { requestId, ...(preferredProvider ? { preferredProvider } : {}) };
    pi.events.emit(RELAY_REQUEST_CHANNEL, req);
  });
}

/** Type-guard for response shape. Defensive: anything on the bus could be anything. */
function isRelayResponse(raw: unknown): raw is RelayResponse {
  if (!raw || typeof raw !== "object") return false;
  const r = raw as Record<string, unknown>;
  return typeof r.requestId === "string" && typeof r.provider === "string" && typeof r.ok === "boolean";
}
