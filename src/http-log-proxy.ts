/**
 * Minimal HTTP-in / HTTPS-out logging + auth-rewriting proxy.
 *
 * Use case: we control what `ANTHROPIC_BASE_URL` the bundled `claude` subprocess
 * sees, so we can point it at this proxy on localhost. The proxy (optionally)
 * logs each request to a JSONL file and forwards to a configurable upstream
 * URL (e.g. https://middleman.prd.metr.org/anthropic).
 *
 * It has two orthogonal jobs, either of which can be enabled independently:
 *
 *   1. **Logging.** When `logFilePath` is set, write a JSONL record of every
 *      request + response. When omitted, no log file is created and logging
 *      is a no-op.
 *
 *   2. **Per-request auth rewriting.** When `apiKeyProvider` is set, the proxy
 *      awaits it before forwarding each request upstream and replaces the
 *      incoming `x-api-key` (stripping `authorization` while it's at it, since
 *      the relay only accepts x-api-key) with whatever the provider returns.
 *      This is how pi-cas keeps the bundled `claude` subprocess's effectively-
 *      static ANTHROPIC_API_KEY in sync with a rotating OAuth access token:
 *      the subprocess sends a stale key, the proxy swaps in a fresh one
 *      sourced from the okta relay. If the provider throws (refresh failed,
 *      responder unreachable, etc.), the proxy returns a 502 with a
 *      structured `auth_refresh_failed` error body so the subprocess sees a
 *      clear failure instead of a confusing 401 from upstream.
 *
 * Why not use mitmproxy / a real proxy? We want zero install footprint and
 * automatic lifecycle tied to the pi session. Why not log inside the
 * Claude Agent SDK? Because the SDK spawns `claude` as a subprocess and its
 * HTTP traffic isn't observable from our process.
 *
 * Trade-offs:
 *   - Request body is buffered fully. Anthropic Messages requests are bounded
 *     (\u2264 a few hundred KB even with large context) so this is fine.
 *   - Response body is streamed through unchanged \u2014 SSE works as expected.
 *     We log status + headers; with `logResponseBody: true` we also tee the
 *     SSE stream into the log up to a 1 MiB cap.
 *   - The x-api-key / Authorization headers are redacted in the log. The log
 *     records the INCOMING header (what the subprocess sent), not the
 *     possibly-rewritten one forwarded upstream \u2014 both are redacted anyway,
 *     so the distinction only matters if you decode lengths.
 *   - No TLS termination on the listen side: the proxy speaks HTTP. `claude`
 *     doesn't care because ANTHROPIC_BASE_URL says http://.
 *   - Upstream is mutable: callers can switch the upstream URL at runtime
 *     (e.g. after the okta relay resolves a different endpoint) via
 *     `setUpstreamBaseUrl()`. In-flight requests snapshot the upstream at
 *     entry, so a swap only affects subsequent requests.
 *
 * Lifecycle: callers `await startLogProxy(...)` to get a handle. The handle
 * exposes `getBaseUrl()` for the ANTHROPIC_BASE_URL replacement, plus
 * `setUpstreamBaseUrl()` and `close()`.
 */

import { randomUUID } from "node:crypto";
import { createWriteStream, type WriteStream } from "node:fs";
import { createServer, type Server } from "node:http";
import { request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";
import { URL } from "node:url";

export interface LogProxyOptions {
  /** Initial upstream base URL, e.g. "https://middleman.prd.metr.org/anthropic". */
  initialUpstreamBaseUrl: string;
  /**
   * Path to the JSONL log file. Appended; rotated externally. When omitted,
   * the proxy still forwards traffic but doesn't open or write any file —
   * useful when the proxy is being used purely for `apiKeyProvider` auth
   * rewriting without logging.
   */
  logFilePath?: string;
  /** If true, also append response body chunks (SSE) to the log. Default false. */
  logResponseBody?: boolean;
  /** Hostname to bind. Default "127.0.0.1". */
  host?: string;
  /** Specific port (default 0 = ephemeral). */
  port?: number;
  /** Header names to redact (case-insensitive). Default: api-key / auth headers. */
  redactHeaders?: string[];
  /**
   * Optional async supplier for a fresh credential. When set, the proxy
   * awaits this before each upstream forward and overrides the incoming
   * `x-api-key` header with the returned value, additionally stripping any
   * `authorization` header (the relay we forward to only accepts x-api-key
   * auth, and a stale Bearer would otherwise be sent alongside the fresh
   * api key).
   *
   * Failure modes:
   *   - Provider throws / rejects → 502 with `{ error: { type:
   *     "auth_refresh_failed", message } }` body. Logged as `auth_error`.
   *   - Provider returns empty string → same as throwing.
   *
   * Synchronous suppliers can wrap their value in `Promise.resolve(...)`.
   */
  apiKeyProvider?: () => Promise<string>;
}

export interface LogProxyHandle {
  /** Current ANTHROPIC_BASE_URL replacement. Reflects the live upstream's path prefix. */
  getBaseUrl(): string;
  /**
   * Update the upstream URL (e.g. after the okta relay resolves a different
   * endpoint). Subsequent requests forward to the new upstream; in-flight
   * requests are unaffected.
   */
  setUpstreamBaseUrl(url: string): void;
  /** Stop the proxy and flush the log. Idempotent. */
  close(): Promise<void>;
  /** Absolute path of the log file (for diagnostics), or undefined if logging is disabled. */
  logFilePath: string | undefined;
  /** Numeric port the proxy bound to. */
  port: number;
}

const DEFAULT_REDACTED_HEADERS = [
  "authorization",
  "x-api-key",
  "anthropic-api-key",
  "proxy-authorization",
];

interface ParsedUpstream {
  url: URL;
  pathPrefix: string;
}

function parseUpstream(raw: string): ParsedUpstream {
  const url = new URL(raw);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`upstream base URL must be http(s), got ${url.protocol}`);
  }
  return { url, pathPrefix: url.pathname.replace(/\/+$/, "") };
}

export async function startLogProxy(opts: LogProxyOptions): Promise<LogProxyHandle> {
  // Live upstream; mutated by setUpstreamBaseUrl. Request handler snapshots it.
  let current = parseUpstream(opts.initialUpstreamBaseUrl);

  const redactSet = new Set(
    (opts.redactHeaders ?? DEFAULT_REDACTED_HEADERS).map((h) => h.toLowerCase()),
  );
  const logResponseBody = opts.logResponseBody === true;
  const apiKeyProvider = opts.apiKeyProvider;

  // Logging is optional — the proxy is also used purely for `apiKeyProvider`
  // header rewriting. When no log path is given we skip the file open and
  // turn `appendLog` into a no-op so the rest of the handler doesn't need
  // to branch.
  let logStream: WriteStream | undefined;
  if (opts.logFilePath) {
    logStream = createWriteStream(opts.logFilePath, { flags: "a" });
    await new Promise<void>((resolve, reject) => {
      logStream!.once("open", () => resolve());
      logStream!.once("error", reject);
    });
  }

  function appendLog(entry: Record<string, unknown>): void {
    if (!logStream) return;
    try {
      logStream.write(JSON.stringify(entry) + "\n");
    } catch {
      // Log writes must not kill the proxy. Best effort.
    }
  }

  function redact(
    headers: Record<string, string | string[] | undefined>,
  ): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(headers)) {
      if (v === undefined) continue;
      if (redactSet.has(k.toLowerCase())) {
        const valStr = Array.isArray(v) ? v.join(",") : v;
        out[k] = `***redacted*** (len=${valStr.length})`;
      } else {
        out[k] = v;
      }
    }
    return out;
  }

  function tryParseJsonBody(buf: Buffer, contentType: string | undefined): unknown {
    if (!contentType || !contentType.toLowerCase().includes("application/json")) return undefined;
    try {
      return JSON.parse(buf.toString("utf8"));
    } catch {
      return undefined;
    }
  }

  const server: Server = createServer((clientReq, clientRes) => {
    // Snapshot upstream at request entry so a mid-request setUpstream doesn't
    // redirect in-flight calls.
    const upstream = current.url;
    const upstreamPathPrefix = current.pathPrefix;
    const upstreamIsHttps = upstream.protocol === "https:";
    const upstreamRequestFn = upstreamIsHttps ? httpsRequest : httpRequest;
    const upstreamPort = upstream.port ? Number(upstream.port) : upstreamIsHttps ? 443 : 80;

    const requestId = randomUUID();
    const startedAt = Date.now();
    const startedAtIso = new Date(startedAt).toISOString();

    const chunks: Buffer[] = [];
    clientReq.on("data", (c: Buffer) => chunks.push(c));
    clientReq.on("end", () => {
      // Wrap in an async IIFE so we can `await apiKeyProvider()` between
      // collecting the request body and starting the upstream request,
      // without restructuring the existing event-driven flow.
      void (async () => {
      const reqBodyBuf = Buffer.concat(chunks);
      const reqContentType =
        (clientReq.headers["content-type"] as string | undefined) ?? undefined;
      const reqBodyParsed = tryParseJsonBody(reqBodyBuf, reqContentType);

      const subprocessPath = clientReq.url ?? "/";
      const upstreamPath =
        upstreamPathPrefix && subprocessPath.startsWith(upstreamPathPrefix)
          ? subprocessPath
          : `${upstreamPathPrefix}${subprocessPath}`;

      // Build outgoing headers. When `apiKeyProvider` is set we skip the
      // incoming `x-api-key` / `authorization` entirely (we'll inject a fresh
      // x-api-key below) — otherwise we'd briefly forward the stale credential
      // before the override took effect on a separate header.
      const outHeaders: Record<string, string | string[]> = {};
      for (const [k, v] of Object.entries(clientReq.headers)) {
        if (v === undefined) continue;
        const lower = k.toLowerCase();
        if (lower === "host" || lower === "connection" || lower === "content-length") continue;
        if (apiKeyProvider && (lower === "x-api-key" || lower === "authorization")) continue;
        outHeaders[k] = v;
      }
      outHeaders["host"] = upstream.host;
      if (reqBodyBuf.length > 0) outHeaders["content-length"] = String(reqBodyBuf.length);

      // Per-request credential refresh. Failure must short-circuit BEFORE we
      // open the upstream socket — otherwise we'd send a request with no /
      // stale x-api-key and get a confusing 401 from upstream.
      if (apiKeyProvider) {
        let freshKey = "";
        let authError: string | undefined;
        try {
          freshKey = await apiKeyProvider();
        } catch (err) {
          authError = err instanceof Error ? err.message : String(err);
        }
        if (!authError && !freshKey) {
          authError = "apiKeyProvider returned empty string";
        }
        if (authError) {
          appendLog({
            ts: new Date().toISOString(),
            id: requestId,
            type: "auth_error",
            error: authError,
            elapsedMs: Date.now() - startedAt,
          });
          if (!clientRes.headersSent) {
            clientRes.writeHead(502, { "content-type": "application/json" });
            clientRes.end(
              JSON.stringify({
                error: { type: "auth_refresh_failed", message: authError },
              }),
            );
          } else {
            try {
              clientRes.end();
            } catch {}
          }
          return;
        }
        outHeaders["x-api-key"] = freshKey;
      }

      appendLog({
        ts: startedAtIso,
        id: requestId,
        type: "request",
        method: clientReq.method,
        url: `${upstream.protocol}//${upstream.host}${upstreamPath}`,
        upstreamPath,
        headers: redact(clientReq.headers),
        bodyBytes: reqBodyBuf.length,
        // `apiKeyRewritten` lets log readers know the x-api-key on the wire
        // wasn't the one in `headers` above. (We deliberately don't log the
        // fresh key, even redacted — it'd be the same redaction string.)
        apiKeyRewritten: apiKeyProvider ? true : undefined,
        body:
          reqBodyParsed ??
          (reqBodyBuf.length > 0 ? reqBodyBuf.toString("utf8").slice(0, 65536) : null),
      });

      const upstreamReq = upstreamRequestFn(
        {
          method: clientReq.method,
          hostname: upstream.hostname,
          port: upstreamPort,
          path: upstreamPath,
          headers: outHeaders,
        },
        (upstreamRes) => {
          appendLog({
            ts: new Date().toISOString(),
            id: requestId,
            type: "response_start",
            status: upstreamRes.statusCode,
            statusMessage: upstreamRes.statusMessage,
            headers: redact(upstreamRes.headers as Record<string, string | string[] | undefined>),
            elapsedMs: Date.now() - startedAt,
          });

          clientRes.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);

          if (logResponseBody) {
            const captured: Buffer[] = [];
            let capturedBytes = 0;
            const CAP = 1 * 1024 * 1024; // 1 MiB cap for SSE
            upstreamRes.on("data", (chunk: Buffer) => {
              clientRes.write(chunk);
              if (capturedBytes < CAP) {
                const room = CAP - capturedBytes;
                const slice = chunk.length <= room ? chunk : chunk.subarray(0, room);
                captured.push(slice);
                capturedBytes += slice.length;
              }
            });
            upstreamRes.on("end", () => {
              clientRes.end();
              appendLog({
                ts: new Date().toISOString(),
                id: requestId,
                type: "response_end",
                bodyBytes: capturedBytes,
                truncated: capturedBytes >= CAP,
                body: Buffer.concat(captured).toString("utf8"),
                elapsedMs: Date.now() - startedAt,
              });
            });
          } else {
            upstreamRes.pipe(clientRes);
            upstreamRes.on("end", () => {
              appendLog({
                ts: new Date().toISOString(),
                id: requestId,
                type: "response_end",
                elapsedMs: Date.now() - startedAt,
              });
            });
          }

          upstreamRes.on("error", (err) => {
            appendLog({
              ts: new Date().toISOString(),
              id: requestId,
              type: "response_error",
              error: err.message,
            });
            try {
              clientRes.end();
            } catch {
              // already closed
            }
          });
        },
      );

      upstreamReq.on("error", (err) => {
        appendLog({
          ts: new Date().toISOString(),
          id: requestId,
          type: "upstream_error",
          error: err.message,
        });
        if (!clientRes.headersSent) {
          clientRes.writeHead(502, { "content-type": "application/json" });
          clientRes.end(
            JSON.stringify({ error: { type: "proxy_error", message: err.message } }),
          );
        } else {
          try {
            clientRes.end();
          } catch {}
        }
      });

      if (reqBodyBuf.length > 0) upstreamReq.write(reqBodyBuf);
      upstreamReq.end();
      })();
    });

    clientReq.on("error", (err) => {
      appendLog({
        ts: new Date().toISOString(),
        id: requestId,
        type: "client_error",
        error: err.message,
      });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 0, opts.host ?? "127.0.0.1", () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("log proxy did not bind to an addressable port");
  }
  const port = address.port;
  const host = opts.host ?? "127.0.0.1";

  function getBaseUrl(): string {
    return `http://${host}:${port}${current.pathPrefix}`;
  }

  appendLog({
    ts: new Date().toISOString(),
    type: "proxy_started",
    listenUrl: getBaseUrl(),
    upstreamBaseUrl: opts.initialUpstreamBaseUrl,
    logResponseBody,
  });

  let closed = false;
  return {
    getBaseUrl,
    setUpstreamBaseUrl(url: string) {
      const next = parseUpstream(url);
      const prev = current.url.toString();
      current = next;
      if (next.url.toString() !== prev) {
        appendLog({
          ts: new Date().toISOString(),
          type: "upstream_changed",
          from: prev,
          to: next.url.toString(),
        });
      }
    },
    port,
    logFilePath: opts.logFilePath,
    close: async () => {
      if (closed) return;
      closed = true;
      appendLog({ ts: new Date().toISOString(), type: "proxy_stopping" });
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (logStream) {
        const ls = logStream;
        await new Promise<void>((resolve) => ls.end(() => resolve()));
      }
    },
  };
}
