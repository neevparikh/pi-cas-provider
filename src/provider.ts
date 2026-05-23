/**
 * Top-level provider wiring: registers the pi provider, slash commands,
 * stub tools, and orchestrates per-turn streamSimple through the Agent SDK.
 *
 * # Architecture: long-lived query() + stream-aligned segmentation + stub tools
 *
 * Two layered design decisions resolved two distinct problems:
 *
 * **Layer 1 — long-lived query() per pi session** (carried over from
 * Option A): avoids the bundled `claude` binary's resume normalizer
 * (`gG8 → iO6 → Xg5`) on every turn.  Pi-cas spawns ONE `query()` per pi
 * session and reuses it forever.  Within a single pi process, pi-cas does
 * not invoke `--resume`; turn-to-turn history is held internally by the
 * SDK.  ACROSS pi processes, when a persisted SDK session id exists from
 * a prior run, the FIRST `query()` does use `--resume <id>` to reattach.
 * In that case `ensureSession` sets `lastSentCount = max(0, n-1)` so we
 * don't double-send historical user messages.  See
 * `initialLastSentCount` for the rationale.
 *
 * **Layer 2 — stream-aligned segmentation + stub tools** (the current
 * refactor): bridges the SDK's multi-message turn (one user input → many
 * assistant messages with tools running between them) onto pi's turn-by-turn
 * loop, without pi attempting to re-execute the tools the SDK already ran.
 *
 * - The SDK runs every tool natively inside its long-lived `query()`.
 *   `tool_result` events are captured as the SDK emits them and stored in
 *   a per-session result cache (`tool-result-cache.ts`).
 * - For each CC built-in tool we expose to the model (`Bash`, `Read`,
 *   `Write`, `Edit`, `Grep`, `Glob`), pi-cas registers a *stub* pi tool of
 *   the same name (`stub-tools.ts`).  When pi's agent loop "executes" the
 *   stub, it just looks up the SDK's cached result — instant, no side
 *   effects.
 * - The event bridge (`event-bridge.ts`) closes one pi `done` per SDK
 *   assistant message instead of per turn.  Pi sees a normal
 *   text+toolCalls assistant message, runs stubs, loops streamSimple for
 *   the next segment.
 * - When pi calls streamSimple back with the resulting phantom
 *   `toolResult`s (results that originated from our stubs), pi-cas detects
 *   them and DOES NOT enqueue them to the SDK — it just consumes the next
 *   SDK assistant message from the persistent iterator.
 *
 * # Per-segment flow
 *
 *   1. Resolve the per-session `PiSession` (lazy spawn on first call).
 *   2. Detect model / permissionMode changes from prior segment → invoke
 *      `query.setModel()` / `query.setPermissionMode()`.
 *   3. Classify the new user input from `context.messages.slice(lastSentCount)`:
 *      - All-phantom (only toolResults with ids we recently emitted) →
 *        skip enqueueing; just consume the next SDK assistant message.
 *      - Real input (text/image/new user message + maybe phantom
 *        toolResults) → enqueue the real blocks into the SDK prompt
 *        iterator.
 *   4. Attach the new pi stream to the persistent event bridge.
 *   5. Consume SDK events until the bridge says the segment is ready.
 *   6. Bridge pushes `done(toolUse|stop|length)` and ends the pi stream.
 *   7. If stopReason was end_turn / length, also drain the SDK's `result`
 *      event off the iterator so it doesn't poison the next turn.
 *
 * # Lifecycle integration
 *
 *   - `session_shutdown`: tear down the long-lived query (wake the
 *     prompt-iterator gen so it returns + `query.interrupt()`).
 *   - `session_before_fork` / `session_before_compact`: tear down and clear
 *     the pi-session → SDK-session mapping so the next streamSimple spawns
 *     a fresh query (v1 limitation: model history is lost on fork).
 *
 * # Concurrency invariant
 *
 *   Pi's agent loop guarantees at most one in-flight streamSimple per
 *   session (see pi-coding-agent's agent-session.js:734).  We rely on
 *   that: the per-session promptQueue / event consumer is not re-entrant.
 */

import {
  forkSession as sdkForkSession,
  query,
  type Options,
  type Query,
} from "@anthropic-ai/claude-agent-sdk";
import {
  getModels,
  createAssistantMessageEventStream,
  type AssistantMessageEventStream,
  type Model,
  type SimpleStreamOptions,
  type Context,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { composeSystemPrompt } from "./system-prompt.js";
import { mapEffort } from "./effort.js";
import { buildThinkingConfig } from "./thinking.js";
import { buildFastModeOptions, modelSupportsFastMode } from "./settings.js";
import { createEventBridge, type EventBridge } from "./event-bridge.js";
import { getAuthStatus, formatAuthBanner, formatAuthDetails } from "./auth.js";
import { FastModeBadge } from "./badge.js";
import {
  createStubTools,
  createGenericStub,
  isValidDynamicToolName,
  SUPPORTED_CC_TOOL_NAMES,
} from "./stub-tools.js";
import { createTaskStub, TASK_TOOL_NAME } from "./task-stub.js";
import { createAutoTurnStub, AUTO_TURN_TOOL_NAME } from "./auto-turn-stub.js";
import { handleCanUseTool } from "./interactive-tools.js";
import {
  type ProviderConfig,
  createDefaultConfig,
  PROVIDER_ID,
} from "./config.js";
import {
  loadState,
  saveState,
  statePath,
  parsePermissionMode,
  getSessionMapping,
  setSessionMapping,
  clearSessionMapping,
  type PermissionMode,
} from "./persistence.js";
import { requestRelay, type RelayConfig } from "./relay.js";
import { startLogProxy, type LogProxyHandle } from "./http-log-proxy.js";

const DEBUG = process.env.PI_CAS_DEBUG === "1";

/* ----------------------------- per-session state ----------------------------- */

/**
 * State for one long-lived SDK query, scoped to a single pi session.
 *
 * Lifetime: created lazily on the first `streamSimple` for a given pi
 * session id, destroyed on `session_shutdown` or fork/compact.  Held in
 * `ProviderConfig.sessions`.
 */
interface PiSession {
  piSessionId: string;
  /** The SDK's session UUID, captured from the first `system.init` event. */
  sdkSessionId: string | undefined;
  /** Long-lived SDK query handle. */
  query: Query;
  /**
   * Persistent iterator over the SDK query's events.  CRITICAL: we obtain
   * this ONCE at session creation and reuse it across every turn's
   * streamSimple call.  Using `for await (const msg of query)` and
   * `break`ing on `result` would call `iter.return()` and CLOSE the
   * generator, preventing all subsequent turns from receiving events.
   * This was confirmed empirically against the SDK's iterator semantics.
   */
  iter: AsyncIterator<any>;
  /**
   * In-flight `iter.next()` promise that the previous drain operation
   * started but didn't consume (because it timed out waiting for an
   * event).  Reused by the next read so we don't lose events.  Cleared
   * once consumed.  See `drainPendingAutoTriggers` and the main consume
   * loop.
   */
  pendingIterPromise: Promise<IteratorResult<any>> | undefined;
  /**
   * Persistent event bridge that consumes SDK events and emits pi events
   * in segment-aligned chunks (one pi `done` per SDK assistant message).
   * Created once per pi session and reused across every streamSimple call.
   */
  bridge: EventBridge;
  /**
   * Tool-use ids emitted on the most recently closed segment.  Used to
   * recognize "phantom" toolResult messages from pi (results from our stub
   * tools running) on the next streamSimple call, so we don't accidentally
   * forward them to the SDK as new user content.
   */
  recentlyEmittedToolUseIds: Set<string>;
  /**
   * Tool-use ids the bridge SYNTHESISED into the most recently closed
   * segment (for auto-turn injection — see `auto-turn-stub.ts`).  The
   * provider uses these so `classifyNewContent` can recognise the
   * resulting tool_result messages as "synthetic phantoms" (drop them
   * entirely; don't expect the SDK to produce more for them, since the
   * SDK never knew about these tool calls).
   */
  recentlySyntheticToolUseIds: Set<string>;
  /** FIFO queue of pending user messages to yield into the AsyncIterable. */
  promptQueue: Array<{ content: any; resolved: () => void; failed: (e: any) => void }>;
  /** Resolver for the awaitable inside the prompt-gen loop. */
  genWaker: (() => void) | null;
  /** Signals the gen to return (clean shutdown). */
  ended: boolean;

  cwd: string;
  /** Last-known model id for change detection across turns. */
  model: string;
  /** Last-known permissionMode for change detection across turns. */
  permissionMode: PermissionMode;
  /**
   * How many of pi's messages we've already consumed.  Each `streamSimple`
   * call processes `context.messages.slice(lastSentCount)` to extract the
   * new user input.
   *
   * - Fork: when pi forks, a fresh `PiSession` is constructed for the new
   *   branch (different pi session id); the fresh session's
   *   `initialLastSentCount` handles the count, and the SDK session is
   *   re-attached via `forkSession()` (see `session_before_fork` handler).
   * - Compact: pi compacts its message list in place.  The next
   *   `streamSimple` call will have a shorter `messages` array than our
   *   `lastSentCount` was tracking — without intervention,
   *   `classifyNewContent` would slice past the end and see "empty".  We
   *   set {@link needsLastSentReset} in `session_before_compact` so the next
   *   streamSimple reseats `lastSentCount` to `max(0, messages.length - 1)`
   *   (same logic as `initialLastSentCount`).
   */
  lastSentCount: number;
  /**
   * Set by the `session_before_compact` handler.  Tells the next
   * `streamSimple` call to re-seat {@link lastSentCount} to N-1 of the
   * compacted message list before classifying new content.  Cleared after
   * the reset.
   */
  needsLastSentReset?: boolean;
}

/* ----------------------------- registration ----------------------------- */

export function registerProvider(pi: ExtensionAPI): void {
  // Module-level config; slash commands mutate this.
  const config: ProviderConfig = createDefaultConfig();

  // Track which stub-tool names we've registered with pi (statically + via
  // the dynamic catch-all path).  Used by registerDynamicStub to dedupe.
  // Seeded from SUPPORTED_CC_TOOL_NAMES below after the named stubs are
  // registered.
  const registeredStubNames = new Set<string>();

  // Most-recently-seen ExtensionContext, captured from event handlers.
  //
  // # Why
  //
  // The SDK's `canUseTool` callback (see `interactive-tools.ts`) needs to
  // render pi-tui UI to handle interactive tools like `AskUserQuestion`,
  // but `canUseTool` is invoked by the SDK with no `ctx` argument, and
  // pi's `ExtensionAPI` has no global `.ui` accessor — the UI is only
  // accessible through `ctx: ExtensionContext` passed to event handlers.
  //
  // We bridge by subscribing to early-firing handlers (`before_agent_start`,
  // `turn_start`, `message_start`, `tool_execution_start`) and stashing the
  // most recent `ctx` here.  By the time the SDK invokes canUseTool for a
  // mid-stream `AskUserQuestion`, at least one of those events has fired in
  // the current turn and `current` is set.
  //
  // # Cross-session caveat
  //
  // Pi has one UI per process; a single ExtensionContext.ui works across
  // sessions.  But `ctx` itself carries session-scoped fields (cwd,
  // sessionManager, model, abort signal) which can be stale if we hold it
  // across a session switch.  For UI overlay purposes (`ctx.ui.custom`),
  // staleness is harmless — pi's TUI is process-wide.  If we ever start
  // using session-scoped fields from the captured ctx, we'll need
  // per-session tracking.
  const ctxRef: { current?: ExtensionContext } = {};

  // In-process HTTP proxy. Started lazily when either:
  //   - `PI_CAS_HTTP_LOG` is set (the classic logging use case), OR
  //   - okta relay mode is on (the proxy rewrites `x-api-key` per-request
  //     so the long-lived `claude` subprocess can keep using a stable
  //     ANTHROPIC_API_KEY while the underlying OAuth token rotates).
  //
  // Both knobs are independent: turn on logging without okta to capture a
  // session's HTTP traffic, or turn on okta without logging to get
  // auto-refresh without writing a log file. When both are on, the proxy
  // does both jobs in one server.
  //
  // Token cache lives on `config` (see ProviderConfig.oktaTokenCache) so
  // ensureSession — which is a top-level function reached through
  // streamViaSDK — can seed it after the per-session relay call.
  if (config.oktaEnabled && !config.oktaTokenCache) {
    config.oktaTokenCache = { fetchedAt: 0 };
  }
  // 60s is short relative to the JWT TTL (~24h in pi-hawk-provider's
  // current config) but long enough that a burst of upstream calls during
  // a single SDK turn doesn't issue 50 event-bus round-trips. The relay
  // responder (pi-hawk-provider) has its own cache against the JWT's
  // `expires` field so an actual Okta refresh-grant only fires when the
  // JWT is genuinely near expiry — this layer just spares the event bus.
  const TOKEN_CACHE_TTL_MS = 60_000;
  const oktaApiKeyProvider: (() => Promise<string>) | undefined = config.oktaEnabled
    ? async () => {
        const cache = config.oktaTokenCache!;
        if (cache.token && Date.now() - cache.fetchedAt < TOKEN_CACHE_TTL_MS) {
          return cache.token;
        }
        const r = await requestRelay(pi, {
          preferredProvider: config.oktaProvider,
          timeoutMs: 8000,
        });
        cache.token = r.accessToken;
        cache.fetchedAt = Date.now();
        config.lastOktaProvider = r.provider;
        config.lastOktaBaseUrl = r.baseUrl;
        // Keep proxy upstream in sync. The relay responder is currently
        // expected to return a stable baseUrl per session, but treating it
        // as authoritative on each refresh costs nothing and would absorb
        // any future endpoint rotation transparently.
        if (logProxyHandle) logProxyHandle.setUpstreamBaseUrl(r.baseUrl);
        return r.accessToken;
      }
    : undefined;

  let logProxyHandle: LogProxyHandle | undefined;
  let logProxyPromise: Promise<LogProxyHandle> | undefined;
  const httpLogPath = process.env.PI_CAS_HTTP_LOG?.trim();
  if (httpLogPath || config.oktaEnabled) {
    const logResponseBody =
      process.env.PI_CAS_HTTP_LOG_RESPONSES === "1" ||
      process.env.PI_CAS_HTTP_LOG_RESPONSES === "true";
    logProxyPromise = startLogProxy({
      initialUpstreamBaseUrl: "https://api.anthropic.com",
      ...(httpLogPath ? { logFilePath: httpLogPath } : {}),
      logResponseBody,
      ...(oktaApiKeyProvider ? { apiKeyProvider: oktaApiKeyProvider } : {}),
    });
    logProxyPromise.then(
      (h) => {
        logProxyHandle = h;
        const logSuffix = h.logFilePath
          ? `log: ${h.logFilePath}${logResponseBody ? " (with response bodies)" : ""}`
          : "no log file (auth-rewrite only)";
        const authSuffix = oktaApiKeyProvider ? " · auth-rewrite ON (okta relay)" : "";
        console.error(
          `[pi-cas] HTTP proxy listening on ${h.getBaseUrl()} → (per-turn upstream); ` +
            `${logSuffix}${authSuffix}`,
        );
      },
      (err) =>
        console.error(
          `[pi-cas] HTTP proxy failed to start: ${
            err instanceof Error ? err.message : String(err)
          } — continuing without it`,
        ),
    );
  }

  const auth = getAuthStatus();
  console.error(
    `[pi-cas] ${formatAuthBanner(auth, {
      okta: { enabled: config.oktaEnabled, provider: config.oktaProvider },
    })}`,
  );
  if (config.fastMode) {
    const env = process.env.PI_CAS_FAST_MODE;
    const source =
      env === "1" || env === "true"
        ? "PI_CAS_FAST_MODE"
        : `persisted preference (${statePath()})`;
    console.error(`[pi-cas] fast mode enabled at startup — source: ${source}`);
  }
  console.error(`[pi-cas] permissionMode=${config.permissionMode}`);
  if (config.configDirOverride) {
    console.error(`[pi-cas] CLAUDE_CONFIG_DIR override: ${config.configDirOverride}`);
  }
  if (config.apiKeyOverride) {
    console.error("[pi-cas] ANTHROPIC_API_KEY override active (PI_CAS_API_KEY)");
  }
  if (config.baseUrlOverride) {
    console.error(`[pi-cas] ANTHROPIC_BASE_URL override: ${config.baseUrlOverride}`);
  }
  if (config.oktaEnabled) {
    const who = config.oktaProvider ? `provider=${config.oktaProvider}` : "any responder";
    console.error(
      `[pi-cas] okta relay mode ON (${who}) — bypassing local Claude Code auth, ` +
        `routing subprocess through pi-cas:relay-request responder`,
    );
  }

  const badge = new FastModeBadge(pi);
  badge.update({ intent: config.fastMode });

  // Register stub tools that pi's agent loop will "execute" by retrieving
  // SDK-cached results.  See `stub-tools.ts` for the full rationale.
  for (const tool of createStubTools()) {
    pi.registerTool(tool);
    registeredStubNames.add(tool.name);
  }
  // Pre-register the Task stub with its rich subagent-transcript
  // renderer (see `src/task-stub.ts`).  Pre-registering — instead of
  // letting the catch-all path handle it — gives us a hand-tuned
  // schema (description/prompt/subagent_type are spelled out), a nice
  // label, and the custom renderResult that shows the captured
  // subagent transcript.
  const taskStub = createTaskStub();
  pi.registerTool(taskStub);
  registeredStubNames.add(taskStub.name);
  // Register the AutoTurn stub.  This stub is NEVER invoked by the model —
  // pi-cas's event bridge synthesises tool_use blocks for it when it
  // absorbs auto-triggered turns (Monitor stdout, backgrounded Bash
  // completion, etc.) and injects them into the next user-response
  // assistant message.  See `src/auto-turn-stub.ts` for the renderer.
  const autoTurnStub = createAutoTurnStub();
  pi.registerTool(autoTurnStub);
  registeredStubNames.add(autoTurnStub.name);
  if (DEBUG) {
    console.error(
      `[pi-cas/debug] registered ${SUPPORTED_CC_TOOL_NAMES.length} stub tools: ` +
        SUPPORTED_CC_TOOL_NAMES.join(", ") +
        `, plus ${TASK_TOOL_NAME} (rich renderer), plus ${AUTO_TURN_TOOL_NAME} ` +
        `(synthetic auto-turn renderer)`,
    );
  }

  // Catch-all stub registration.  Called by the event bridge the first time
  // the SDK emits a tool_use block whose name isn't in the statically
  // registered set above (e.g. a skill activation surfaces a new tool, or a
  // future CC release ships a tool we didn't anticipate).  Without this,
  // pi's agent loop would crash with `Tool <name> not found` because we
  // never registered a handler.
  //
  // We use pi's mid-session `registerTool` (extension-loader.js:178-185:
  // sets the tool in the extension's map and calls refreshTools).  The
  // registration completes synchronously before the bridge closes the
  // current segment, so pi sees the stub by the time it processes the
  // `done` event for the assistant message containing the tool_use.
  //
  // Names are validated via isValidDynamicToolName (PascalCase /
  // mcp__server__tool shape) — a defensive belt against malformed names
  // that could collide with pi's internal conventions or break tool
  // matching in pi's UI.  If a name fails validation, we log loudly and
  // skip registration; pi will crash at execute time as it would have
  // without this feature, but operators will see WHY in stderr.
  config.registerDynamicStub = (toolName: string): void => {
    if (registeredStubNames.has(toolName)) return;
    if (!isValidDynamicToolName(toolName)) {
      console.warn(
        `[pi-cas] SDK emitted tool_use with name "${toolName}" that does ` +
          "not match the expected shape (PascalCase / mcp__server__tool). " +
          "Pi will crash when it tries to execute this tool.  If this is a " +
          "legitimate tool name, file a bug — pi-cas's validation needs " +
          "updating.",
      );
      return;
    }
    registeredStubNames.add(toolName);
    try {
      pi.registerTool(createGenericStub(toolName));
    } catch (err) {
      console.error(
        `[pi-cas] failed to register catch-all stub for "${toolName}": ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      // Remove from the set so a subsequent attempt could retry, in case
      // the failure was transient.
      registeredStubNames.delete(toolName);
      return;
    }
    console.warn(
      `[pi-cas] registered catch-all stub for SDK-emitted tool "${toolName}" ` +
        "(not in SUPPORTED_CC_TOOL_NAMES).  Note: due to pi-agent-core's " +
        "one-shot tool snapshot per prompt, the FIRST occurrence of this " +
        "tool in the current prompt will surface as `Tool not found` — " +
        "the stub becomes effective on the next prompt.  If this tool is " +
        "a CC built-in (not MCP), add it to TOOL_METADATA in stub-tools.ts.",
    );
  };

  // Register a `tool_result` event handler so the SDK's `is_error` flag
  // on each tool_result propagates to pi's ToolResultMessage.isError.
  // The stub tool (named or dynamic catch-all) stuffs the flag into
  // `details._piCasIsError`; we read it here and return an override.
  // (AgentTool.execute has no `isError` return field — pi infers isError
  // from whether execute() throws.  Throwing would lose the SDK's
  // structured details, so we use this post-hoc override instead.)
  //
  // We gate on the PRESENCE of `_piCasIsError` (not on whether the tool
  // name is one of ours) so the path covers both named stubs AND
  // dynamically-registered catch-all stubs — the latter wouldn't match
  // `isSupportedStubTool`.  The flag itself is the unique marker that
  // tells us "this tool_result came from pi-cas".
  pi.on("tool_result", (event) => {
    const details = event.details as Record<string, unknown> | undefined;
    const flag = details?._piCasIsError;
    if (typeof flag === "boolean") {
      return { isError: flag };
    }
    return undefined;
  });

  // Capture the latest ExtensionContext so the SDK's canUseTool callback
  // (see `interactive-tools.ts`) can render pi-tui UI.  See `ctxRef`
  // docstring above.  We subscribe to several early-firing events so we
  // have a fresh ctx by the time any interactive tool_use arrives.
  const captureCtx = (_event: unknown, ctx: ExtensionContext) => {
    ctxRef.current = ctx;
  };
  pi.on("before_agent_start", captureCtx);
  pi.on("turn_start", captureCtx);
  pi.on("message_start", captureCtx);
  pi.on("tool_execution_start", captureCtx);
  // Expose the getter so the SDK options builder (in ensureSession) can
  // attach `canUseTool` without holding the ctxRef closure directly.
  config.getLatestCtx = () => ctxRef.current;

  // Lifecycle: tear down on shutdown / fork / compact.  See module docstring.
  registerLifecycleHooks(pi, config);

  registerSlashCommands(pi, config, badge);

  // Propagate `thinkingLevelMap` from the upstream model defs (e.g.
  // `{ "xhigh": "xhigh" }` for claude-opus-4-7). Without this field pi's
  // `setThinkingLevel` clamps requested levels against a default
  // [low,medium,high] set and silently downgrades anything higher —
  // pirouette's footer ends up showing "xhigh" on the persisted
  // (clamped-before) side and "high" on the live-session side. See
  // pi-hawk-provider commit 5b75551 for the same fix.
  const models = getModels("anthropic").map((m) => ({
    id: m.id,
    name: m.name,
    reasoning: m.reasoning,
    ...(m.thinkingLevelMap ? { thinkingLevelMap: m.thinkingLevelMap } : {}),
    input: m.input,
    cost: m.cost,
    contextWindow: m.contextWindow,
    maxTokens: m.maxTokens,
  }));

  // Pi requires *some* env-resolvable apiKey for footer auth-presence.  Our
  // real auth is whatever the `claude` subprocess uses; this is a sentinel.
  if (!process.env.PI_CAS_UNUSED) {
    process.env.PI_CAS_UNUSED = "managed-by-claude-subprocess";
  }

  pi.registerProvider(PROVIDER_ID, {
    name: "Claude (via Agent SDK)",
    baseUrl: PROVIDER_ID,
    apiKey: "PI_CAS_UNUSED",
    api: PROVIDER_ID as any,
    models,
    streamSimple: (model, context, options) =>
      streamViaSDK(pi, model, context as Context, options, config, badge, logProxyPromise),
  });
}

/* ----------------------------- lifecycle ----------------------------- */

function registerLifecycleHooks(pi: ExtensionAPI, config: ProviderConfig): void {
  pi.on("session_shutdown", async (event) => {
    if (DEBUG) console.error(`[pi-cas/debug] session_shutdown reason=${event.reason}`);
    for (const [piId, session] of config.sessions) {
      await teardownSession(session, `session_shutdown(${event.reason})`);
      // Mapping policy:
      //   - "quit": hard shutdown.  Keep the mapping so the next pi launch
      //     can resume.
      //   - "reload": `/reload` rebuilds the extension runtime but keeps the
      //     SAME pi session id / session file.  Keep the mapping so the
      //     reloaded extension's first streamSimple resumes the existing
      //     SDK transcript — otherwise the model loses all prior context
      //     even though pi's visible transcript is unchanged.
      //   - "fork": the OLD session is being abandoned for a new one.  Keep
      //     the mapping for the old pi session id, since the user might
      //     navigate back to it later.  The fork itself was already wired up
      //     in `session_before_fork` (forkSession + pendingFork stash); the
      //     NEW pi session id will pick that up on its first streamSimple.
      //   - "new" / "resume": the pi session is being replaced wholesale
      //     (different session file).  Clear the mapping so the next
      //     pi-cas session for this id starts fresh.
      if (
        event.reason !== "quit" &&
        event.reason !== "reload" &&
        event.reason !== "fork"
      ) {
        clearSessionMapping(piId);
      }
    }
    config.sessions.clear();
  });

  pi.on("session_before_fork", async (event) => {
    if (DEBUG) {
      console.error(
        `[pi-cas/debug] session_before_fork entry=${event.entryId} position=${event.position}`,
      );
    }
    // Goal: preserve the model's prior history on the forked branch.
    //
    // Strategy (v2 — was: tear down + lose history):
    //   1. For each active session with an established SDK session id, call
    //      the SDK's `forkSession()` to create a NEW SDK session that's a
    //      copy of the current one.  This produces a fresh sessionId we can
    //      later resume into.
    //   2. Stash that forked sessionId in `config.pendingFork`.  The next
    //      `streamSimple` for a new pi session id (the forked branch) will
    //      see the pending fork, resume into the forked SDK session, and
    //      clear the stash.
    //   3. Tear down the current SDK query — pi is shutting this session
    //      down to construct the fork.  Don't clear the original mapping
    //      (the user may navigate back to the source branch).
    //
    // **Tradeoff (documented in README "Known caveats"):** we currently
    // copy the FULL SDK session, not "up to the fork entry id" — there's no
    // pi-entry-id → SDK-message-uuid map yet (write_up.md "Open paths").
    // So the model on the forked branch may have slightly more context
    // than pi's truncated branch UI shows.  This is generally benign (more
    // context = better answer) but can surprise the user.  Future work:
    // bookkeeping + `forkSession({ upToMessageId })`.
    //
    // Failure mode: if `forkSession()` throws (e.g. SDK transcript not yet
    // on disk, session id missing), we fall back to the v1 behavior — tear
    // down + clear mapping — and the forked branch starts with no model
    // history.  Logged as a warning visible without DEBUG so operators
    // notice.
    for (const [piId, session] of config.sessions) {
      const sdkId = session.sdkSessionId;
      if (sdkId) {
        try {
          const result = await sdkForkSession(sdkId);
          config.pendingFork = {
            sourcePiSessionId: piId,
            forkedSdkSessionId: result.sessionId,
          };
          if (DEBUG) {
            console.error(
              `[pi-cas/debug] forkSession(${sdkId}) → ${result.sessionId}; ` +
                `pendingFork stashed for next streamSimple`,
            );
          }
        } catch (err) {
          console.warn(
            `[pi-cas] forkSession(${sdkId}) failed: ${
              err instanceof Error ? err.message : String(err)
            }.  Forked branch will start without model history.`,
          );
          // Fall back to v1 behavior for this session: clear the mapping so
          // the new pi session spawns fresh, no resume.
          clearSessionMapping(piId);
        }
      } else {
        if (DEBUG) {
          console.error(
            `[pi-cas/debug] session_before_fork: no sdkSessionId for ${piId}; ` +
              `nothing to fork (forked branch will start fresh)`,
          );
        }
        // No SDK session ever materialized; nothing to fork.  Clear any
        // stale mapping that might exist on disk for this id.
        clearSessionMapping(piId);
      }
      await teardownSession(session, "session_before_fork");
    }
    config.sessions.clear();
    // Don't cancel the fork — return without a result/decision means "proceed".
  });

  pi.on("session_before_compact", async () => {
    if (DEBUG) console.error(`[pi-cas/debug] session_before_compact`);
    // Strategy: DON'T tear down.  Pi compacts its own visible transcript;
    // the SDK keeps its full internal history.  The next user prompt is
    // sent to the SDK as a normal user message, and the SDK responds with
    // full prior context.
    //
    // We DO need to fix up `lastSentCount`: after compact, pi's
    // `context.messages` is much shorter (replaced with a summary entry +
    // recent tail).  Our stale `lastSentCount` would slice past the end
    // and report `kind: "empty"`, causing pi to see an empty assistant
    // message.  Set the `needsLastSentReset` flag so the next streamSimple
    // reseats `lastSentCount` to N-1 (treat like a fresh resume).
    //
    // **Tradeoff (documented in README "Known caveats"):** the SDK keeps
    // its full uncompacted history.  Pi's UI shows the compacted summary,
    // but the model uses the full transcript.  This is mostly a feature
    // (better answers), but it does mean compaction doesn't shrink token
    // usage on the SDK side.  If a session approaches the SDK's own
    // context limit, the SDK has its OWN auto-compaction (controlled by
    // `autoCompactThreshold` in CC's settings).  Future work: forward
    // pi's compact event to the SDK via `/compact` user-message slash
    // command so the two views stay in sync.
    for (const session of config.sessions.values()) {
      session.needsLastSentReset = true;
    }
  });
}

/**
 * Cleanly tear down a long-lived SDK query.  Best-effort: never throws.
 */
/**
 * Drain auto-trigger turns from the SDK iter until iter goes "quiet"
 * (no events available within `timeoutMs`).
 *
 * # Why we need this
 *
 * The bridge's state-machine classifier (auto_triggered vs user_response)
 * keys off whether `sdkState` was "idle" at push time.  But pi-cas only
 * reads from iter inside `streamSimple`'s consume loop.  If notifications
 * (Monitor stdout, backgrounded Bash completion, scheduled wakeup, etc.)
 * fired during pi's idle period, the resulting auto-trigger turns are
 * QUEUED in iter but the bridge hasn't observed them yet.  At push time,
 * the bridge's `sdkState` is stale ("idle" because last thing it saw was
 * a result event), and the bridge would incorrectly claim the first
 * post-push iter event (which is actually the first buffered auto-
 * trigger's status=requesting) as the user-response turn.
 *
 * To fix this: BEFORE notePush, drain everything that's already buffered.
 * No push is pending during the drain, so every turn the bridge processes
 * gets classified as auto_triggered (buffered, not pushed to pi stream).
 * After the drain, the bridge's view is consistent with iter, and the
 * post-push turn classification works correctly.
 *
 * # Timeout-based "quiet" detection
 *
 * We race `iter.next()` against a `setTimeout`.  If iter resolves first,
 * we have an event — process it and loop.  If timeout fires first, we
 * assume iter is quiet (no buffered events).  We stash the in-flight
 * iter.next() promise on the session so the next read (in the consume
 * loop or a subsequent drain) doesn't lose its eventual value.
 *
 * `timeoutMs` of ~100-200ms is a good balance: long enough to not race
 * with normal API latency for buffered events (which the SDK delivers
 * synchronously once we read), short enough to add negligible UX latency.
 */
async function drainPendingAutoTriggers(
  session: PiSession,
  timeoutMs: number,
): Promise<void> {
  const TIMEOUT_SENTINEL = Symbol("drain-timeout");
  let drained = 0;
  let drainStart = Date.now();
  while (true) {
    if (!session.pendingIterPromise) {
      session.pendingIterPromise = session.iter.next();
    }
    let timer: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<typeof TIMEOUT_SENTINEL>((resolve) => {
      timer = setTimeout(() => resolve(TIMEOUT_SENTINEL), timeoutMs);
    });
    const result = await Promise.race([
      session.pendingIterPromise,
      timeoutPromise,
    ]);
    if (timer) clearTimeout(timer);
    if (result === TIMEOUT_SENTINEL) {
      // Iter is quiet — leave pendingIterPromise in flight for next read.
      if (DEBUG && drained > 0) {
        console.error(
          `[pi-cas/debug] drain done: ${drained} event(s) in ${Date.now() - drainStart}ms`,
        );
      }
      return;
    }
    // We got an iter event.  Clear pending slot and process.
    session.pendingIterPromise = undefined;
    if (result.done) {
      if (DEBUG) {
        console.error(`[pi-cas/debug] drain: iter ended unexpectedly`);
      }
      return;
    }
    session.bridge.handle(result.value);
    drained++;
  }
}

async function teardownSession(session: PiSession, reason: string): Promise<void> {
  if (session.ended) return;
  session.ended = true;
  if (DEBUG) console.error(`[pi-cas/debug] teardown ${session.piSessionId} (${reason})`);

  // Wake the gen so it exits its await.
  if (session.genWaker) {
    const w = session.genWaker;
    session.genWaker = null;
    w();
  }
  // Reject any queued prompts so callers don't hang.
  for (const item of session.promptQueue.splice(0)) {
    item.failed(new Error(`pi-cas session torn down: ${reason}`));
  }
  // Interrupt to unblock any in-flight model turn quickly.
  try {
    await session.query.interrupt();
  } catch {
    /* already done or never started */
  }
}

/* ----------------------------- streamSimple ----------------------------- */

function streamViaSDK(
  pi: ExtensionAPI,
  model: Model<any>,
  context: Context,
  options: SimpleStreamOptions | undefined,
  config: ProviderConfig,
  badge: FastModeBadge,
  logProxyPromise: Promise<LogProxyHandle> | undefined,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();

  void (async () => {
    const piSessionId = (options as any)?.sessionId ?? "default";
    const cwd = (options as any)?.cwd ?? process.cwd();

    if (DEBUG) {
      console.error(
        `[pi-cas/debug] streamSimple: pi=${piSessionId} model=${model.id} ` +
          `msgs=${context.messages.length} sys=${(context.systemPrompt ?? "").length}b`,
      );
    }

    // 1. Resolve or spawn the per-session long-lived query.
    let session: PiSession;
    try {
      session = await ensureSession(
        pi,
        piSessionId,
        cwd,
        model,
        context,
        options,
        config,
        logProxyPromise,
      );
    } catch (err: any) {
      pushError(stream, model, err?.message ?? String(err));
      return;
    }

    // 2. Detect mid-session model / permissionMode changes and apply.
    try {
      if (session.model !== model.id) {
        if (DEBUG) console.error(`[pi-cas/debug] setModel: ${session.model} → ${model.id}`);
        await session.query.setModel(model.id);
        session.model = model.id;
      }
      if (session.permissionMode !== config.permissionMode) {
        if (DEBUG) {
          console.error(
            `[pi-cas/debug] setPermissionMode: ${session.permissionMode} → ${config.permissionMode}`,
          );
        }
        await session.query.setPermissionMode(config.permissionMode);
        session.permissionMode = config.permissionMode;
      }
    } catch (err: any) {
      // Control-plane errors aren't fatal; log and continue with stale settings.
      console.error(
        `[pi-cas] warning: control API call failed (${err?.message ?? err}); continuing with prior settings`,
      );
    }

    // 3. Compact-recovery: if pi compacted its history while this session
    // was alive (`session_before_compact` fired), our `lastSentCount` is
    // stale relative to the new (shorter) message list.  Re-seat to N-1
    // (same logic as `initialLastSentCount` for a fresh resume) so we send
    // only the trailing user message and the SDK supplies the model's full
    // pre-compact context internally.
    if (session.needsLastSentReset) {
      const before = session.lastSentCount;
      session.lastSentCount = initialLastSentCount(context.messages.length);
      session.needsLastSentReset = false;
      if (DEBUG) {
        console.error(
          `[pi-cas/debug] post-compact lastSentCount reset: ${before} → ` +
            `${session.lastSentCount} (messages.length=${context.messages.length})`,
        );
      }
    }

    // 4. Classify the new pi-side content since lastSentCount.
    const classification = classifyNewContent(
      context.messages,
      session.lastSentCount,
      session.recentlyEmittedToolUseIds,
      session.recentlySyntheticToolUseIds,
    );
    session.lastSentCount = context.messages.length;

    if (DEBUG) {
      console.error(
        `[pi-cas/debug] classify: kind=${classification.kind} ` +
          `realBlocks=${classification.realUserBlocks.length} ` +
          `phantomIds=${classification.phantomToolResultIds.length} ` +
          `syntheticPhantomIds=${classification.syntheticPhantomToolResultIds.length} ` +
          `unexpectedIds=${classification.unexpectedToolResultIds.length}`,
      );
    }

    if (classification.unexpectedToolResultIds.length > 0) {
      // Visible without DEBUG: this means pi is feeding us tool results
      // we don't recognize as ours.  Either a pi extension is injecting
      // them, the recently-emitted set is stale (e.g., process restart
      // mid-turn), or there's a bug in classification.  Either way it
      // signals divergence between pi's and the SDK's view of which tools
      // ran, so operators need to know in production.
      console.warn(
        `[pi-cas] unexpected toolResult ids (not in recently-emitted set): ` +
          classification.unexpectedToolResultIds.join(", "),
      );
    }

    // 4. Hook up abort.
    const abortListener = () => {
      session.query.interrupt().catch(() => {});
    };
    if (options?.signal) {
      if (options.signal.aborted) {
        abortListener();
      } else {
        options.signal.addEventListener("abort", abortListener, { once: true });
      }
    }

    // 5. Decide what to do based on classification.
    //
    //   - "phantom": pi is calling us back after running stub tools.  Don't
    //     enqueue — just consume the next SDK assistant message.
    //   - "real": pi has new user content (text/image/etc).  Enqueue it.
    //   - "empty": no new content at all (no-op call).  Push empty done.
    if (classification.kind === "empty") {
      const empty: any = makeEmptyAssistantMessage(model);
      stream.push({ type: "done", reason: "stop", message: empty } as any);
      stream.end();
      if (options?.signal) options.signal.removeEventListener("abort", abortListener);
      return;
    }

    let enqueuePromise: Promise<void> | undefined;
    if (classification.kind === "real") {
      // BEFORE pushing: drain any auto-trigger turns that were buffered
      // in iter from notifications fired during pi's idle time.  Each
      // drained turn gets classified as auto_triggered by the bridge
      // (push queue empty at status=requesting time) and absorbed into
      // bufferedAutoTurns.  After draining, our notePush correctly marks
      // sdkState=idle (drain ended on a result + no more events), so the
      // NEXT turn from iter (which is the user-response) is classified
      // correctly.  See `drainPendingAutoTriggers` for the timeout-based
      // "iter is quiet" detection.
      await drainPendingAutoTriggers(session, 150);

      enqueuePromise = new Promise<void>((resolve, reject) => {
        session.promptQueue.push({
          content: classification.realUserBlocks,
          resolved: resolve,
          failed: reject,
        });
        if (session.genWaker) {
          const w = session.genWaker;
          session.genWaker = null;
          w();
        }
      });
      // Tell the bridge a push just happened.  The bridge uses this to
      // discriminate the SDK turn that's responding to this push from
      // auto-triggered turns that may still be in iter.  See
      // `event-bridge.ts:noteStatusRequesting`.
      session.bridge.notePush(Date.now());
    }
    // If kind === "phantom", we just consume more SDK events with no enqueue.
    // The SDK is mid-turn (between assistant messages, internally running
    // tools); the next event we read will be the next assistant message_start.

    // 6. Attach the persistent bridge to the new pi stream and consume
    //    SDK events until the bridge signals "segment ready".
    // Pass the current segment's model into the bridge so that output.model
    // and cost calculation reflect any mid-session model switch we applied
    // above (session.query.setModel).
    session.bridge.attachStream(stream, model);
    try {
      if (enqueuePromise) {
        // Wait until the gen has actually yielded our message before we
        // start consuming — otherwise a still-in-flight prior segment's
        // tail could leak into ours.  enqueuePromise resolves inside the
        // gen body after `yield` returns control.
        await enqueuePromise;
      }

      // Consume events into the bridge until either a segment closes
      // (message_stop + all tool_results paired) OR the turn ends without
      // any segment (empty/error turn).
      while (!session.bridge.isSegmentReady() && !session.bridge.isTurnDone()) {
        // Use pendingIterPromise if the drain left an in-flight read.
        const iterPromise =
          session.pendingIterPromise ?? session.iter.next();
        session.pendingIterPromise = undefined;
        const next = await iterPromise;
        if (next.done) {
          if (DEBUG) console.error(`[pi-cas/debug] iter exhausted unexpectedly`);
          break;
        }
        const msg = next.value;
        if (DEBUG && msg.type === "result" && msg.is_error) {
          console.error(
            `[pi-cas/debug] error result:`,
            JSON.stringify({ subtype: msg.subtype, result: msg.result }, null, 2),
          );
        }
        // Capture sdk_session_id from the first init event we see.
        if (
          !session.sdkSessionId &&
          msg.type === "system" &&
          msg.subtype === "init" &&
          msg.session_id
        ) {
          session.sdkSessionId = msg.session_id;
          setSessionMapping(session.piSessionId, msg.session_id);
        }
        session.bridge.handle(msg);
      }

      if (!session.bridge.isSegmentReady() && session.bridge.isTurnDone()) {
        // Turn ended without a completed assistant segment.  Three sub-cases:
        //   (a) SDK reported an error result (auth failure, rate limit,
        //       server 5xx): surface the error to pi.
        //   (b) The bridge had started a segment (`message_start` arrived,
        //       maybe with partial content/tool_use blocks) but the turn
        //       ended before message_stop — partial content + error.
        //   (c) Truly empty no-op turn (no message_start at all and no
        //       error): synthesize an empty done.  This is the original
        //       behavior for empty continuation turns.
        const turnErr = session.bridge.getTurnError();
        const hadPartial = session.bridge.hasPartialContent();
        if (turnErr || hadPartial) {
          const errMsg =
            turnErr ??
            "SDK turn ended without completing the assistant message (no error reported)";
          if (DEBUG) {
            console.error(
              `[pi-cas/debug] turn ended without complete segment — ` +
                `surfacing error (partial=${hadPartial}): ${errMsg}`,
            );
          }
          // Use the bridge's error-close so any partial content already
          // streamed to pi is preserved in the error message instead of
          // being discarded.
          session.bridge.closeStreamWithError(errMsg);
        } else {
          if (DEBUG) console.error("[pi-cas/debug] turn ended without segment; pushing empty done");
          const empty = makeEmptyAssistantMessage(model);
          stream.push({ type: "done", reason: "stop", message: empty } as any);
          stream.end();
        }
        session.bridge.resetTurn();
        return;
      }

      // Capture the segment's tool-use ids BEFORE closing (closeSegment
      // resets per-segment state).  These become the "phantom" set for
      // the next streamSimple.  Synthetic ids (auto-turn injections, see
      // `auto-turn-stub.ts`) are tracked separately so classifyNewContent
      // can drop them entirely rather than wait for the SDK to do
      // something with them.
      const segmentToolUseIds = session.bridge.getCurrentSegmentToolUseIds();
      const segmentSyntheticToolUseIds =
        session.bridge.getSyntheticToolUseIdsForCurrentSegment();
      const segmentStopReason = session.bridge.getSegmentStopReason();
      session.bridge.closeSegment();
      session.recentlyEmittedToolUseIds = new Set(segmentToolUseIds);
      session.recentlySyntheticToolUseIds = new Set(segmentSyntheticToolUseIds);

      // If the segment closed at end_turn / length (not toolUse), the SDK
      // will emit `result` next.  Drain it off the iterator so it doesn't
      // poison subsequent streamSimples — those expect to see message_start
      // for the next user turn, not a stale result.  After draining, call
      // resetTurn() so the bridge is ready for the next SDK turn.
      if (segmentStopReason !== "toolUse" && !session.bridge.isTurnDone()) {
        while (!session.bridge.isTurnDone()) {
          const next = await session.iter.next();
          if (next.done) break;
          session.bridge.handle(next.value);
          if (next.value?.type === "result") break;
        }
      }
      if (segmentStopReason !== "toolUse") {
        // Whether we drained here or it had already been drained, rearm.
        session.bridge.resetTurn();
      }
    } catch (err: any) {
      if (DEBUG) console.error(`[pi-cas/debug] consume loop threw:`, err);
      pushError(stream, model, err?.message ?? String(err));
      return;
    } finally {
      if (options?.signal) {
        options.signal.removeEventListener("abort", abortListener);
      }
    }

    // 7. Fast-mode state + badge update.
    const fms = session.bridge.getFastModeState();
    config.lastModel = model.id;
    if (fms) config.lastFastModeState = fms;
    if (DEBUG && fms) {
      console.error(
        `[pi-cas/debug] fast_mode_state=${fms}, cost=$${session.bridge.getCost()?.toFixed(4) ?? "?"}`,
      );
    }
    badge.update({
      intent: config.fastMode,
      actual: config.lastFastModeState,
      model: config.lastModel,
    });
    const fastModeRequested = config.fastMode && modelSupportsFastMode(model.id);
    if (fastModeRequested && fms === "off" && !config.fastModeWarned) {
      config.fastModeWarned = true;
      console.warn(
        "[pi-cas] fast mode was requested but the API returned fast_mode_state=off. " +
          "Either your org lacks the extra-usage entitlement, or the selected model " +
          `(${model.id}) doesn't support fast mode (Opus 4.6/4.7 only). See ` +
          "https://code.claude.com/docs/en/fast-mode#requirements",
      );
    }
  })();

  return stream;
}

/* ----------------------------- session bootstrap ----------------------------- */

/**
 * Resolve the long-lived `PiSession` for a given pi session id.  Lazy-spawns
 * the SDK query on first call.
 */
async function ensureSession(
  pi: ExtensionAPI,
  piSessionId: string,
  cwd: string,
  model: Model<any>,
  context: Context,
  options: SimpleStreamOptions | undefined,
  config: ProviderConfig,
  logProxyPromise: Promise<LogProxyHandle> | undefined,
): Promise<PiSession> {
  const existing = config.sessions.get(piSessionId);
  if (existing && !existing.ended) {
    // Sanity: if pi somehow changed cwd mid-session (shouldn't happen — pi
    // restarts the agent on cwd change), tear down and respawn.
    if (existing.cwd !== cwd) {
      if (DEBUG) console.error(`[pi-cas/debug] cwd changed (${existing.cwd} → ${cwd}); respawning`);
      await teardownSession(existing, "cwd-change");
      clearSessionMapping(piSessionId);
      config.sessions.delete(piSessionId);
    } else {
      return existing;
    }
  }

  // Determine the SDK session id to resume into, if any.  See
  // {@link resolveResumeForFreshSession} for the precedence rules.
  const resolved = resolveResumeForFreshSession(
    piSessionId,
    config.pendingFork,
    getSessionMapping(piSessionId),
  );
  const resumeId = resolved.resumeId;
  if (resolved.consumePendingFork && resumeId) {
    setSessionMapping(piSessionId, resumeId);
    config.pendingFork = undefined;
    if (DEBUG) {
      console.error(
        `[pi-cas/debug] claimed pendingFork: forkedSdkSessionId=${resumeId} → ` +
          `new pi=${piSessionId} (mapping persisted)`,
      );
    }
  }
  if (DEBUG) {
    console.error(
      `[pi-cas/debug] spawning query: pi=${piSessionId} cwd=${cwd} resume=${resumeId ?? "(none)"}`,
    );
  }

  // Resolve okta relay BEFORE spawning so we can fail fast.
  //
  // The token returned here is what we bake into the subprocess's
  // ANTHROPIC_API_KEY env var. That value goes stale after the JWT TTL
  // (~24h), but it doesn't matter — when the proxy is in front of the
  // subprocess (which it always is in okta mode now), every request's
  // x-api-key gets rewritten by `oktaApiKeyProvider` before going upstream.
  // The env value just has to be non-empty so the bundled `claude` CLI
  // doesn't bail at startup. We seed `tokenCache` from this call so the
  // proxy's first request reuses the same token without an extra
  // event-bus round-trip.
  let relay: RelayConfig | undefined;
  if (config.oktaEnabled) {
    relay = await requestRelay(pi, {
      preferredProvider: config.oktaProvider,
      timeoutMs: 8000,
    });
    config.lastOktaProvider = relay.provider;
    config.lastOktaBaseUrl = relay.baseUrl;
    // Seed the proxy's token cache so its first request reuses this token
    // rather than issuing a redundant event-bus round-trip. The cache is
    // owned by registerProvider; ensureSession only writes to it.
    if (config.oktaTokenCache) {
      config.oktaTokenCache.token = relay.accessToken;
      config.oktaTokenCache.fetchedAt = Date.now();
    }
    if (DEBUG) {
      console.error(
        `[pi-cas/debug] okta relay resolved: ${relay.provider} → ${relay.baseUrl} (token cache seeded)`,
      );
    }
  }

  // Build the env for the subprocess.
  const env = buildSubprocessEnv(config, relay);

  // HTTP proxy: point the subprocess at it. Always required in okta mode
  // (the proxy rewrites x-api-key per-request to keep the long-lived
  // subprocess auth-fresh); optional otherwise (just logging).
  if (logProxyPromise) {
    try {
      const proxy = await logProxyPromise;
      const trueUpstream = env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com";
      proxy.setUpstreamBaseUrl(trueUpstream);
      env.ANTHROPIC_BASE_URL = proxy.getBaseUrl();
      if (DEBUG) {
        console.error(
          `[pi-cas/debug] HTTP proxy active: ${proxy.getBaseUrl()} → ${trueUpstream}` +
            (config.oktaEnabled ? " (x-api-key rewritten per request)" : ""),
        );
      }
    } catch (err) {
      // In okta mode the proxy is load-bearing for auth refresh — losing it
      // means the subprocess will 401 once the baked-in token expires. Log
      // loudly so the failure mode is debuggable.
      if (config.oktaEnabled) {
        console.error(
          `[pi-cas] HTTP proxy unavailable in okta mode — auth-refresh is OFF; ` +
            `the subprocess will 401 once the initial token expires. Cause: ${
              err instanceof Error ? err.message : String(err)
            }`,
        );
      } else if (DEBUG) {
        console.error(`[pi-cas/debug] log proxy unavailable:`, err);
      }
    }
  }

  const systemPrompt = composeSystemPrompt(context.systemPrompt);
  const fastModeRequested = config.fastMode && modelSupportsFastMode(model.id);
  const fastFrag = buildFastModeOptions(fastModeRequested, model.id);

  // Build the prompt AsyncIterable.  It pulls items off promptQueue and
  // yields them; resolves each item's promise as a "this message is now in
  // the SDK's hands" signal so streamSimple knows when to start consuming
  // events for the corresponding turn.
  //
  // Note: SDK's streaming-input mode only accepts user messages; assistant
  // history goes through `resume`.
  const promptQueue: PiSession["promptQueue"] = [];
  let genWaker: (() => void) | null = null;
  let ended = false;

  const sessionRef: { current?: PiSession } = {};

  async function* promptGen() {
    while (true) {
      if (ended) return;
      if (promptQueue.length === 0) {
        await new Promise<void>((resolve) => {
          genWaker = resolve;
          if (sessionRef.current) sessionRef.current.genWaker = resolve;
        });
        if (ended) return;
        continue;
      }
      const item = promptQueue.shift()!;
      try {
        yield {
          type: "user" as const,
          message: { role: "user" as const, content: item.content },
          parent_tool_use_id: null,
        };
        item.resolved();
      } catch (err) {
        item.failed(err);
        throw err;
      }
    }
  }

  const sdkOpts: Options = {
    model: model.id,
    systemPrompt,
    settingSources: [],
    permissionMode: config.permissionMode,
    includePartialMessages: true,
    // Forward subagent text/thinking blocks as assistant/user typed
    // messages with `parent_tool_use_id` set.  Without this, only
    // subagent tool_use/tool_result blocks are emitted (a "heartbeat
    // counter" per SDK docs).  We want the full subagent transcript so
    // the Task stub's renderer can show the subagent's reasoning,
    // intermediate tool calls, and final answer — see
    // `src/task-stub.ts` renderResult.
    forwardSubagentText: true,
    cwd,
    env,
    // Expose the full Claude Code built-in tool preset to the model
    // (Bash, Read, Write, Edit, Grep, Glob, Task / subagents, WebFetch,
    // WebSearch, NotebookEdit, TodoWrite, ExitPlanMode, MCP tools, etc.).
    //
    // Originally we restricted this to `[...SUPPORTED_CC_TOOL_NAMES]` (the
    // six built-ins with named stubs) to guarantee pi's agent loop could
    // execute every tool the model emitted.  Now that the bridge has a
    // catch-all stub registration path (see
    // `EventBridgeOptions.onUnknownToolName` + provider's
    // `registerDynamicStub`), pi survives any tool name the SDK surfaces
    // — the catch-all stub just looks up the cached result like the named
    // stubs do.
    //
    // Subagent inner conversation events (`parent_tool_use_id != null`)
    // are filtered out in the bridge (see handle() in event-bridge.ts), so
    // pi sees only the parent `Task` tool_use + its final tool_result.
    // The subagent's internal tool calls / text / progress are not
    // surfaced — see writeups/subagent_investigation.md "Phase B" for the
    // path to nested-transcript rendering.
    tools: { type: "preset", preset: "claude_code" },
    // Permission hook for SDK-side "client-side" tools (AskUserQuestion in
    // particular).  Without this, the SDK's `checkPermissions()` for
    // AskUserQuestion returns `behavior: "ask"` with no host to handle
    // the question, and the SDK synthesizes an `is_error` tool_result with
    // content="Answer questions?" — the model interprets that as a user
    // cancellation.
    //
    // Our handler dispatches: for AskUserQuestion, render a pi-tui dialog
    // and return the user's selections in `updatedInput.answers`; for any
    // other prompt the SDK might raise, default-allow with the original
    // input.  See `interactive-tools.ts` module docstring for limitations
    // (no per-tool generic-permission UI yet).
    canUseTool: (toolName, input, opts) =>
      handleCanUseTool(toolName, input, opts, () => config.getLatestCtx?.()),
    ...(resumeId ? { resume: resumeId } : {}),
    ...(fastFrag.extraArgs ? { extraArgs: fastFrag.extraArgs } : {}),
    effort: mapEffort(options?.reasoning),
    thinking: buildThinkingConfig(model, options?.reasoning, options?.thinkingBudgets),
  };

  const q = query({ prompt: promptGen(), options: sdkOpts });

  // Capture the iterator once.  See PiSession.iter docstring for why we
  // can't use `for await`-with-break across multiple turns.
  const iter = (q as any)[Symbol.asyncIterator]() as AsyncIterator<any>;

  // Initial lastSentCount: see initialLastSentCount() for the rationale.
  const initialLastSent = initialLastSentCount(context.messages.length);

  const session: PiSession = {
    piSessionId,
    sdkSessionId: undefined,
    query: q,
    iter,
    bridge: createEventBridge(model, {
      onUnknownToolName: (name) => config.registerDynamicStub?.(name),
    }),
    recentlyEmittedToolUseIds: new Set(),
    recentlySyntheticToolUseIds: new Set(),
    pendingIterPromise: undefined,
    promptQueue,
    genWaker: null,
    ended: false,
    cwd,
    model: model.id,
    permissionMode: config.permissionMode,
    lastSentCount: initialLastSent,
  };
  sessionRef.current = session;
  // Splice the local closure waker onto the session so teardown can find it.
  // (We also keep `genWaker` updated inside promptGen's await above.)
  Object.defineProperty(session, "genWaker", {
    get: () => genWaker,
    set: (v: any) => { genWaker = v; },
    enumerable: true,
    configurable: true,
  });
  Object.defineProperty(session, "ended", {
    get: () => ended,
    set: (v: any) => { ended = v; },
    enumerable: true,
    configurable: true,
  });
  config.sessions.set(piSessionId, session);

  // Drain the init event eagerly so we capture sdk_session_id before the
  // first turn's main event loop starts — and so any spawn-time failure
  // surfaces here instead of in the streamSimple consume loop.  We DON'T
  // consume past `system.init` because there's no work for the SDK yet
  // (no prompt has been yielded).
  //
  // Subtle: pi's first streamSimple will share the same `for await` iterator
  // across the session.  But the SDK's `query()` returns an async iterable
  // that's iterable-once; we can't drain init here and re-iterate later.
  //
  // Solution: don't drain.  Capture sdk_session_id when the streamSimple
  // consume loop sees it.
  return session;
}

/**
 * Build the env vars for the subprocess.  Mirrors the previous provider's
 * env logic: configDir, okta relay creds, fastMode, etc.
 */
function buildSubprocessEnv(
  config: ProviderConfig,
  relay: RelayConfig | undefined,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === "string") env[k] = v;
  }
  if (config.configDirOverride) env.CLAUDE_CONFIG_DIR = config.configDirOverride;
  if (relay) {
    env.ANTHROPIC_API_KEY = relay.accessToken;
    env.ANTHROPIC_BASE_URL = relay.baseUrl;
    // See provider.ts(legacy) comment: stripping Authorization-style env vars
    // because the relay only accepts x-api-key auth.
    delete env.ANTHROPIC_AUTH_TOKEN;
    delete env.CLAUDE_CODE_OAUTH_TOKEN;
  } else {
    if (config.apiKeyOverride) env.ANTHROPIC_API_KEY = config.apiKeyOverride;
    if (config.baseUrlOverride) env.ANTHROPIC_BASE_URL = config.baseUrlOverride;
  }
  return env;
}

/* ----------------------------- session bootstrap helpers ----------------------------- */

/**
 * Compute the initial `lastSentCount` for a freshly-spawned PiSession.
 *
 * On session creation we need to decide: which of pi's messages have
 * "already been sent" to the SDK?
 *
 *   - **Resumed SDK session** (`resume: <id>` passed to `query()`): the SDK
 *     already has all prior turns in its own JSONL.  Replaying historical
 *     pi messages would re-enqueue every user prompt the SDK already saw.
 *     Pi's calling convention guarantees the trailing message in
 *     `context.messages` IS the user input prompting THIS streamSimple call
 *     — so mark everything before that as already consumed.
 *   - **Fresh SDK session, no pi history**: messages.length is 0 or 1,
 *     and the formula gives 0; the trailing message (if any) is enqueued.
 *   - **Fresh SDK session WITH pi history** (e.g. pi switched providers
 *     mid-conversation): no good answer.  Sending all prior user messages
 *     without their assistant pairs would mislead the model into thinking
 *     it had responded.  Sending only the trailing message loses context
 *     but is consistent.  Documented as a known limitation in writeups.
 *
 * The previous value (`0`) caused a real bug on cross-process resume: the
 * provider would double-send every historical user prompt to the SDK.
 * Exported for unit testing.
 */
export function initialLastSentCount(piMessagesLength: number): number {
  return Math.max(0, piMessagesLength - 1);
}

/**
 * Decide which SDK session id (if any) a freshly-spawning `PiSession` should
 * resume into.
 *
 * Precedence (highest to lowest):
 *   1. **Pending fork.**  If `session_before_fork` ran for some OTHER pi
 *      session id and stashed a forked SDK session id in `config.pendingFork`,
 *      and we are spawning for a DIFFERENT pi session id (the new forked
 *      branch), claim that forked SDK session id.  This preserves model
 *      history across the fork.
 *   2. **Persisted resume id.**  If we have a previously-recorded SDK session
 *      id for this exact pi session id (e.g. from a prior pi process — cross-
 *      process resume), use that.
 *   3. **None.**  Spawn a fresh SDK session.
 *
 * The pending-fork entry is consumed only when the source pi session id
 * differs from the spawn-target (the SAME pi session id reopening shouldn't
 * eat its own fork stash — that would happen if pi reused the source id for
 * the new branch, which it doesn't, but defensively we guard).
 *
 * `consumePendingFork` is true iff (1) applied; the caller is responsible for
 * persisting the new mapping and clearing `config.pendingFork`.
 *
 * Exported for unit testing.
 */
export function resolveResumeForFreshSession(
  piSessionId: string,
  pendingFork:
    | { sourcePiSessionId: string; forkedSdkSessionId: string }
    | undefined,
  persistedResumeId: string | undefined,
): { resumeId: string | undefined; consumePendingFork: boolean } {
  if (pendingFork && pendingFork.sourcePiSessionId !== piSessionId) {
    return { resumeId: pendingFork.forkedSdkSessionId, consumePendingFork: true };
  }
  return { resumeId: persistedResumeId, consumePendingFork: false };
}

/* ----------------------------- message classification ----------------------------- */

/**
 * Result of classifying a streamSimple call's new content (everything in
 * `context.messages.slice(lastSentCount)`).
 *
 * Tells the provider whether to enqueue a fresh user message into the SDK
 * prompt iterator (`real`), skip the enqueue and just consume the next SDK
 * segment (`phantom`), or push an empty `done` (`empty`).
 */
export interface NewContentClassification {
  kind: "real" | "phantom" | "empty";
  /** Anthropic-shaped user content blocks to enqueue (only populated for
   * `real`).  Excludes any toolResult-derived blocks: the SDK doesn't want
   * to see pi's phantom tool results.
   */
  realUserBlocks: any[];
  /** ToolResult message ids in the slice whose toolCallId matched our
   * recently-emitted set — i.e. the expected phantoms from pi running our
   * stub tools. */
  phantomToolResultIds: string[];
  /** ToolResult message ids whose toolCallId matched our SYNTHETIC
   * recently-emitted set (auto-turn stubs we injected, see
   * `auto-turn-stub.ts`).  These are silently dropped — the SDK never
   * knew about these tool calls, so there's nothing to wait for. */
  syntheticPhantomToolResultIds: string[];
  /** ToolResult message ids in the slice that DIDN'T match our recent set.
   * Logged as a warning; might indicate a pi extension feeding us tool
   * results we don't expect, or a stale `lastSentCount`. */
  unexpectedToolResultIds: string[];
}

/**
 * Classify the new content in pi's message slice.
 *
 * Cases:
 *   - Slice contains real user content (text/image): `real` (enqueue).
 *   - Slice contains ONLY toolResult messages, all from our recently-
 *     emitted set: `phantom` (just consume next SDK events; don't enqueue).
 *   - Slice is empty or has no user/toolResult role messages: `empty`.
 *   - Mixed real + phantom: treated as `real`; phantom toolResults are
 *     dropped (SDK already has them).
 */
export function classifyNewContent(
  messages: ReadonlyArray<any>,
  fromIndex: number,
  recentlyEmittedIds: ReadonlySet<string>,
  syntheticIds: ReadonlySet<string> = new Set(),
): NewContentClassification {
  const realUserBlocks: any[] = [];
  const phantomToolResultIds: string[] = [];
  const syntheticPhantomToolResultIds: string[] = [];
  const unexpectedToolResultIds: string[] = [];

  const classifyId = (id: string) => {
    // Synthetic check FIRST: a synthetic id should always be classified
    // as such even if it also happened to leak into the real-emitted
    // set (defensive — shouldn't happen in normal flow).
    if (syntheticIds.has(id)) {
      syntheticPhantomToolResultIds.push(id);
    } else if (recentlyEmittedIds.has(id)) {
      phantomToolResultIds.push(id);
    } else {
      unexpectedToolResultIds.push(id);
    }
  };

  for (let i = fromIndex; i < messages.length; i++) {
    const m = messages[i];
    if (!m) continue;

    if (m.role === "toolResult") {
      // Pi's top-level toolResult message shape (see pi-ai types.d.ts:203).
      // The toolCallId tells us whether it's one of ours.
      const id = m.toolCallId;
      if (typeof id === "string") classifyId(id);
      continue;
    }

    if (m.role === "user") {
      if (Array.isArray(m.content)) {
        for (const block of m.content) {
          // Pi may embed toolResult blocks inside user messages on some
          // code paths; treat them the same as top-level toolResult
          // messages (skip, account for phantom).
          if (block?.type === "toolResult" || block?.type === "tool_result") {
            const id = block.toolCallId ?? block.tool_use_id;
            if (typeof id === "string") classifyId(id);
            continue;
          }
          const translated = piBlockToAnthropic(block);
          if (translated) realUserBlocks.push(translated);
        }
      } else if (typeof m.content === "string") {
        realUserBlocks.push({ type: "text", text: m.content });
      }
      continue;
    }

    // Assistant messages and anything else: ignored (SDK already has its
    // own assistant history internally; pi may inject custom messages, etc.).
  }

  let kind: NewContentClassification["kind"];
  if (realUserBlocks.length > 0) {
    kind = "real";
  } else if (phantomToolResultIds.length > 0) {
    // Real phantoms: SDK is mid-turn with pending tool_results, will emit
    // the next assistant message.  Consume loop reads next iter event.
    kind = "phantom";
  } else {
    // Either nothing, or only synthetic phantoms.  Either way, the SDK
    // has nothing pending — push empty done and return.
    kind = "empty";
  }

  return {
    kind,
    realUserBlocks,
    phantomToolResultIds,
    syntheticPhantomToolResultIds,
    unexpectedToolResultIds,
  };
}

/**
 * Translate a pi content block into an Anthropic-shaped block the SDK
 * accepts.  Returns null for blocks we skip.
 */
function piBlockToAnthropic(block: any): any | null {
  if (!block || typeof block !== "object") return null;
  switch (block.type) {
    case "text":
      return { type: "text", text: block.text ?? "" };
    case "image": {
      // Three shapes we accept:
      //   1. Pi's canonical ImageContent (pi-ai types.d.ts:157):
      //      { type:"image", data: <base64>, mimeType }     ← flat
      //   2. Anthropic shape (already-translated):
      //      { type:"image", source: { type:"base64", media_type, data } }
      //   3. Nested legacy/defensive shape:
      //      { type:"image", image: { data, mimeType } }
      if (block.source) return block; // (2) already Anthropic-shaped
      const nested = block.image;
      if (nested && (nested.data || nested.mimeType)) {
        return {
          type: "image",
          source: {
            type: "base64",
            media_type: nested.mimeType ?? "image/png",
            data: nested.data ?? "",
          },
        };
      }
      if (typeof block.data === "string") {
        // (1) canonical pi ImageContent — flat fields on the block itself.
        return {
          type: "image",
          source: {
            type: "base64",
            media_type: block.mimeType ?? "image/png",
            data: block.data,
          },
        };
      }
      if (DEBUG) {
        console.error(
          `[pi-cas/debug] WARN: image block with no recognized shape; dropping`,
          Object.keys(block ?? {}).join(","),
        );
      }
      return null;
    }
    case "toolResult":
    case "tool_result":
      // Handled at the message level in classifyNewContent; skip here.
      return null;
    default:
      // Unknown block type — pass through and let the SDK reject it loudly.
      return block;
  }
}

/* ----------------------------- helpers ----------------------------- */

function makeEmptyAssistantMessage(model: Model<any>): any {
  return {
    role: "assistant",
    content: [],
    api: PROVIDER_ID,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function pushError(
  stream: AssistantMessageEventStream,
  model: Model<any>,
  message: string,
): void {
  const output = makeEmptyAssistantMessage(model);
  output.stopReason = "error";
  output.errorMessage = message;
  stream.push({ type: "error", reason: "error", error: output } as any);
  stream.end();
}

/* ----------------------------- slash commands ----------------------------- */

/**
 * Emit text to the user from a slash command via ctx.ui.notify (NOT
 * pi.sendMessage — see legacy provider.ts for why).
 */
function emit(
  ctx: any,
  text: string,
  kind: "info" | "warning" | "error" = "info",
): void {
  ctx.ui.notify(text, kind);
}

function registerSlashCommands(
  pi: ExtensionAPI,
  config: ProviderConfig,
  badge: FastModeBadge,
): void {
  pi.registerCommand("cas-auth", {
    description: "Show pi-cas-provider auth status",
    handler: async (_args: string, ctx: any) => {
      const auth = getAuthStatus();
      const text = formatAuthDetails(auth, {
        configDir: config.configDirOverride,
        apiKeyOverride: !!config.apiKeyOverride,
        okta: {
          enabled: config.oktaEnabled,
          provider: config.oktaProvider,
          lastProvider: config.lastOktaProvider,
          lastBaseUrl: config.lastOktaBaseUrl,
        },
      });
      emit(ctx, text);
    },
  });

  pi.registerCommand("cas-fast", {
    description: "Toggle pi-cas fast mode for this session (on/off/status)",
    getArgumentCompletions: (prefix) => {
      const opts = ["on", "off", "status"];
      const matches = opts.filter((o) => o.startsWith(prefix.toLowerCase()));
      return matches.length ? matches.map((o) => ({ value: o, label: o })) : null;
    },
    handler: async (args: string, ctx: any) => {
      const arg = args.trim().toLowerCase();
      let changed = false;
      if (arg === "on") {
        config.fastMode = true;
        config.fastModeWarned = false;
        changed = true;
      } else if (arg === "off") {
        config.fastMode = false;
        config.fastModeWarned = false;
        changed = true;
      }
      if (changed) {
        saveState({ fastMode: config.fastMode });
        badge.update({
          intent: config.fastMode,
          actual: config.fastMode ? config.lastFastModeState : undefined,
          model: config.lastModel,
        });
      }
      const heading = changed
        ? `pi-cas fast mode → ${config.fastMode ? "ON" : "off"} (saved)`
        : `pi-cas fast mode: ${config.fastMode ? "ON" : "off"}`;
      const envNote =
        process.env.PI_CAS_FAST_MODE !== undefined
          ? `\n  Note: PI_CAS_FAST_MODE=${process.env.PI_CAS_FAST_MODE} is set; ` +
            `it overrides the saved value on next launch.`
          : "";
      const text =
        `${heading}\n` +
        `  Only takes effect on claude-opus-4-6 / claude-opus-4-7 ` +
        `(silently ignored on other models).\n` +
        `  $30/$150 per MTok when active — ~30x standard Opus pricing.\n` +
        `  Preference persisted to ${statePath()}.\n` +
        `  See /cas-auth for entitlement.${envNote}`;
      emit(ctx, text);
    },
  });

  pi.registerCommand("cas-okta", {
    description: "Route pi-cas through an Okta-OAuth relay (on/off/status [provider])",
    getArgumentCompletions: (prefix) => {
      const opts = ["on", "off", "status"];
      const matches = opts.filter((o) => o.startsWith(prefix.toLowerCase()));
      return matches.length ? matches.map((o) => ({ value: o, label: o })) : null;
    },
    handler: async (args: string, ctx: any) => {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const first = (parts[0] ?? "status").toLowerCase();
      let action: "on" | "off" | "status";
      let provider: string | undefined;
      if (first === "on") {
        action = "on";
        provider = parts[1];
      } else if (first === "off") {
        action = "off";
      } else if (first === "status") {
        action = "status";
      } else {
        action = "on";
        provider = first;
      }
      let changed = false;
      if (action === "on") {
        if (!config.oktaEnabled || config.oktaProvider !== provider) changed = true;
        config.oktaEnabled = true;
        config.oktaProvider = provider;
      } else if (action === "off") {
        if (config.oktaEnabled) changed = true;
        config.oktaEnabled = false;
      }
      if (changed) {
        saveState({
          okta: {
            enabled: config.oktaEnabled,
            ...(config.oktaProvider ? { provider: config.oktaProvider } : {}),
          },
        });
      }
      const stateLine = config.oktaEnabled
        ? `pi-cas okta relay: ON${
            config.oktaProvider
              ? ` (provider pinned to "${config.oktaProvider}")`
              : " (any responder wins)"
          }`
        : "pi-cas okta relay: off";
      const heading = changed ? `→ ${stateLine}` : stateLine;
      const detail: string[] = [heading];
      if (config.oktaEnabled) {
        detail.push(
          "  pi-cas asks pi.events for a relay endpoint before each turn and",
          "  routes the bundled `claude` subprocess through it. Local Claude",
          "  Code auth (api_key / Console managed key) is bypassed.",
        );
        if (config.lastOktaBaseUrl) {
          detail.push(`  last successful relay: ${config.lastOktaProvider} → ${config.lastOktaBaseUrl}`);
        }
      } else {
        detail.push(
          "  pi-cas uses local Claude Code auth (whatever `claude auth status` reports).",
        );
      }
      detail.push(`  Persisted to ${statePath()}.`);
      if (action === "on") {
        detail.push(
          "  Requires a responder extension loaded in pi (e.g. pi-hawk-provider)",
          "  listening on `pi-cas:relay-request`. /cas-status shows the last turn.",
        );
      }
      emit(ctx, detail.join("\n"));
    },
  });

  pi.registerCommand("cas-perm", {
    description:
      "Set or inspect pi-cas permission mode (bypassPermissions|default|acceptEdits|plan)",
    getArgumentCompletions: (prefix) => {
      const opts = ["bypassPermissions", "default", "acceptEdits", "plan", "status"];
      const matches = opts.filter((o) => o.toLowerCase().startsWith(prefix.toLowerCase()));
      return matches.length ? matches.map((o) => ({ value: o, label: o })) : null;
    },
    handler: async (args: string, ctx: any) => {
      const arg = args.trim();
      if (!arg || arg === "status") {
        emit(
          ctx,
          `pi-cas permission mode: ${config.permissionMode}\n` +
            `  Default for new sessions.  Mutable per-session via this command.\n` +
            `  Env override: PI_CAS_PERMISSION_MODE.\n` +
            `  Persisted to ${statePath()}.`,
        );
        return;
      }
      const parsed = parsePermissionMode(arg);
      if (!parsed) {
        emit(
          ctx,
          `Unknown permission mode: ${arg}\n` +
            `Valid: bypassPermissions, default, acceptEdits, plan`,
          "error",
        );
        return;
      }
      const prev = config.permissionMode;
      config.permissionMode = parsed;
      saveState({ permissionMode: parsed });
      // Push the change to any in-flight long-lived queries.
      for (const session of config.sessions.values()) {
        try {
          await session.query.setPermissionMode(parsed);
          session.permissionMode = parsed;
        } catch (err) {
          if (DEBUG) console.error(`[pi-cas/debug] setPermissionMode failed:`, err);
        }
      }
      emit(
        ctx,
        `pi-cas permission mode → ${parsed} (saved, was ${prev})\n` +
          `  Applied to ${config.sessions.size} active session(s).`,
      );
    },
  });

  pi.registerCommand("cas-status", {
    description: "Show pi-cas-provider configuration and last-turn ground truth",
    handler: async (_args: string, ctx: any) => {
      const intent = config.fastMode ? "on" : "off";
      const realityLabel =
        config.lastFastModeState === undefined
          ? "(no request yet this session)"
          : config.lastFastModeState === "on"
            ? `on — confirmed by API on last turn${config.lastModel ? ` (${config.lastModel})` : ""}`
            : config.lastFastModeState === "cooldown"
              ? "cooldown — fast-mode pool depleted, API throttling"
              : `off — API did not engage fast mode on last turn${config.lastModel ? ` (${config.lastModel})` : ""}`;
      const oktaLabel = config.oktaEnabled
        ? `on${config.oktaProvider ? ` (provider=${config.oktaProvider})` : " (any responder)"}`
        : "off";
      const oktaLastLabel = config.lastOktaBaseUrl
        ? `${config.lastOktaProvider ?? "?"} → ${config.lastOktaBaseUrl}`
        : config.oktaEnabled
          ? "(no successful relay turn yet this session)"
          : "—";
      const lines = [
        "pi-cas-provider status:",
        `  permission mode:     ${config.permissionMode}`,
        `  fast mode (intent):  ${intent}`,
        `  fast mode (actual):  ${realityLabel}`,
        `  okta relay:          ${oktaLabel}`,
        `  okta last turn:      ${oktaLastLabel}`,
        `  config dir:          ${config.configDirOverride ?? "(default ~/.claude)"}`,
        `  api key override:    ${config.apiKeyOverride ? "PI_CAS_API_KEY set" : "no"}`,
        `  base url override:   ${config.baseUrlOverride ?? "(none — SDK default or ANTHROPIC_BASE_URL)"}`,
        `  active sessions:     ${config.sessions.size}`,
        `  persisted state:     ${statePath()}`,
      ];
      if (config.fastMode && config.lastFastModeState === "off") {
        lines.push("");
        lines.push("Note: you requested fast mode but the API returned off on the last turn.");
        lines.push("  - On Opus 4.6/4.7? Otherwise the setting is silently ignored.");
        if (!config.oktaEnabled) {
          lines.push("  - Does your org have extra-usage enabled? See /cas-auth.");
        } else {
          lines.push("  - Does the relay have fast-mode entitlement on its upstream Console org?");
        }
      }
      emit(ctx, lines.join("\n"));
    },
  });
}
