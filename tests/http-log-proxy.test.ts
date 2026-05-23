import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server, type IncomingMessage } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startLogProxy, type LogProxyHandle } from "../src/http-log-proxy.js";

/**
 * Spin up a tiny fake upstream that echoes the path + body back as JSON,
 * exercise the proxy end-to-end via HTTP, and verify the log file contents.
 *
 * We deliberately test against an HTTP upstream (not HTTPS) so the tests run
 * without TLS setup; the proxy's https-vs-http selection is exercised by the
 * `proxy/upstream/test-upstream-https.test.ts` path... ah, just kidding, we
 * don't have one. The http path covers both branches via parseUpstream's
 * protocol check; HTTPS forwarding is verified manually against middleman.
 */
describe("http-log-proxy", () => {
  let upstream: Server;
  let upstreamPort: number;
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "pi-cas-proxy-test-"));
    upstream = createServer((req, res) => {
      // Echo back what we got, including the path + any body content.
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        res.setHeader("content-type", "application/json");
        res.setHeader("x-fake-upstream", "true");
        res.statusCode = req.url === "/route/v1/messages" ? 200 : 418;
        res.end(JSON.stringify({ echoedPath: req.url, echoedBody: body }));
      });
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", () => resolve()));
    const addr = upstream.address();
    if (!addr || typeof addr === "string") throw new Error("upstream did not bind");
    upstreamPort = addr.port;
  });

  afterAll(() => {
    upstream.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("forwards requests and writes JSONL log entries", async () => {
    const logPath = join(tmpDir, "log1.jsonl");
    const proxy: LogProxyHandle = await startLogProxy({
      initialUpstreamBaseUrl: `http://127.0.0.1:${upstreamPort}/route`,
      logFilePath: logPath,
    });
    try {
      const res = await fetch(`${proxy.getBaseUrl()}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": "super-secret-token",
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({ model: "test", messages: [{ role: "user", content: "hi" }] }),
      });
      const body = (await res.json()) as { echoedPath: string; echoedBody: string };
      expect(res.status).toBe(200);
      expect(res.headers.get("x-fake-upstream")).toBe("true");
      expect(body.echoedPath).toBe("/route/v1/messages");
      expect(JSON.parse(body.echoedBody)).toMatchObject({ model: "test" });

      // Wait a tick so the response_end log entry is flushed before we read.
      await new Promise((r) => setTimeout(r, 50));

      const lines = readFileSync(logPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
      const types = lines.map((l) => l.type);
      expect(types).toContain("proxy_started");
      expect(types).toContain("request");
      expect(types).toContain("response_start");
      expect(types).toContain("response_end");

      const req = lines.find((l) => l.type === "request");
      expect(req.method).toBe("POST");
      expect(req.upstreamPath).toBe("/route/v1/messages");
      // x-api-key must be redacted; length should still be in the log.
      expect(req.headers["x-api-key"]).toMatch(/redacted/);
      expect(req.headers["x-api-key"]).toContain("len=");
      expect(req.body).toMatchObject({ model: "test" });
    } finally {
      await proxy.close();
    }
  });

  it("setUpstreamBaseUrl swaps target for subsequent requests", async () => {
    // Stand up a second fake upstream that returns different JSON.
    const upstream2 = createServer((req, res) => {
      res.setHeader("content-type", "application/json");
      res.statusCode = 200;
      res.end(JSON.stringify({ from: "upstream2", path: req.url }));
    });
    await new Promise<void>((resolve) => upstream2.listen(0, "127.0.0.1", () => resolve()));
    const addr2 = upstream2.address();
    if (!addr2 || typeof addr2 === "string") throw new Error("upstream2 did not bind");
    const upstream2Port = (addr2 as { port: number }).port;

    const logPath = join(tmpDir, "log2.jsonl");
    const proxy = await startLogProxy({
      initialUpstreamBaseUrl: `http://127.0.0.1:${upstreamPort}/route`,
      logFilePath: logPath,
    });
    try {
      const r1 = await fetch(`${proxy.getBaseUrl()}/v1/messages`, { method: "GET" });
      const r1Body = (await r1.json()) as { echoedPath?: string; from?: string };
      expect(r1Body.echoedPath).toBe("/route/v1/messages");

      proxy.setUpstreamBaseUrl(`http://127.0.0.1:${upstream2Port}/`);

      const r2 = await fetch(`${proxy.getBaseUrl()}/v1/messages`, { method: "GET" });
      const r2Body = (await r2.json()) as { echoedPath?: string; from?: string };
      expect(r2Body.from).toBe("upstream2");

      // Verify the upstream_changed log entry was emitted.
      await new Promise((r) => setTimeout(r, 50));
      const lines = readFileSync(logPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
      const swap = lines.find((l) => l.type === "upstream_changed");
      expect(swap).toBeTruthy();
      expect(swap.to).toContain(`127.0.0.1:${upstream2Port}`);
    } finally {
      await proxy.close();
      await new Promise<void>((resolve) => upstream2.close(() => resolve()));
    }
  });

  it("captures response body when logResponseBody is true", async () => {
    const logPath = join(tmpDir, "log3.jsonl");
    const proxy = await startLogProxy({
      initialUpstreamBaseUrl: `http://127.0.0.1:${upstreamPort}/route`,
      logFilePath: logPath,
      logResponseBody: true,
    });
    try {
      const res = await fetch(`${proxy.getBaseUrl()}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ping: "pong" }),
      });
      expect(res.status).toBe(200);
      await res.text();
      await new Promise((r) => setTimeout(r, 50));

      const lines = readFileSync(logPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
      const end = lines.find((l) => l.type === "response_end");
      expect(end.body).toBeTruthy();
      expect(JSON.parse(end.body)).toMatchObject({ echoedPath: "/route/v1/messages" });
    } finally {
      await proxy.close();
    }
  });

  it("returns 502 with a structured error when upstream is unreachable", async () => {
    const logPath = join(tmpDir, "log4.jsonl");
    const proxy = await startLogProxy({
      // Port 1 is reserved; nothing should be listening.
      initialUpstreamBaseUrl: "http://127.0.0.1:1/",
      logFilePath: logPath,
    });
    try {
      const res = await fetch(`${proxy.getBaseUrl()}/v1/messages`, { method: "GET" });
      expect(res.status).toBe(502);
      const body = (await res.json()) as { error?: { type?: string } };
      expect(body.error?.type).toBe("proxy_error");

      await new Promise((r) => setTimeout(r, 50));
      const lines = readFileSync(logPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
      expect(lines.some((l) => l.type === "upstream_error")).toBe(true);
    } finally {
      await proxy.close();
    }
  });

  // ---- apiKeyProvider (per-request auth rewrite) ----
  //
  // These tests cover the second job of the proxy: rewriting `x-api-key` on
  // every forwarded request so a long-lived `claude` subprocess can ride a
  // rotating OAuth token without restart. The motivation is documented at
  // the top of http-log-proxy.ts.

  it("apiKeyProvider rewrites x-api-key and strips authorization on every forward", async () => {
    // Capture what the upstream actually receives so we can assert on the
    // rewritten headers (the subprocess's view is irrelevant — what hits
    // Anthropic is the only thing that matters for auth refresh).
    const seen: { xApiKey?: string | string[]; authorization?: string | string[] }[] = [];
    const echoUpstream = createServer((req: IncomingMessage, res) => {
      seen.push({
        xApiKey: req.headers["x-api-key"],
        authorization: req.headers["authorization"],
      });
      res.statusCode = 200;
      res.end("{}");
    });
    await new Promise<void>((resolve) => echoUpstream.listen(0, "127.0.0.1", () => resolve()));
    const echoAddr = echoUpstream.address() as { port: number };

    let callCount = 0;
    const proxy = await startLogProxy({
      initialUpstreamBaseUrl: `http://127.0.0.1:${echoAddr.port}/`,
      logFilePath: join(tmpDir, "auth-rewrite.jsonl"),
      apiKeyProvider: async () => `fresh-token-${++callCount}`,
    });

    try {
      // First call: subprocess sends a stale x-api-key AND a stale Bearer.
      // We expect upstream to see fresh-token-1 and no Authorization at all.
      await fetch(`${proxy.getBaseUrl()}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": "stale-subprocess-token",
          "authorization": "Bearer stale-bearer",
        },
        body: "{}",
      });
      // Second call: same stale headers, expect fresh-token-2 (provider
      // is invoked every request — caller decides if it wants to cache).
      await fetch(`${proxy.getBaseUrl()}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": "stale-subprocess-token",
        },
        body: "{}",
      });

      expect(seen).toHaveLength(2);
      expect(seen[0].xApiKey).toBe("fresh-token-1");
      expect(seen[0].authorization).toBeUndefined();
      expect(seen[1].xApiKey).toBe("fresh-token-2");
    } finally {
      await proxy.close();
      await new Promise<void>((resolve) => echoUpstream.close(() => resolve()));
    }
  });

  it("apiKeyProvider failure returns 502 auth_refresh_failed without hitting upstream", async () => {
    // Upstream should never see this request. If it does, we surface that
    // as a test failure (signals the short-circuit logic regressed).
    let upstreamHits = 0;
    const upstream = createServer((_req, res) => {
      upstreamHits += 1;
      res.statusCode = 200;
      res.end("{}");
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", () => resolve()));
    const addr = upstream.address() as { port: number };

    const logPath = join(tmpDir, "auth-fail.jsonl");
    const proxy = await startLogProxy({
      initialUpstreamBaseUrl: `http://127.0.0.1:${addr.port}/`,
      logFilePath: logPath,
      apiKeyProvider: async () => {
        throw new Error("refresh token revoked");
      },
    });
    try {
      const res = await fetch(`${proxy.getBaseUrl()}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": "anything" },
        body: "{}",
      });
      expect(res.status).toBe(502);
      const body = (await res.json()) as { error?: { type?: string; message?: string } };
      expect(body.error?.type).toBe("auth_refresh_failed");
      expect(body.error?.message).toContain("refresh token revoked");
      expect(upstreamHits).toBe(0);

      await new Promise((r) => setTimeout(r, 50));
      const lines = readFileSync(logPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
      expect(lines.some((l) => l.type === "auth_error" && l.error?.includes("revoked"))).toBe(true);
      // We must NOT have logged a `request` entry — the request never
      // legitimately went out, and surfacing it as a request would confuse
      // log consumers counting upstream traffic.
      expect(lines.some((l) => l.type === "request")).toBe(false);
    } finally {
      await proxy.close();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    }
  });

  it("apiKeyProvider returning empty string is treated as failure", async () => {
    const upstream = createServer((_req, res) => {
      res.statusCode = 200;
      res.end("{}");
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", () => resolve()));
    const addr = upstream.address() as { port: number };

    const proxy = await startLogProxy({
      initialUpstreamBaseUrl: `http://127.0.0.1:${addr.port}/`,
      logFilePath: join(tmpDir, "auth-empty.jsonl"),
      apiKeyProvider: async () => "",
    });
    try {
      const res = await fetch(`${proxy.getBaseUrl()}/v1/messages`);
      expect(res.status).toBe(502);
      const body = (await res.json()) as { error?: { type?: string; message?: string } };
      expect(body.error?.type).toBe("auth_refresh_failed");
      expect(body.error?.message).toContain("empty");
    } finally {
      await proxy.close();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    }
  });

  it("works without logFilePath (auth-rewrite-only mode creates no log file)", async () => {
    // Use the existing class-level upstream so we don't need another fake.
    const noLogPath = join(tmpDir, "this-should-not-exist.jsonl");
    expect(existsSync(noLogPath)).toBe(false);

    const proxy = await startLogProxy({
      initialUpstreamBaseUrl: `http://127.0.0.1:${upstreamPort}/route`,
      // logFilePath intentionally omitted
      apiKeyProvider: async () => "supplied-by-callback",
    });
    expect(proxy.logFilePath).toBeUndefined();

    try {
      const res = await fetch(`${proxy.getBaseUrl()}/v1/messages`, { method: "GET" });
      expect(res.status).toBe(200);
      await res.text();

      // No file should have been created at the absent path or anywhere
      // else the proxy might have defaulted to.
      expect(existsSync(noLogPath)).toBe(false);
    } finally {
      await proxy.close();
    }
  });
});
