/**
 * Minimal HTTP-in / HTTPS-out logging proxy.
 *
 * Use case: we control what `ANTHROPIC_BASE_URL` the bundled `claude` subprocess
 * sees, so we can point it at this proxy on localhost. The proxy logs each
 * request (method, path, headers, body) to a JSONL file and forwards to a
 * configurable upstream URL (e.g. https://middleman.prd.metr.org/anthropic).
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
 *   - The x-api-key / Authorization headers are redacted in the log.
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
  /** Path to the JSONL log file. Appended; rotated externally. */
  logFilePath: string;
  /** If true, also append response body chunks (SSE) to the log. Default false. */
  logResponseBody?: boolean;
  /** Hostname to bind. Default "127.0.0.1". */
  host?: string;
  /** Specific port (default 0 = ephemeral). */
  port?: number;
  /** Header names to redact (case-insensitive). Default: api-key / auth headers. */
  redactHeaders?: string[];
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
  /** Absolute path of the log file (for diagnostics). */
  logFilePath: string;
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

  const logStream: WriteStream = createWriteStream(opts.logFilePath, { flags: "a" });
  await new Promise<void>((resolve, reject) => {
    logStream.once("open", () => resolve());
    logStream.once("error", reject);
  });

  function appendLog(entry: Record<string, unknown>): void {
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
      const reqBodyBuf = Buffer.concat(chunks);
      const reqContentType =
        (clientReq.headers["content-type"] as string | undefined) ?? undefined;
      const reqBodyParsed = tryParseJsonBody(reqBodyBuf, reqContentType);

      const subprocessPath = clientReq.url ?? "/";
      const upstreamPath =
        upstreamPathPrefix && subprocessPath.startsWith(upstreamPathPrefix)
          ? subprocessPath
          : `${upstreamPathPrefix}${subprocessPath}`;

      const outHeaders: Record<string, string | string[]> = {};
      for (const [k, v] of Object.entries(clientReq.headers)) {
        if (v === undefined) continue;
        const lower = k.toLowerCase();
        if (lower === "host" || lower === "connection" || lower === "content-length") continue;
        outHeaders[k] = v;
      }
      outHeaders["host"] = upstream.host;
      if (reqBodyBuf.length > 0) outHeaders["content-length"] = String(reqBodyBuf.length);

      appendLog({
        ts: startedAtIso,
        id: requestId,
        type: "request",
        method: clientReq.method,
        url: `${upstream.protocol}//${upstream.host}${upstreamPath}`,
        upstreamPath,
        headers: redact(clientReq.headers),
        bodyBytes: reqBodyBuf.length,
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
      await new Promise<void>((resolve) => logStream.end(() => resolve()));
    },
  };
}
