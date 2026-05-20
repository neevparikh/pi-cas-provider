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
 * session and reuses it forever.  The SDK manages its own JSONL transcript
 * internally; pi-cas never feeds history back via `--resume`.
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
 *   - `session_shutdown`: tear down the long-lived query (gen.return() +
 *     interrupt()).
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
import { createEventBridge, type EventBridge } from "./event-bridge.js";
import { getAuthStatus, formatAuthBanner, formatAuthDetails } from "./auth.js";
import { FastModeBadge } from "./badge.js";
import {
  createStubTools,
  isSupportedStubTool,
  SUPPORTED_CC_TOOL_NAMES,
} from "./stub-tools.js";
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

  // Register stub tools that pi's agent loop will "execute" by retrieving
  // SDK-cached results.  See `stub-tools.ts` for the full rationale.
  for (const tool of createStubTools()) {
    pi.registerTool(tool);
  }
  if (DEBUG) {
    console.error(
      `[pi-cas/debug] registered ${SUPPORTED_CC_TOOL_NAMES.length} stub tools: ` +
        SUPPORTED_CC_TOOL_NAMES.join(", "),
    );
  }

  // Register a `tool_result` event handler so the SDK's `is_error` flag
  // on each tool_result propagates to pi's ToolResultMessage.isError.
  // The stub tool stuffs the flag into `details._piCasIsError`; we read it
  // here and return an override.  (AgentTool.execute has no `isError`
  // return field — pi infers isError from whether execute() throws.
  // Throwing would lose the SDK's structured details, so we use this
  // post-hoc override instead.)
  pi.on("tool_result", (event) => {
    if (!isSupportedStubTool(event.toolName)) return undefined;
    const flag = (event.details as Record<string, unknown> | undefined)?._piCasIsError;
    if (typeof flag === "boolean") {
      return { isError: flag };
    }
    return undefined;
  });

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

    // 3. Classify the new pi-side content since lastSentCount.
    const classification = classifyNewContent(
      context.messages,
      session.lastSentCount,
      session.recentlyEmittedToolUseIds,
    );
    session.lastSentCount = context.messages.length;

    if (DEBUG) {
      console.error(
        `[pi-cas/debug] classify: kind=${classification.kind} ` +
          `realBlocks=${classification.realUserBlocks.length} ` +
          `phantomIds=${classification.phantomToolResultIds.length} ` +
          `unexpectedIds=${classification.unexpectedToolResultIds.length}`,
      );
    }

    if (classification.unexpectedToolResultIds.length > 0 && DEBUG) {
      console.error(
        `[pi-cas/debug] WARN: unexpected toolResult ids (not in recently-emitted set): ` +
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
    }
    // If kind === "phantom", we just consume more SDK events with no enqueue.
    // The SDK is mid-turn (between assistant messages, internally running
    // tools); the next event we read will be the next assistant message_start.

    // 6. Attach the persistent bridge to the new pi stream and consume
    //    SDK events until the bridge signals "segment ready".
    session.bridge.attachStream(stream);
    session.inFlight = true;
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
        // Turn ended without any assistant message (empty / error turn).
        // Synthesize an empty done and rearm the bridge for the next turn.
        if (DEBUG) console.error("[pi-cas/debug] turn ended without segment; pushing empty done");
        const empty = makeEmptyAssistantMessage(model);
        stream.push({ type: "done", reason: "stop", message: empty } as any);
        stream.end();
        session.bridge.resetTurn();
        session.inFlight = false;
        return;
      }

      // Capture the segment's tool-use ids BEFORE closing (closeSegment
      // resets per-segment state).  These become the "phantom" set for
      // the next streamSimple.
      const segmentToolUseIds = session.bridge.getCurrentSegmentToolUseIds();
      const segmentStopReason = session.bridge.getSegmentStopReason();
      session.bridge.closeSegment();
      session.recentlyEmittedToolUseIds = new Set(segmentToolUseIds);

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
      session.inFlight = false;
      return;
    } finally {
      if (options?.signal) {
        options.signal.removeEventListener("abort", abortListener);
      }
    }
    session.inFlight = false;

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
    // Restrict the model's tool surface to exactly the CC built-ins we have
    // pi stubs for (see stub-tools.ts).  If the model emits a tool_use whose
    // name isn't in this list, pi's agent loop will fail with `Tool <name>
    // not found` because we wouldn't have a stub registered.
    tools: [...SUPPORTED_CC_TOOL_NAMES],
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
    bridge: createEventBridge(model),
    recentlyEmittedToolUseIds: new Set(),
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

/* ----------------------------- message classification ----------------------------- */

/**
 * Result of classifying a streamSimple call's new content (everything in
 * `context.messages.slice(lastSentCount)`).
 *
 * Tells the provider whether to enqueue a fresh user message into the SDK
 * prompt iterator (`real`), skip the enqueue and just consume the next SDK
 * segment (`phantom`), or push an empty `done` (`empty`).
 */
interface NewContentClassification {
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
function classifyNewContent(
  messages: ReadonlyArray<any>,
  fromIndex: number,
  recentlyEmittedIds: ReadonlySet<string>,
): NewContentClassification {
  const realUserBlocks: any[] = [];
  const phantomToolResultIds: string[] = [];
  const unexpectedToolResultIds: string[] = [];

  for (let i = fromIndex; i < messages.length; i++) {
    const m = messages[i];
    if (!m) continue;

    if (m.role === "toolResult") {
      // Pi's top-level toolResult message shape (see pi-ai types.d.ts:203).
      // The toolCallId tells us whether it's one of ours.
      const id = m.toolCallId;
      if (typeof id === "string") {
        if (recentlyEmittedIds.has(id)) {
          phantomToolResultIds.push(id);
        } else {
          unexpectedToolResultIds.push(id);
        }
      }
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
            if (typeof id === "string") {
              if (recentlyEmittedIds.has(id)) {
                phantomToolResultIds.push(id);
              } else {
                unexpectedToolResultIds.push(id);
              }
            }
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
    kind = "phantom";
  } else {
    kind = "empty";
  }

  return { kind, realUserBlocks, phantomToolResultIds, unexpectedToolResultIds };
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
    case "image":
      // Pi uses { type: "image", image: { data, mimeType } } sometimes; the
      // Anthropic shape is { type: "image", source: { type: "base64", media_type, data } }.
      if (block.source) return block; // already Anthropic-shaped
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
