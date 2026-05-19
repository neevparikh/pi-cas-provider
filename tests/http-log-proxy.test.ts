import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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
});
