/**
 * Top-level provider wiring: registers the pi provider, slash commands, and
 * orchestrates the per-turn streamSimple call through the Agent SDK.
 *
 * # Architecture: long-lived query() per pi session
 *
 * Pi-cas used to spawn a fresh `query()` per turn and resume via the SDK's
 * `sessionStore` / `resume` options.  That triggered the bundled `claude`
 * binary's resume normalizer (`gG8 → iO6 → Xg5`) on every turn and required
 * elaborate transcript reconstruction (see git history: `src/transcript.ts`,
 * `src/session-store.ts`, both deleted in this refactor).
 *
 * The new architecture:
 *
 *   - ONE long-lived `query()` per pi session, lazily spawned on the first
 *     `streamSimple` call.
 *   - Prompt is an `AsyncIterable<SDKUserMessage>` that stays open for the
 *     session's lifetime; each pi turn enqueues one user message.
 *   - The SDK runs all tools natively (`permissionMode: "bypassPermissions"`
 *     by default).  Pi-cas does NOT execute tools — it merely forwards
 *     `tool_use`/`tool_result` stream events to pi for display.
 *   - The SDK owns the on-disk JSONL transcript (under CLAUDE_CONFIG_DIR/
 *     projects/<dirhash>/<sdk-session-id>.jsonl).  Pi-cas's history view is
 *     authoritative for what pi displays; the SDK's view is authoritative
 *     for what the model sees.
 *
 * # Per-turn flow
 *
 *   1. Resolve the per-session `PiSession` (lazy spawn on first turn).
 *   2. Detect model / permissionMode changes from prior turn → invoke
 *      `query.setModel()` / `query.setPermissionMode()` on the existing
 *      subprocess.  No restart needed.
 *   3. Extract the NEW user content from `context.messages` (everything
 *      after `lastSentCount`), concat any user-side blocks, enqueue into
 *      the AsyncIterable.
 *   4. Consume SDK events until `result`, bridge them into pi's stream.
 *   5. Push `done` with the final accumulated assistant message.
 *
 * # Lifecycle integration
 *
 *   - `session_start`: lazy spawn — defer until first streamSimple.
 *   - `session_shutdown`: tear down the long-lived query (gen.return() +
 *     interrupt()).
 *   - `session_before_fork` / `session_before_compact`: tear down and clear
 *     the pi-session → SDK-session mapping so the next streamSimple spawns
 *     a fresh query (v1 limitation: model history is lost on fork; SDK's
 *     forkSession + resumeSessionAt support is deferred to v2).
 *
 * # Concurrency invariant
 *
 *   Pi's agent loop guarantees at most one in-flight streamSimple per
 *   session (see pi-coding-agent's agent-session.js:734).  We rely on
 *   that: the per-session promptQueue / event consumer is not re-entrant.
 */

import { query, type Options, type Query } from "@anthropic-ai/claude-agent-sdk";
import {
  getModels,
  createAssistantMessageEventStream,
  type AssistantMessageEventStream,
  type Model,
  type SimpleStreamOptions,
  type Context,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { composeSystemPrompt } from "./system-prompt.js";
import { mapEffort } from "./effort.js";
import { buildThinkingConfig } from "./thinking.js";
import { buildFastModeOptions, modelSupportsFastMode } from "./settings.js";
import { createEventBridge } from "./event-bridge.js";
import { getAuthStatus, formatAuthBanner, formatAuthDetails } from "./auth.js";
import { FastModeBadge } from "./badge.js";
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
  /** FIFO queue of pending user messages to yield into the AsyncIterable. */
  promptQueue: Array<{ content: any; resolved: () => void; failed: (e: any) => void }>;
  /** Resolver for the awaitable inside the prompt-gen loop. */
  genWaker: (() => void) | null;
  /** Signals the gen to return (clean shutdown). */
  ended: boolean;
  /** A `result` arrived but the consumer hasn't read it yet — set/cleared per-turn. */
  inFlight: boolean;
  cwd: string;
  /** Last-known model id for change detection across turns. */
  model: string;
  /** Last-known permissionMode for change detection across turns. */
  permissionMode: PermissionMode;
  /**
   * How many of pi's messages we've already consumed.  Each `streamSimple`
   * call processes `context.messages.slice(lastSentCount)` to extract the
   * new user input.  Reset to 0 on fork/compact (mapping cleared → next
   * streamSimple spawns fresh and starts counting over).
   */
  lastSentCount: number;
}

/* ----------------------------- registration ----------------------------- */

export function registerProvider(pi: ExtensionAPI): void {
  // Module-level config; slash commands mutate this.
  const config: ProviderConfig = createDefaultConfig();

  // Optional HTTP log proxy.  Same lifecycle as before: lazy-start, point the
  // subprocess at it via env, forward to whichever upstream we end up using.
  let logProxyPromise: Promise<LogProxyHandle> | undefined;
  const httpLogPath = process.env.PI_CAS_HTTP_LOG?.trim();
  if (httpLogPath) {
    const logResponseBody =
      process.env.PI_CAS_HTTP_LOG_RESPONSES === "1" ||
      process.env.PI_CAS_HTTP_LOG_RESPONSES === "true";
    logProxyPromise = startLogProxy({
      initialUpstreamBaseUrl: "https://api.anthropic.com",
      logFilePath: httpLogPath,
      logResponseBody,
    });
    logProxyPromise.then(
      (h) =>
        console.error(
          `[pi-cas] HTTP log proxy listening on ${h.getBaseUrl()} → (per-turn upstream); ` +
            `log: ${h.logFilePath}${logResponseBody ? " (with response bodies)" : ""}`,
        ),
      (err) =>
        console.error(
          `[pi-cas] HTTP log proxy failed to start: ${
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

  // Lifecycle: tear down on shutdown / fork / compact.  See module docstring.
  registerLifecycleHooks(pi, config);

  registerSlashCommands(pi, config, badge);

  const models = getModels("anthropic").map((m) => ({
    id: m.id,
    name: m.name,
    reasoning: m.reasoning,
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
      // On a hard shutdown ("quit"), keep the mapping so the next pi launch
      // can resume.  On reload/new/resume/fork, clear it — those reasons
      // mean the next pi-cas instance for this id should NOT pick up the
      // old SDK session.
      if (event.reason !== "quit") {
        clearSessionMapping(piId);
      }
    }
    config.sessions.clear();
  });

  pi.on("session_before_fork", async (event) => {
    if (DEBUG) console.error(`[pi-cas/debug] session_before_fork entry=${event.entryId} position=${event.position}`);
    // V1: tear down + clear mapping.  Next streamSimple after the fork will
    // spawn a fresh query with no SDK-side history (i.e. the model loses
    // context).  This is the documented v1 limitation; v2 should use the
    // SDK's forkSession + resumeSessionAt to preserve history.
    for (const [piId, session] of config.sessions) {
      await teardownSession(session, "session_before_fork");
      clearSessionMapping(piId);
    }
    config.sessions.clear();
    // Don't cancel the fork — return without a result/decision means "proceed".
  });

  pi.on("session_before_compact", async () => {
    if (DEBUG) console.error(`[pi-cas/debug] session_before_compact`);
    // Same handling as fork: tear down the SDK session.  Pi will replace
    // its history with the compaction summary and the next streamSimple
    // will spawn fresh.
    for (const [piId, session] of config.sessions) {
      await teardownSession(session, "session_before_compact");
      clearSessionMapping(piId);
    }
    config.sessions.clear();
  });
}

/**
 * Cleanly tear down a long-lived SDK query.  Best-effort: never throws.
 */
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

    // 3. Extract the new user-side content from pi's messages.
    const newUserBlocks = extractNewUserContent(context.messages, session.lastSentCount);
    session.lastSentCount = context.messages.length;

    if (DEBUG) {
      console.error(
        `[pi-cas/debug] new user blocks: ${newUserBlocks.length} (types=${newUserBlocks
          .map((b: any) => b.type)
          .join(",")})`,
      );
    }

    // No new user content → either pi sent us a no-op or the SDK already
    // handled this internally.  Push an empty `done` to keep pi happy.
    if (newUserBlocks.length === 0) {
      const empty: any = makeEmptyAssistantMessage(model);
      stream.push({ type: "done", reason: "stop", message: empty } as any);
      stream.end();
      return;
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

    // 5. Enqueue the new user message into the long-lived gen.
    const enqueuePromise = new Promise<void>((resolve, reject) => {
      session.promptQueue.push({
        content: newUserBlocks,
        resolved: resolve,
        failed: reject,
      });
      if (session.genWaker) {
        const w = session.genWaker;
        session.genWaker = null;
        w();
      }
    });

    // 6. Consume SDK events for this turn.
    const bridge = createEventBridge(stream, model);
    session.inFlight = true;
    try {
      // Wait until the gen has actually yielded our message before we start
      // counting events for "this turn" — otherwise a delayed prior turn
      // could leak events into ours.  enqueuePromise resolves inside the
      // gen body after `yield` returns control.
      await enqueuePromise;

      // The query's event consumer is shared across all turns.  We pluck
      // events off the persistent iterator until we see a `result`.
      //
      // NOTE: we MUST NOT use `for await ... break`, which calls
      // `iter.return()` and closes the generator.  We use the iterator
      // directly so subsequent turns keep reading from the same stream.
      while (true) {
        const next = await session.iter.next();
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
        // Capture sdk_session_id from the very first init event.
        if (
          !session.sdkSessionId &&
          msg.type === "system" &&
          msg.subtype === "init" &&
          msg.session_id
        ) {
          session.sdkSessionId = msg.session_id;
          setSessionMapping(session.piSessionId, msg.session_id);
        }
        bridge.handle(msg);
        if (msg.type === "result") {
          break;
        }
      }
    } catch (err: any) {
      if (DEBUG) console.error(`[pi-cas/debug] consume loop threw:`, err);
      pushError(stream, model, err?.message ?? String(err), bridge);
      session.inFlight = false;
      return;
    } finally {
      if (options?.signal) {
        options.signal.removeEventListener("abort", abortListener);
      }
    }
    session.inFlight = false;

    // 7. Fast-mode state + badge update.
    const fms = bridge.getFastModeState();
    config.lastModel = model.id;
    if (fms) config.lastFastModeState = fms;
    if (DEBUG && fms) {
      console.error(
        `[pi-cas/debug] fast_mode_state=${fms}, cost=$${bridge.getCost()?.toFixed(4) ?? "?"}`,
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

    // 8. Push final done.
    const output = bridge.getOutput();
    const hasToolCalls = output.content.some((c) => c.type === "toolCall");
    const reason: "stop" | "length" | "toolUse" =
      output.stopReason === "toolUse" || hasToolCalls
        ? "toolUse"
        : output.stopReason === "length"
          ? "length"
          : "stop";
    output.stopReason = reason;
    stream.push({ type: "done", reason, message: output } as any);
    stream.end();
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

  // Spawn fresh.  If we have a persisted SDK session id, resume into it so
  // the SDK can replay its own (clean, properly-paired) JSONL.
  const resumeId = getSessionMapping(piSessionId);
  if (DEBUG) {
    console.error(
      `[pi-cas/debug] spawning query: pi=${piSessionId} cwd=${cwd} resume=${resumeId ?? "(none)"}`,
    );
  }

  // Resolve okta relay BEFORE spawning so we can fail fast.
  let relay: RelayConfig | undefined;
  if (config.oktaEnabled) {
    relay = await requestRelay(pi, {
      preferredProvider: config.oktaProvider,
      timeoutMs: 8000,
    });
    config.lastOktaProvider = relay.provider;
    config.lastOktaBaseUrl = relay.baseUrl;
    if (DEBUG) {
      console.error(
        `[pi-cas/debug] okta relay resolved: ${relay.provider} → ${relay.baseUrl}`,
      );
    }
  }

  // Build the env for the subprocess.
  const env = buildSubprocessEnv(config, model, relay);

  // HTTP log proxy: point the subprocess at it.
  if (logProxyPromise) {
    try {
      const proxy = await logProxyPromise;
      const trueUpstream = env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com";
      proxy.setUpstreamBaseUrl(trueUpstream);
      env.ANTHROPIC_BASE_URL = proxy.getBaseUrl();
      if (DEBUG) {
        console.error(
          `[pi-cas/debug] log proxy active: ${proxy.getBaseUrl()} → ${trueUpstream}`,
        );
      }
    } catch (err) {
      if (DEBUG) console.error(`[pi-cas/debug] log proxy unavailable:`, err);
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
    cwd,
    env,
    ...(resumeId ? { resume: resumeId } : {}),
    ...(fastFrag.extraArgs ? { extraArgs: fastFrag.extraArgs } : {}),
    effort: mapEffort(options?.reasoning),
    thinking: buildThinkingConfig(model, options?.reasoning, options?.thinkingBudgets),
  };

  const q = query({ prompt: promptGen(), options: sdkOpts });

  // Capture the iterator once.  See PiSession.iter docstring for why we
  // can't use `for await`-with-break across multiple turns.
  const iter = (q as any)[Symbol.asyncIterator]() as AsyncIterator<any>;

  const session: PiSession = {
    piSessionId,
    sdkSessionId: undefined,
    query: q,
    iter,
    promptQueue,
    genWaker: null,
    ended: false,
    inFlight: false,
    cwd,
    model: model.id,
    permissionMode: config.permissionMode,
    // We're about to enqueue the message that corresponds to context.messages
    // up to and including the most recent user-side block.  Mark "everything
    // before this call" as already consumed; the calling streamSimple will
    // update lastSentCount = context.messages.length after extracting.
    lastSentCount: 0,
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
  _model: Model<any>,
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

/* ----------------------------- message extraction ----------------------------- */

/**
 * Extract the new user-side content from pi's messages, starting at
 * `fromIndex`.  Returns a single Anthropic-style content array suitable
 * for one `SDKUserMessage`.
 *
 * In the Option A architecture pi-cas does NOT execute tools, so:
 *   - We only care about new user messages.
 *   - Assistant messages are ignored (the SDK already has them).
 *   - Tool result messages are ignored (the SDK already executed and saw
 *     the result internally; pi shouldn't be feeding them back).
 *
 * If pi sends multiple new user messages (rare but possible if it batches
 * turns), we concatenate their content blocks.
 */
function extractNewUserContent(
  messages: ReadonlyArray<any>,
  fromIndex: number,
): any[] {
  const blocks: any[] = [];
  for (let i = fromIndex; i < messages.length; i++) {
    const m = messages[i];
    if (!m || m.role !== "user") continue;
    if (Array.isArray(m.content)) {
      for (const block of m.content) {
        const translated = piBlockToAnthropic(block);
        if (translated) blocks.push(translated);
      }
    } else if (typeof m.content === "string") {
      blocks.push({ type: "text", text: m.content });
    }
  }
  return blocks;
}

/**
 * Translate a pi content block into an Anthropic-shaped block the SDK
 * accepts.  Returns null for blocks we should skip (toolResult — see
 * extractNewUserContent docstring).
 */
function piBlockToAnthropic(block: any): any | null {
  if (!block || typeof block !== "object") return null;
  switch (block.type) {
    case "text":
      return { type: "text", text: block.text ?? "" };
    case "image":
      // Pi uses { type: "image", image: { data, mimeType } } sometimes; the
      // Anthropic shape is { type: "image", source: { type: "base64", media_type, data } }.
      if (block.source) return block;  // already Anthropic-shaped
      if (block.image) {
        return {
          type: "image",
          source: {
            type: "base64",
            media_type: block.image.mimeType ?? "image/png",
            data: block.image.data,
          },
        };
      }
      return null;
    case "toolResult":
    case "tool_result":
      // SDK runs tools internally; ignore any tool_result blocks from pi.
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
  bridge?: ReturnType<typeof createEventBridge>,
): void {
  const output = bridge ? bridge.getOutput() : makeEmptyAssistantMessage(model);
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
  _pi: ExtensionAPI,
  ctx: any,
  _customType: string,
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
      emit(pi, ctx, "pi-cas/auth", text);
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
      emit(pi, ctx, "pi-cas/fast", text);
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
      emit(pi, ctx, "pi-cas/okta", detail.join("\n"));
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
          pi,
          ctx,
          "pi-cas/perm",
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
          pi,
          ctx,
          "pi-cas/perm",
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
        pi,
        ctx,
        "pi-cas/perm",
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
      emit(pi, ctx, "pi-cas/status", lines.join("\n"));
    },
  });
}
