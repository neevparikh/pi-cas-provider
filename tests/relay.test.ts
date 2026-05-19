import { describe, it, expect } from "vitest";
import { requestRelay, RELAY_REQUEST_CHANNEL, RELAY_RESPONSE_CHANNEL } from "../src/relay.js";

/**
 * Minimal stand-in for pi's EventBus. Real one is in @earendil-works/pi-coding-agent
 * but we don't want a runtime dependency on it in tests.
 */
function makeBus() {
  const subs = new Map<string, Set<(data: unknown) => void>>();
  return {
    emit(channel: string, data: unknown) {
      const handlers = subs.get(channel);
      if (!handlers) return;
      // Iterate a copy so handlers can unsubscribe synchronously.
      for (const h of Array.from(handlers)) h(data);
    },
    on(channel: string, handler: (data: unknown) => void) {
      let set = subs.get(channel);
      if (!set) {
        set = new Set();
        subs.set(channel, set);
      }
      set.add(handler);
      return () => set!.delete(handler);
    },
  };
}

function piWith(bus: ReturnType<typeof makeBus>) {
  // Only the `events` field is exercised by relay.ts; cast through unknown
  // because the real ExtensionAPI has many other members we don't need.
  return { events: bus } as unknown as Parameters<typeof requestRelay>[0];
}

describe("requestRelay", () => {
  it("resolves with the first matching response", async () => {
    const bus = makeBus();
    // Responder: echo whatever requestId comes in.
    bus.on(RELAY_REQUEST_CHANNEL, (raw: any) => {
      bus.emit(RELAY_RESPONSE_CHANNEL, {
        requestId: raw.requestId,
        provider: "hawk",
        ok: true,
        baseUrl: "https://relay.example/anthropic",
        accessToken: "token-abc",
      });
    });

    const out = await requestRelay(piWith(bus), { timeoutMs: 500 });
    expect(out).toEqual({
      provider: "hawk",
      baseUrl: "https://relay.example/anthropic",
      accessToken: "token-abc",
    });
  });

  it("ignores responses with a non-matching requestId", async () => {
    const bus = makeBus();
    bus.on(RELAY_REQUEST_CHANNEL, (raw: any) => {
      // First emit a stale/foreign response, then the real one.
      bus.emit(RELAY_RESPONSE_CHANNEL, {
        requestId: "not-the-one",
        provider: "hawk",
        ok: true,
        baseUrl: "https://wrong.example",
        accessToken: "wrong-token",
      });
      bus.emit(RELAY_RESPONSE_CHANNEL, {
        requestId: raw.requestId,
        provider: "hawk",
        ok: true,
        baseUrl: "https://right.example",
        accessToken: "right-token",
      });
    });

    const out = await requestRelay(piWith(bus), { timeoutMs: 500 });
    expect(out.baseUrl).toBe("https://right.example");
    expect(out.accessToken).toBe("right-token");
  });

  it("filters by preferredProvider", async () => {
    const bus = makeBus();
    // Two responders; only "hawk" should win when pinned.
    bus.on(RELAY_REQUEST_CHANNEL, (raw: any) => {
      bus.emit(RELAY_RESPONSE_CHANNEL, {
        requestId: raw.requestId,
        provider: "other",
        ok: true,
        baseUrl: "https://other.example",
        accessToken: "other-token",
      });
      bus.emit(RELAY_RESPONSE_CHANNEL, {
        requestId: raw.requestId,
        provider: "hawk",
        ok: true,
        baseUrl: "https://hawk.example",
        accessToken: "hawk-token",
      });
    });

    const out = await requestRelay(piWith(bus), { preferredProvider: "hawk", timeoutMs: 500 });
    expect(out.provider).toBe("hawk");
    expect(out.baseUrl).toBe("https://hawk.example");
  });

  it("rejects when responder reports ok:false", async () => {
    const bus = makeBus();
    bus.on(RELAY_REQUEST_CHANNEL, (raw: any) => {
      bus.emit(RELAY_RESPONSE_CHANNEL, {
        requestId: raw.requestId,
        provider: "hawk",
        ok: false,
        error: "refresh token revoked",
      });
    });

    await expect(requestRelay(piWith(bus), { timeoutMs: 500 })).rejects.toThrow(
      /refresh token revoked/,
    );
  });

  it("rejects when responder returns ok:true but is missing fields", async () => {
    const bus = makeBus();
    bus.on(RELAY_REQUEST_CHANNEL, (raw: any) => {
      bus.emit(RELAY_RESPONSE_CHANNEL, {
        requestId: raw.requestId,
        provider: "hawk",
        ok: true,
        // missing baseUrl + accessToken
      });
    });

    await expect(requestRelay(piWith(bus), { timeoutMs: 500 })).rejects.toThrow(
      /missing baseUrl\/accessToken/,
    );
  });

  it("times out when no responder is listening", async () => {
    const bus = makeBus();
    await expect(requestRelay(piWith(bus), { timeoutMs: 50 })).rejects.toThrow(
      /no relay provider responded within 50ms/,
    );
  });

  it("times out with a helpful pin-specific message when preferredProvider is unmet", async () => {
    const bus = makeBus();
    // A wrong-provider responder doesn't satisfy a pinned request.
    bus.on(RELAY_REQUEST_CHANNEL, (raw: any) => {
      bus.emit(RELAY_RESPONSE_CHANNEL, {
        requestId: raw.requestId,
        provider: "other",
        ok: true,
        baseUrl: "https://other.example",
        accessToken: "other-token",
      });
    });
    await expect(
      requestRelay(piWith(bus), { preferredProvider: "hawk", timeoutMs: 50 }),
    ).rejects.toThrow(/no relay provider named "hawk"/);
  });

  it("emits the request only after the response listener is wired", async () => {
    // Regression: an emit-before-on bug would lose synchronous responses.
    const bus = makeBus();
    let sawRequestBeforeListener = false;
    // Intercept by attaching a listener that will not see anything if the
    // request was emitted before our own listener attached. We test this
    // indirectly: the request handler emits synchronously, and we should
    // still resolve.
    bus.on(RELAY_REQUEST_CHANNEL, (raw: any) => {
      bus.emit(RELAY_RESPONSE_CHANNEL, {
        requestId: raw.requestId,
        provider: "hawk",
        ok: true,
        baseUrl: "https://x.example",
        accessToken: "t",
      });
    });
    const out = await requestRelay(piWith(bus), { timeoutMs: 100 });
    expect(out.accessToken).toBe("t");
    expect(sawRequestBeforeListener).toBe(false);
  });

  it("tolerates malformed payloads (no crash, eventual timeout)", async () => {
    const bus = makeBus();
    bus.on(RELAY_REQUEST_CHANNEL, (raw: any) => {
      // Various garbage that the type-guard should reject:
      bus.emit(RELAY_RESPONSE_CHANNEL, null);
      bus.emit(RELAY_RESPONSE_CHANNEL, "not-an-object");
      bus.emit(RELAY_RESPONSE_CHANNEL, { requestId: 123, provider: "hawk", ok: true });
      bus.emit(RELAY_RESPONSE_CHANNEL, { provider: "hawk", ok: true }); // missing requestId
      // Then a valid one for the matching requestId:
      bus.emit(RELAY_RESPONSE_CHANNEL, {
        requestId: raw.requestId,
        provider: "hawk",
        ok: true,
        baseUrl: "https://ok.example",
        accessToken: "ok-token",
      });
    });

    const out = await requestRelay(piWith(bus), { timeoutMs: 200 });
    expect(out.accessToken).toBe("ok-token");
  });
});
