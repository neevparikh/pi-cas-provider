/**
 * Stream-aligned segmenting event bridge.
 *
 * Translates the Agent SDK's message stream into pi's AssistantMessageEvent
 * stream, ONE SEGMENT AT A TIME.  A "segment" is one Anthropic assistant
 * message — text + thinking + tool_use blocks emitted between an SDK
 * `message_start` and `message_stop`, plus the matching tool_result(s)
 * the SDK produces by running the tool internally.
 *
 * # Why segment per assistant message instead of per SDK turn
 *
 * The SDK's `query()` runs a multi-message turn internally: assistant
 * (text+tool_use) → SDK runs the tool → assistant (more text+maybe more
 * tools) → ... → assistant (end_turn).  The previous "Option A" bridge
 * accumulated ALL assistant content into one pi `done`, which made pi's
 * agent loop see (and try to execute) toolCall content blocks the SDK
 * had already run.
 *
 * Stream-aligned segmentation gives pi ONE assistant message per pi
 * `streamSimple` call.  Pi sees a normal text+toolCalls assistant message,
 * runs the stub tools (`stub-tools.ts`) which look up cached SDK
 * results, then loops streamSimple for the next segment.  See
 * provider.ts for how multi-segment turns are driven by pi's loop.
 *
 * # Boundary contract
 *
 * A segment is "closed" (ready to push pi `done`) when BOTH:
 *   1. We've seen `message_stop` for the current Anthropic assistant message
 *   2. For every `tool_use` block in this segment, we've ingested the
 *      matching `user(tool_result)` SDKUserMessage (cached + tracked).
 *
 * The two e2e probes (probe-stub-tools.mjs, probe-stub-tools-edge.mjs)
 * confirm `tool_result` events always arrive AFTER `message_stop` and
 * BEFORE the next `message_start`.  So we hold the segment open across
 * the (~200ms typical) gap.
 *
 * # State
 *
 * The bridge is stateful across multiple streamSimple calls within one
 * pi session.  Per-segment state is reset on each new `message_start`;
 * cross-segment state (sdkSessionId, fast_mode_state, accumulated
 * cost/usage) persists.
 */

import type {
  AssistantMessage,
  AssistantMessageEventStream,
  ImageContent,
  Model,
  TextContent,
  ThinkingContent,
  ToolCall,
} from "@earendil-works/pi-ai";
import { calculateCost } from "@earendil-works/pi-ai";

import { PROVIDER_ID } from "./config.js";
import { put as cacheToolResult, type CachedToolResult } from "./tool-result-cache.js";
import { isSupportedStubTool } from "./stub-tools.js";
import {
  AUTO_TURN_TOOL_NAME,
  type AutoTurnBlock,
  type AutoTurnDetails,
} from "./auto-turn-stub.js";
import {
  appendAssistant as transcriptAppendAssistant,
  appendToolResult as transcriptAppendToolResult,
  markFinished as transcriptMarkFinished,
  recordProgress as transcriptRecordProgress,
  start as transcriptStart,
  take as transcriptTake,
} from "./subagent-transcript.js";

const DEBUG = process.env.PI_CAS_DEBUG === "1";

/**
 * Targeted timing diagnostic for "assistant text didn't render until <X>"
 * investigations — covers AskUserQuestion (text + tool_use(AskUserQuestion)
 * + waiting on user) and Monitor (text + tool_use(Monitor) + waiting on
 * tool_result that may be delayed if the SDK holds it until first stdout
 * line / monitor exit).  Gated by its own env var so it doesn't spam normal
 * DEBUG sessions with per-text-block logs.
 *
 * Enable via: PI_CAS_SEGMENT_TIMING=1
 *
 * Logs are wall-clock ms (process-uptime-relative) so they line up with the
 * matching logs in `interactive-tools.ts` (same `T0`).
 */
const TIMING_DEBUG = process.env.PI_CAS_SEGMENT_TIMING === "1";
const TIMING_T0 = Date.now();
function tlog(msg: string): void {
  if (!TIMING_DEBUG) return;
  const t = String(Date.now() - TIMING_T0).padStart(7);
  console.error(`[pi-cas/timing][bridge ] +${t}ms ${msg}`);
}

/** Tracked content block within the current segment. */
interface Tracked {
  /** Anthropic content_block index — resets per Anthropic assistant message. */
  index: number;
  /** Index in `output.content` (pi's view). */
  piIndex: number;
  kind: "text" | "thinking" | "tool_use";
  /** Accumulator for input_json_delta on tool_use blocks. */
  partialJson?: string;
  /** Original CC tool name for tool_use blocks. */
  toolName?: string;
}

/* -------------------- auto-turn detection state machine -------------------- */

/**
 * SDK lifecycle phase, tracked via `system.status`, `message_start`, and
 * `result` events.  Used to discriminate auto-triggered turns (model
 * responses to task-notifications injected by Monitor/background-Bash/etc.)
 * from user-input-response turns.  See `writeups/monitor_desync.md`.
 */
type SdkState = "idle" | "api_requesting" | "in_turn";

/**
 * One user prompt the provider has pushed into the SDK's promptQueue.
 * The bridge uses these to decide whether a new turn is "for" a push or
 * is an auto-trigger.  Discriminator (in `noteNewTurnStarting`):
 *   - push at head exists AND (push was made while sdkState was idle, OR
 *     push.pushTime < lastResultTime) → next turn is the response. Pop head.
 *   - otherwise → next turn is auto-triggered.
 */
interface PendingPush {
  pushTime: number;
  wasIdleAtPushTime: boolean;
}

/**
 * One captured `system.task_notification` event, retained briefly so the
 * bridge can correlate it with the auto-trigger that follows.  We use the
 * correlation to populate `AutoTurnDetails.trigger` for the renderer (so
 * the user sees e.g. "AutoTurn (Bash) — bg-probe-test completed").
 */
interface PendingTaskNotification {
  time: number;
  toolUseId?: string;
  toolName?: string;
  status?: string;
  summary?: string;
  outputFile?: string;
}

/** An auto-turn whose events we've absorbed instead of streaming to pi.
 * Held until the next user-response turn message_start, when the bridge
 * synthesises a `__pi_cas_auto_turn` tool_use into pi's output and caches
 * the absorbed content as that tool's result. */
interface BufferedAutoTurn {
  blocks: AutoTurnBlock[];
  trigger?: AutoTurnDetails["trigger"];
  usage?: AutoTurnDetails["usage"];
  isError?: boolean;
}

/** Per-Anthropic-message tracking inside an auto-turn.  Reset on each
 * message_start within the auto-turn (turns may contain multiple
 * assistant messages, e.g. text → tool_use → tool_result → text).
 * Resolves on content_block_stop to push a finished block into
 * `currentAutoTurn.blocks`. */
interface AutoTurnTracked {
  index: number;
  kind: "text" | "thinking" | "tool_use";
  text?: string;           // for text/thinking accumulator
  partialJson?: string;    // for tool_use json args accumulator
  toolUseId?: string;
  toolName?: string;
}

/** Max age of a task_notification we still consider "fresh enough" to
 * correlate with an arriving auto-trigger.  Empirically ~10ms between
 * the notification system event and the matching status=requesting in
 * the bg-bash probe; 2s is generous. */
const NOTIFICATION_CORRELATION_WINDOW_MS = 2000;

/** Stop reason mapped to pi's vocabulary. */
type PiStopReason = AssistantMessage["stopReason"];

export interface EventBridge {
  /** Bind a new pi event stream for the next segment.  Called by provider
   * at the start of each streamSimple call.
   *
   * `model` is the model selected for THIS segment.  Pi sessions can switch
   * model mid-conversation (via the model picker / setModel control); the
   * bridge needs the current model for accurate `output.model` recording
   * and cost calculation. */
  attachStream(stream: AssistantMessageEventStream, model: Model<any>): void;

  /** Feed one SDK message. */
  handle(msg: any): void;

  /** True once message_stop has been observed for the current segment AND
   * every pending tool_result has been ingested. */
  isSegmentReady(): boolean;

  /** True once the SDK emits its `result` for the whole turn. */
  isTurnDone(): boolean;

  /** Rearm for a fresh SDK turn.  Provider calls this after draining the
   * turn-end `result` event off the iterator, so the next streamSimple's
   * consume loop doesn't see stale `turnDone=true`. */
  resetTurn(): void;

  /** Captured error message from a turn-level `result` with `is_error: true`
   * (auth failure, rate limit, etc.).  Undefined if the turn ended normally. */
  getTurnError(): string | undefined;

  /** True if the bridge has accumulated any per-segment state (a `start`
   * has been pushed to the pi stream and/or content blocks have started
   * arriving).  Used to decide whether to emit partial content alongside
   * an error or just push an error event. */
  hasPartialContent(): boolean;

  /** Return a copy of the in-progress segment's AssistantMessage (text,
   * thinking, partial tool_use blocks that have been streamed so far).
   * Used by the provider on the error path so partial content is
   * preserved instead of being discarded.  After calling this, the
   * provider should still close the stream (via `closeStreamWithError`
   * or directly) and `resetTurn` to rearm. */
  getPartialOutput(): AssistantMessage;

  /** Push an `error` event carrying the bridge's accumulated partial
   * content (if any) plus the supplied error message; ends the pi stream
   * and resets per-segment state.  Use this on the error path when the
   * SDK turn aborted mid-message; otherwise pi loses the partial text
   * the user already started seeing on screen. */
  closeStreamWithError(message: string): void;

  /** Get the pi-flavored stop reason for the current segment. */
  getSegmentStopReason(): PiStopReason;

  /** Get the tool_use_ids emitted in the segment now being closed.  Used by
   * the provider to set up phantom-toolResult detection for the next
   * streamSimple. */
  getCurrentSegmentToolUseIds(): string[];

  /** Push pi's terminal `done` event for the current segment, close the pi
   * stream, and reset per-segment state.  Returns the segment's
   * accumulated AssistantMessage (for the provider to inspect or persist). */
  closeSegment(): AssistantMessage;

  /** Session-scoped: sdk_session_id captured from `system.init`. */
  getSdkSessionId(): string | undefined;

  /** Session-scoped: latest fast_mode_state from a result message. */
  getFastModeState(): "off" | "cooldown" | "on" | undefined;

  /** Session-scoped: total cost across this turn (and beyond — accumulating). */
  getCost(): number | undefined;

  /* -------------------- auto-turn detection API -------------------- */

  /** Notify the bridge that the provider has just pushed a new user
   * prompt into the SDK's promptQueue.  The bridge uses this to
   * discriminate the SDK turn that responds to this push from auto-
   * triggered turns (from Monitor / backgrounded Bash / etc.) that may
   * be already buffered in the SDK iter.  Call this AFTER enqueuing into
   * promptQueue, with `Date.now()` or equivalent. */
  notePush(pushTime: number): void;

  /** Synthetic tool_use_ids the bridge has injected during the most
   * recent closed segment.  Provider adds these to its phantom-detection
   * set so the resulting toolResult messages from pi don't get
   * misclassified.  Cleared on closeSegment alongside
   * `getCurrentSegmentToolUseIds`. */
  getSyntheticToolUseIdsForCurrentSegment(): string[];
}

/**
 * Per-bridge options.  All optional.
 */
export interface EventBridgeOptions {
  /**
   * Called the FIRST time the bridge observes a `tool_use` block whose name
   * isn't in {@link SUPPORTED_CC_TOOL_NAMES}.
   *
   * The provider uses this to register a catch-all stub via
   * `pi.registerTool` before pi's agent loop tries to execute the unknown
   * tool (which would otherwise crash with `Tool <name> not found`).  The
   * bridge fires this callback at `content_block_start` time — well before
   * the segment closes — so pi sees the stub by the time it processes the
   * `done` event.
   *
   * The callback should be idempotent (the bridge does NOT dedupe across
   * invocations within or across sessions).  The provider is expected to
   * track a "registered" set itself.
   *
   * The callback should not throw; the bridge does not handle errors here
   * and a throw would abort the entire SDK message processing for the
   * segment.
   */
  onUnknownToolName?: (toolName: string) => void;
}

export function createEventBridge(
  initialModel: Model<any>,
  options: EventBridgeOptions = {},
): EventBridge {
  // Current model for this segment.  Updated on `attachStream` so a
  // mid-session model switch is reflected in both the recorded
  // `output.model` and `calculateCost()` per-token rates.
  let currentModel: Model<any> = initialModel;

  // Cross-segment / cross-turn state.
  let sdkSessionId: string | undefined;
  let fastModeState: "off" | "cooldown" | "on" | undefined;
  let cost: number | undefined;
  let turnError: string | undefined;

  // --- auto-turn detection state (cross-segment, cross-turn) ---
  //
  // Tracks the SDK's lifecycle so we can discriminate auto-triggered
  // turns (model auto-runs on task-notifications from Monitor/bg-Bash/etc.)
  // from user-response turns.  Updated by `noteStatusRequesting`,
  // `noteMessageStart`, and `noteResult` inside the existing event handlers.
  let sdkState: SdkState = "idle";
  let lastResultTime = 0;
  const pushQueue: PendingPush[] = [];
  let currentTurnKind: "user_response" | "auto_triggered" | "unknown" = "unknown";
  const recentTaskNotifications: PendingTaskNotification[] = [];

  // Auto-turn buffering (cross-segment).  When `currentTurnKind ===
  // "auto_triggered"`, content blocks and tool_results are collected
  // into `currentAutoTurn` instead of being pushed to pi's stream.
  // On the turn-ending `result`, currentAutoTurn moves into
  // `bufferedAutoTurns`.  On the next user-response message_start, the
  // bridge synthesises a `__pi_cas_auto_turn` tool_use per buffered turn,
  // pre-populates the tool-result-cache, and pushes synthetic toolcall
  // events to pi's stream BEFORE forwarding the real response's content.
  let currentAutoTurn: BufferedAutoTurn | null = null;
  const bufferedAutoTurns: BufferedAutoTurn[] = [];
  // Persistent map from tool_use_id → tool name, populated whenever the
  // bridge sees ANY tool_use block (main-thread, auto-turn, or
  // subagent-leaked).  Used by `resolveToolNameById` to label auto-turn
  // triggers with the originating tool's name even when that tool was
  // called in a long-gone segment (e.g. Bash run_in_background's tool_use
  // landed in segment #1; the completion notification correlates with
  // a synthetic injected into segment #3).  Bounded growth in practice
  // (one entry per tool_use the SDK emits in this session); not worth
  // explicit eviction yet.
  const toolUseIdToName = new Map<string, string>();
  // Per-Anthropic-message tracking inside the current auto-turn.  Reset
  // on each message_start within the auto-turn; resolved on
  // content_block_stop to push the finished block into currentAutoTurn.
  let autoTurnTracked: AutoTurnTracked[] = [];
  // Synthetic tool_use_ids injected during the in-progress segment.
  // Captured by the provider via `getSyntheticToolUseIdsForCurrentSegment`
  // when the segment closes (mirrors `segmentToolUseIds`).
  let segmentSyntheticToolUseIds: string[] = [];
  let nextSyntheticIdCounter = 0;
  // Map auto-turn tool_use_id (real, from SDK) → which BufferedAutoTurn
  // it belongs to.  Used so that `ingestToolResult` knows to append the
  // result to the auto-turn's blocks (not pi's main stream).
  const autoTurnIds = new Set<string>();

  // Per-segment state — reset on each new Anthropic message_start.
  let stream: AssistantMessageEventStream | undefined;
  let output: AssistantMessage = freshOutput(currentModel);
  let blocks: Tracked[] = [];
  let pendingToolUseIds = new Set<string>();
  let segmentToolUseIds: string[] = [];
  let sawMessageStop = false;
  let sawAnyContentForSegment = false;
  let segmentStarted = false;
  let turnDone = false;
  let rawStopReason: string | undefined;

  function resetSegment(): void {
    output = freshOutput(currentModel);
    blocks = [];
    pendingToolUseIds = new Set();
    segmentToolUseIds = [];
    segmentSyntheticToolUseIds = [];
    sawMessageStop = false;
    sawAnyContentForSegment = false;
    segmentStarted = false;
    rawStopReason = undefined;
  }

  /* -------------------- auto-turn helpers -------------------- */

  /** Called when we see a `system.status` event with status === "requesting".
   * Classifies the upcoming turn as user_response (it's the model
   * answering one of our pushed prompts) or auto_triggered (the SDK is
   * auto-running the model on an internally-injected task-notification).
   *
   * The discriminator: do we have a queued push whose in-flight at-push-
   * time activity has cleared by now?  If yes, this turn is its response.
   * Otherwise the turn is auto-triggered.
   *
   * Only acts when sdkState transitions IDLE → API_REQUESTING (a NEW turn).
   * Within-turn status=requesting events (e.g. SDK calls the model again
   * after running a tool) are ignored — they don't start a new turn. */
  function noteStatusRequesting(): void {
    if (sdkState !== "idle") {
      // Mid-turn re-request (e.g. SDK runs a tool then calls model again).
      // Doesn't change kind.
      return;
    }
    sdkState = "api_requesting";
    // Pick the next claimable push.  A push is claimable if EITHER:
    //   (a) wasIdleAtPushTime: the push hit when SDK was quiescent, so
    //       the very next API call is for it; OR
    //   (b) lastResultTime > pushTime: whatever was in-flight at push
    //       time has now ended, so the next API call is for this push.
    const head = pushQueue[0];
    if (head && (head.wasIdleAtPushTime || head.pushTime < lastResultTime)) {
      currentTurnKind = "user_response";
      pushQueue.shift();
      if (DEBUG) {
        console.error(
          `[pi-cas/debug] new turn classified user_response ` +
            `(push at t=${head.pushTime}, lastResult=${lastResultTime})`,
        );
      }
    } else {
      currentTurnKind = "auto_triggered";
      if (DEBUG) {
        const reason = head
          ? `head push at t=${head.pushTime} > lastResult=${lastResultTime}`
          : "no pending push";
        console.error(`[pi-cas/debug] new turn classified auto_triggered (${reason})`);
      }
      // Start collecting blocks for this auto-turn.
      currentAutoTurn = {
        blocks: [],
        trigger: correlateNearestNotification(Date.now()),
      };
    }
  }

  /** Called from the result-event branch of `handle()`.  Always: marks
   * sdkState=idle and updates lastResultTime.  If we were absorbing an
   * auto-turn: flushes currentAutoTurn into bufferedAutoTurns. */
  function noteResult(t: number, isError: boolean, usage: any): void {
    lastResultTime = t;
    sdkState = "idle";
    if (currentTurnKind === "auto_triggered" && currentAutoTurn) {
      currentAutoTurn.isError = isError;
      if (usage) {
        const u = currentAutoTurn.usage ?? {};
        if (typeof usage.input_tokens === "number") u.input = usage.input_tokens;
        if (typeof usage.output_tokens === "number") u.output = usage.output_tokens;
        if (typeof usage.cache_read_input_tokens === "number")
          u.cacheRead = usage.cache_read_input_tokens;
        if (typeof usage.cache_creation_input_tokens === "number")
          u.cacheWrite = usage.cache_creation_input_tokens;
        u.totalTokens = (u.input ?? 0) + (u.output ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
        currentAutoTurn.usage = u;
      }
      bufferedAutoTurns.push(currentAutoTurn);
      if (DEBUG) {
        console.error(
          `[pi-cas/debug] auto-turn buffered (${currentAutoTurn.blocks.length} blocks, ` +
            `isError=${isError}); total buffered=${bufferedAutoTurns.length}`,
        );
      }
      currentAutoTurn = null;
    }
    currentTurnKind = "unknown";
  }

  /** Called on `system.task_notification` — store briefly so the next
   * auto-trigger that fires can be labeled with the triggering tool. */
  function noteTaskNotification(msg: any, t: number): void {
    const toolUseId =
      typeof msg.tool_use_id === "string" ? msg.tool_use_id : undefined;
    const notif: PendingTaskNotification = {
      time: t,
      toolUseId,
      toolName: toolUseId ? resolveToolNameById(toolUseId) : undefined,
      status: typeof msg.status === "string" ? msg.status : undefined,
      summary: typeof msg.summary === "string" ? msg.summary : undefined,
      outputFile:
        typeof msg.output_file === "string" ? msg.output_file : undefined,
    };
    recentTaskNotifications.push(notif);
    // Trim ancient entries.  Anything older than 2× the correlation
    // window can't possibly match a new auto-trigger.
    const cutoff = t - NOTIFICATION_CORRELATION_WINDOW_MS * 2;
    while (
      recentTaskNotifications.length > 0 &&
      recentTaskNotifications[0].time < cutoff
    ) {
      recentTaskNotifications.shift();
    }
  }

  /** Resolve a tool_use_id to its tool name via the persistent
   * `toolUseIdToName` map, populated whenever we see any tool_use block. */
  function resolveToolNameById(id: string): string | undefined {
    return toolUseIdToName.get(id);
  }

  /** Find a recent task_notification close in time to `now`, if any. */
  function correlateNearestNotification(now: number): AutoTurnDetails["trigger"] | undefined {
    // Prefer the most recent notification within the window.
    for (let i = recentTaskNotifications.length - 1; i >= 0; i--) {
      const n = recentTaskNotifications[i];
      if (now - n.time <= NOTIFICATION_CORRELATION_WINDOW_MS) {
        return {
          toolUseId: n.toolUseId,
          toolName: n.toolName,
          status: n.status,
          summary: n.summary,
          outputFile: n.outputFile,
        };
      }
    }
    return undefined;
  }

  /** Inject synthetic `__pi_cas_auto_turn` tool_use blocks at the start
   * of the current user-response segment.  Pre-populates the tool-result-
   * cache so pi's executor's later cache lookup succeeds.  Records the
   * synthetic ids in `segmentSyntheticToolUseIds` for the provider to
   * track as phantoms.
   *
   * Must be called AFTER `ensureStreamStarted` (so pi's stream is open)
   * and BEFORE we forward the real assistant message's content_blocks. */
  function injectBufferedAutoTurns(): void {
    if (bufferedAutoTurns.length === 0) return;
    if (!stream) return;

    for (const turn of bufferedAutoTurns) {
      const id = `pi-cas-auto-${sdkSessionId ?? "default"}-${nextSyntheticIdCounter++}`;
      const piIndex = output.content.length;

      // Build a short args object the renderer can show in renderCall.
      const args: Record<string, unknown> = {
        trigger_summary: turn.trigger?.summary,
        trigger_tool_name: turn.trigger?.toolName,
        block_count: turn.blocks.length,
      };

      // Append the toolCall to pi's view of output.content.
      output.content.push({
        type: "toolCall",
        id,
        name: AUTO_TURN_TOOL_NAME,
        arguments: args,
      } as ToolCall);
      // Track in blocks[] so subsequent index lookups don't get confused.
      // Use a synthetic ccIdx that can't collide with the SDK's (-1 etc.
      // would technically work, but we use a large negative offset to make
      // it obvious in debug logs).
      const syntheticCcIdx = -1_000_000 - nextSyntheticIdCounter;
      blocks.push({
        index: syntheticCcIdx,
        piIndex,
        kind: "tool_use",
        toolName: AUTO_TURN_TOOL_NAME,
        partialJson: JSON.stringify(args),
      });

      // Pre-populate the cache with the absorbed content + AutoTurnDetails.
      const details: AutoTurnDetails = {
        _piCasIsError: turn.isError,
        _piCasToolName: AUTO_TURN_TOOL_NAME,
        trigger: turn.trigger,
        blocks: turn.blocks,
        usage: turn.usage,
      };
      // Cache entry's `content` field is what pi's stub's execute returns.
      // Use a one-line summary so a no-renderResult fallback shows something
      // reasonable; the rich view comes from `renderResult` reading details.
      const summaryText = autoTurnSummaryText(turn);
      const entry: CachedToolResult = {
        content: [{ type: "text", text: summaryText }],
        isError: Boolean(turn.isError),
        toolName: AUTO_TURN_TOOL_NAME,
        details,
      };
      cacheToolResult(id, entry);

      // Push the synthetic stream events.
      stream.push({ type: "toolcall_start", contentIndex: piIndex, partial: output });
      stream.push({
        type: "toolcall_delta",
        contentIndex: piIndex,
        delta: JSON.stringify(args),
        partial: output,
      });
      stream.push({
        type: "toolcall_end",
        contentIndex: piIndex,
        toolCall: output.content[piIndex] as ToolCall,
        partial: output,
      });

      segmentSyntheticToolUseIds.push(id);
      if (DEBUG) {
        console.error(
          `[pi-cas/debug] injected synthetic auto-turn tool_use id=${id.slice(-12)} ` +
            `at piIndex=${piIndex} (${turn.blocks.length} blocks, ` +
            `trigger=${turn.trigger?.toolName ?? "?"})`,
        );
      }
    }
    // Consumed — clear for the next streamSimple's segment.
    bufferedAutoTurns.length = 0;
  }

  function autoTurnSummaryText(turn: BufferedAutoTurn): string {
    const trig = turn.trigger;
    const head = trig?.toolName
      ? `AutoTurn (${trig.toolName}${trig.status ? `, ${trig.status}` : ""})`
      : "AutoTurn (notification)";
    const trailingText = (() => {
      for (let i = turn.blocks.length - 1; i >= 0; i--) {
        const b = turn.blocks[i];
        if (b.kind === "text") return b.text.trim();
        if (b.kind === "tool_use" || b.kind === "tool_result") return "";
      }
      return "";
    })();
    if (trailingText) {
      const firstLine = trailingText.split("\n")[0]?.trim() ?? "";
      const preview = firstLine.length > 120 ? `${firstLine.slice(0, 120)}...` : firstLine;
      return `${head}\n${preview}`;
    }
    return head;
  }

  /** Append a content block to the current auto-turn buffer.  No-op if
   * not currently absorbing. */
  function appendBlockToAutoTurn(block: AutoTurnBlock): void {
    if (!currentAutoTurn) return;
    currentAutoTurn.blocks.push(block);
  }

  function ensureStreamStarted(): void {
    if (!stream) return;
    if (segmentStarted) return;
    segmentStarted = true;
    stream.push({ type: "start", partial: output });
  }

  function handle(msg: any): void {
    // sdk_session_id (only on the very first init of the long-lived query).
    if (msg.type === "system" && msg.subtype === "init") {
      sdkSessionId = msg.session_id ?? sdkSessionId;
      return;
    }

    // **Subagent handling — typed-message path.**
    //
    // When a Task (subagent) is in flight, the SDK emits the subagent's
    // assistant/user/tool_progress messages on the same iterator as the
    // main thread, tagged with `parent_tool_use_id != null`.  We must
    // keep these OUT of pi's view of the main-thread segment (they'd
    // appear as extra tool_call blocks pi tries to execute, and their
    // nested tool_results would corrupt our pendingToolUseIds pairing).
    //
    // BUT we don't just drop them — we capture them into a per-Task-id
    // `SubagentTranscript` (see `src/subagent-transcript.ts`).  When the
    // parent Task tool_result eventually arrives (parent_tool_use_id=null),
    // the bridge attaches the collected transcript to the cache entry's
    // `details` under `_piCasSubagentTranscript`.  Pi's Task stub
    // (`src/task-stub.ts`) reads this in its `renderResult` and renders
    // the nested transcript (reasoning, tool calls, final output) the
    // same way pi-subagent's renderer does.
    //
    // This relies on the SDK forwarding subagent text/thinking — which
    // requires `forwardSubagentText: true` in SDK options.  Without it,
    // only subagent tool_use/tool_result blocks are forwarded, and the
    // rendered transcript only shows the tool calls.  See provider.ts
    // ensureSession() where the option is set.
    if (msg.parent_tool_use_id != null) {
      const parentId = String(msg.parent_tool_use_id);
      if (DEBUG) {
        console.error(
          `[pi-cas/debug] capturing subagent event: type=${msg.type} ` +
            `parent_tool_use_id=${parentId.slice(-8)} ` +
            (msg.subagent_type ? `subagent_type=${msg.subagent_type} ` : ""),
        );
      }
      // Defensive recovery: if the SDK leaked subagent tool_use blocks
      // into the main segment via SSE partials (we couldn't tell at that
      // point — SSE wraps the inner BetaMessage which doesn't carry
      // parent_tool_use_id), now that we have the typed assistant message
      // confirming "those were subagent tool_uses", remove them from
      // pendingToolUseIds so the main segment can still close.
      if (msg.type === "assistant") {
        const content = msg.message?.content;
        if (Array.isArray(content)) {
          cleanupLeakedSubagentToolUses(content);
          transcriptAppendAssistant(
            parentId,
            content,
            msg.message?.usage,
            msg.message?.model,
            msg.message?.stop_reason,
          );
        }
      } else if (msg.type === "user") {
        const content = msg.message?.content;
        if (Array.isArray(content)) {
          let first = true;
          for (const block of content) {
            if (block?.type === "tool_result") {
              transcriptAppendToolResult(
                parentId,
                block,
                first ? msg.tool_use_result : undefined,
              );
              first = false;
            }
          }
        }
      }
      // tool_progress messages tagged with parent_tool_use_id: don't
      // append to transcript (already encapsulated in tool_use_result
      // when ingested above) — just drop.
      return;
    }

    // Task lifecycle / progress system messages.  We use these to populate
    // subagent transcript metadata (subagent_type, task description,
    // running summary, final status) so the Task stub's renderResult can
    // display the same kind of UI pi-subagent shows for its delegated
    // agents.  They are NOT surfaced to pi's main message stream.
    if (msg.type === "system" && typeof msg.subtype === "string") {
      const sub = msg.subtype as string;
      const toolUseId: string | undefined =
        typeof msg.tool_use_id === "string" ? msg.tool_use_id : undefined;
      if (sub === "task_started" && toolUseId) {
        transcriptStart(toolUseId, {
          subagentType: typeof msg.subagent_type === "string" ? msg.subagent_type : undefined,
          taskPrompt: typeof msg.prompt === "string" ? msg.prompt : undefined,
          description: typeof msg.description === "string" ? msg.description : undefined,
          taskId: typeof msg.task_id === "string" ? msg.task_id : undefined,
        });
        if (DEBUG) {
          console.error(
            `[pi-cas/debug] task_started tu=${toolUseId.slice(-8)} ` +
              `subagent_type=${msg.subagent_type ?? "?"}`,
          );
        }
        return;
      }
      if (sub === "task_progress" && toolUseId) {
        transcriptRecordProgress(toolUseId, {
          summary: typeof msg.summary === "string" ? msg.summary : undefined,
          lastToolName: typeof msg.last_tool_name === "string" ? msg.last_tool_name : undefined,
          subagentType:
            typeof msg.subagent_type === "string" ? msg.subagent_type : undefined,
        });
        return;
      }
      if (sub === "task_notification" && toolUseId) {
        const status = msg.status;
        if (status === "completed" || status === "failed" || status === "stopped") {
          transcriptMarkFinished(toolUseId, {
            status,
            summary: typeof msg.summary === "string" ? msg.summary : undefined,
          });
        }
        // Also record for auto-turn correlation (independent of subagent
        // transcript path; both can coexist for the same notification).
        noteTaskNotification(msg, Date.now());
        return;
      }
      if (sub === "status" && msg.status === "requesting") {
        // New API call beginning OR mid-turn re-request.  See
        // `noteStatusRequesting` for state-machine logic.
        noteStatusRequesting();
        return;
      }
      if (sub === "task_updated") {
        // Status patches; we already track the final status via
        // task_notification.  Drop with debug log.
        if (DEBUG) {
          console.error(
            `[pi-cas/debug] task_updated task_id=${String(msg.task_id ?? "?").slice(-8)}`,
          );
        }
        return;
      }
    }

    // `tool_progress` system events fire periodically for in-flight tools
    // (including main-thread tools).  We don't currently surface them.
    // The main-thread case (`parent_tool_use_id === null`) passes through
    // the earlier filter — explicitly drop here.
    if (msg.type === "tool_progress") {
      return;
    }

    // The SDK emits typed assistant message events as `type: "assistant"` AFTER
    // the streaming `stream_event` partials.  We rely on partials for most
    // accumulation; the `assistant` event is a no-op here except for the
    // diagnostic case where partials were absent.  See appendFinalBlock().
    if (msg.type === "assistant") {
      // Auto-trigger mode: typed assistant event is the post-stream
      // mirror; we already absorbed via stream_events.  Skip output.content
      // mutation since auto-turns aren't pi-visible.
      if (currentTurnKind === "auto_triggered") {
        return;
      }
      // If we somehow received no stream events for this message, fall back
      // to materializing content from the final message.  (Not expected with
      // `includePartialMessages: true`.)
      ensureStreamStarted();
      const bm = msg.message;
      if (bm?.usage) updateUsage(bm.usage);
      // Only fallback-materialize if there are no tracked content blocks yet.
      if (output.content.length === 0 && Array.isArray(bm?.content)) {
        for (const b of bm.content) appendFinalBlock(b);
      }
      return;
    }

    // SDK reports each tool's result back via a `user` SDKUserMessage whose
    // content array contains tool_result blocks.  Cache them keyed by
    // tool_use_id; clear the pending set entry.
    //
    // SDKUserMessage.tool_use_result is singular (one structured detail per
    // SDKUserMessage) and the SDK in practice sends one tool_result content
    // block per message.  We assert that pairing here: tool_use_result is
    // only attached to the FIRST tool_result block.  Subsequent blocks (if
    // any — not observed in current SDK behavior) get undefined details to
    // avoid silently cross-attributing structured details from tool A to
    // tool B.
    if (msg.type === "user") {
      const c = msg.message?.content;
      if (Array.isArray(c)) {
        let first = true;
        for (const block of c) {
          if (block.type === "tool_result") {
            if (currentTurnKind === "auto_triggered" && currentAutoTurn) {
              // Route to auto-turn buffer; don't populate the main
              // cache (pi never asks for these — auto-turn tool_uses
              // aren't pi-visible).
              const content = normalizeToolResultContent(block.content);
              const textContent = content
                .filter((c) => c.type === "text")
                .map((c) => (c as any).text)
                .join("\n");
              appendBlockToAutoTurn({
                kind: "tool_result",
                tool_use_id: String(block.tool_use_id ?? ""),
                content: textContent,
                is_error: block.is_error === true,
              });
              autoTurnIds.add(String(block.tool_use_id ?? ""));
            } else {
              ingestToolResult(block, first ? msg.tool_use_result : undefined);
            }
            first = false;
          }
        }
      }
      return;
    }

    // SDK partial events — Anthropic SSE-shaped.
    if (msg.type === "stream_event" || msg.type === "partial_assistant") {
      const event = msg.event ?? msg;
      handleSseEvent(event);
      return;
    }

    if (msg.type === "result") {
      if (typeof msg.total_cost_usd === "number") cost = msg.total_cost_usd;
      if (msg.fast_mode_state) fastModeState = msg.fast_mode_state;
      // Capture turn classification BEFORE noteResult clears it.
      const wasAutoTriggered = currentTurnKind === "auto_triggered";
      // updateUsage targets `output.usage` (the user-visible segment).
      // For auto-triggered turns, the usage goes onto the auto-turn buffer
      // (handled inside noteResult).  Skip updateUsage when we're closing
      // out an auto-turn so the user-visible segment's usage stays clean.
      if (msg.usage && !wasAutoTriggered) updateUsage(msg.usage);
      // noteResult: clears auto-turn state machine; if we were absorbing,
      // flushes currentAutoTurn into bufferedAutoTurns.
      noteResult(Date.now(), msg.is_error === true, msg.usage);
      // DO NOT set turnDone for auto-trigger turns.  Provider's consume
      // loop must keep running to observe the next turn (which might be
      // another auto-trigger or the user-response turn).  turnDone fires
      // only when the user-response (or unattributed) turn fully ends.
      if (wasAutoTriggered) {
        if (DEBUG) console.error(`[pi-cas/debug] auto-turn result; NOT setting turnDone`);
        // Don't propagate error from auto-turn to turnError; user-response
        // turn might still succeed.  (Operators can find auto-turn errors
        // in the AutoTurnDetails.isError field.)
        return;
      }
      turnDone = true;
      if (msg.is_error === true) {
        // SDK signaled a turn-level error (auth failure, rate limit, server
        // 5xx, etc.).  Capture a human-readable message so the provider can
        // surface it instead of pushing an empty successful done.
        const subtype = typeof msg.subtype === "string" ? msg.subtype : "error";
        const inner =
          typeof msg.result === "string"
            ? msg.result
            : typeof msg.error === "string"
              ? msg.error
              : typeof msg.error?.message === "string"
                ? msg.error.message
                : JSON.stringify(msg.result ?? msg.error ?? {}).slice(0, 500);
        turnError = `[${subtype}] ${inner}`.trim();
      }
      return;
    }
  }

  function handleSseEvent(event: any): void {
    switch (event.type) {
      case "message_start": {
        // sdkState bookkeeping (regardless of turn kind):
        sdkState = "in_turn";

        // Auto-trigger mode: collect content into currentAutoTurn instead
        // of streaming to pi.  Reset per-message tracking.
        if (currentTurnKind === "auto_triggered") {
          autoTurnTracked = [];
          return;
        }

        // Boundary: a new Anthropic assistant message begins.  If we were
        // mid-segment (which means provider hasn't called closeSegment yet)
        // this is a bug — but defensive: reset.
        if (sawMessageStop || sawAnyContentForSegment) {
          if (DEBUG) {
            console.error(
              "[pi-cas/debug] message_start mid-segment — provider should have " +
                "closed the previous segment first",
            );
          }
          resetSegment();
        }
        ensureStreamStarted();
        sawAnyContentForSegment = true;
        if (event.message?.usage) updateUsage(event.message.usage);
        // First Anthropic assistant message in a user-response turn?
        // Inject buffered auto-turns right after `start` (which
        // ensureStreamStarted just pushed).  See `injectBufferedAutoTurns`.
        if (bufferedAutoTurns.length > 0) {
          injectBufferedAutoTurns();
        }
        // Tracked-block indices reset per message — already cleared by
        // resetSegment / fresh segment.
        return;
      }

      case "content_block_start": {
        // Auto-trigger mode: track without streaming to pi.
        if (currentTurnKind === "auto_triggered") {
          const cb = event.content_block;
          const ccIdx = event.index ?? 0;
          if (cb.type === "text") {
            autoTurnTracked.push({ index: ccIdx, kind: "text", text: "" });
          } else if (cb.type === "thinking") {
            autoTurnTracked.push({ index: ccIdx, kind: "thinking", text: "" });
          } else if (cb.type === "tool_use") {
            autoTurnTracked.push({
              index: ccIdx,
              kind: "tool_use",
              partialJson: "",
              toolUseId: cb.id,
              toolName: cb.name,
            });
            toolUseIdToName.set(cb.id, cb.name);
          }
          return;
        }

        sawAnyContentForSegment = true;
        ensureStreamStarted();
        const cb = event.content_block;
        const ccIdx = event.index ?? 0;
        if (cb.type === "text") {
          const piIndex = output.content.length;
          output.content.push({ type: "text", text: "" } as TextContent);
          blocks.push({ index: ccIdx, piIndex, kind: "text" });
          stream?.push({ type: "text_start", contentIndex: piIndex, partial: output });
          tlog(`pushed text_start    contentIndex=${piIndex} ccIdx=${ccIdx}`);
        } else if (cb.type === "thinking") {
          const piIndex = output.content.length;
          output.content.push({
            type: "thinking",
            thinking: "",
            thinkingSignature: "",
          } as ThinkingContent);
          blocks.push({ index: ccIdx, piIndex, kind: "thinking" });
          stream?.push({ type: "thinking_start", contentIndex: piIndex, partial: output });
        } else if (cb.type === "tool_use") {
          const piIndex = output.content.length;
          if (!isSupportedStubTool(cb.name)) {
            // Notify the provider so it can register a catch-all stub before
            // pi's loop tries to execute this tool.  See EventBridgeOptions
            // docstring.  Bridge does no deduping; provider is responsible.
            if (options.onUnknownToolName) {
              try {
                options.onUnknownToolName(cb.name);
              } catch (err) {
                // Defensive: a throw here would corrupt the segment, so log
                // and continue.  pi may still crash at execute time, but
                // logging gives operators a fighting chance to diagnose.
                console.error(
                  `[pi-cas] onUnknownToolName callback threw for "${cb.name}": ${
                    err instanceof Error ? err.message : String(err)
                  }`,
                );
              }
            }
            if (DEBUG) {
              console.error(
                `[pi-cas/debug] SDK emitted unsupported tool_use name "${cb.name}". ` +
                  `Falling back to dynamic catch-all stub.`,
              );
            }
          }
          output.content.push({
            type: "toolCall",
            id: cb.id,
            name: cb.name,
            arguments: {},
          } as ToolCall);
          blocks.push({
            index: ccIdx,
            piIndex,
            kind: "tool_use",
            partialJson: "",
            toolName: cb.name,
          });
          pendingToolUseIds.add(cb.id);
          segmentToolUseIds.push(cb.id);
          toolUseIdToName.set(cb.id, cb.name);
          stream?.push({ type: "toolcall_start", contentIndex: piIndex, partial: output });
          tlog(
            `pushed toolcall_start contentIndex=${piIndex} ccIdx=${ccIdx} ` +
              `name=${cb.name} id=${String(cb.id).slice(-8)}`,
          );
        }
        return;
      }

      case "content_block_delta": {
        // Auto-trigger mode: accumulate into autoTurnTracked instead.
        if (currentTurnKind === "auto_triggered") {
          const aut = autoTurnTracked.find((b) => b.index === event.index);
          if (!aut) return;
          const d = event.delta;
          if (d.type === "text_delta" && aut.kind === "text") {
            aut.text = (aut.text ?? "") + (d.text ?? "");
          } else if (d.type === "thinking_delta" && aut.kind === "thinking") {
            aut.text = (aut.text ?? "") + (d.thinking ?? "");
          } else if (d.type === "input_json_delta" && aut.kind === "tool_use") {
            aut.partialJson = (aut.partialJson ?? "") + (d.partial_json ?? "");
          }
          return;
        }

        const tracked = blocks.find((b) => b.index === event.index);
        if (!tracked) return;
        const d = event.delta;
        if (d.type === "text_delta" && tracked.kind === "text") {
          const block = output.content[tracked.piIndex] as TextContent;
          block.text += d.text ?? "";
          stream?.push({
            type: "text_delta",
            contentIndex: tracked.piIndex,
            delta: d.text ?? "",
            partial: output,
          });
        } else if (d.type === "thinking_delta" && tracked.kind === "thinking") {
          const block = output.content[tracked.piIndex] as ThinkingContent;
          block.thinking += d.thinking ?? "";
          stream?.push({
            type: "thinking_delta",
            contentIndex: tracked.piIndex,
            delta: d.thinking ?? "",
            partial: output,
          });
        } else if (d.type === "signature_delta" && tracked.kind === "thinking") {
          const block = output.content[tracked.piIndex] as ThinkingContent;
          block.thinkingSignature = (block.thinkingSignature ?? "") + (d.signature ?? "");
        } else if (d.type === "input_json_delta" && tracked.kind === "tool_use") {
          tracked.partialJson = (tracked.partialJson ?? "") + (d.partial_json ?? "");
          try {
            const parsed = JSON.parse(tracked.partialJson);
            (output.content[tracked.piIndex] as ToolCall).arguments = parsed;
          } catch {
            /* incomplete json — wait for more deltas */
          }
          stream?.push({
            type: "toolcall_delta",
            contentIndex: tracked.piIndex,
            delta: d.partial_json ?? "",
            partial: output,
          });
        }
        return;
      }

      case "content_block_stop": {
        // Auto-trigger mode: finalize and append to currentAutoTurn.
        if (currentTurnKind === "auto_triggered") {
          const aut = autoTurnTracked.find((b) => b.index === event.index);
          if (!aut) return;
          if (aut.kind === "text") {
            appendBlockToAutoTurn({ kind: "text", text: aut.text ?? "" });
          } else if (aut.kind === "thinking") {
            appendBlockToAutoTurn({ kind: "thinking", text: aut.text ?? "" });
          } else if (aut.kind === "tool_use") {
            let parsedArgs: Record<string, unknown> = {};
            try {
              parsedArgs = JSON.parse(aut.partialJson ?? "");
            } catch {
              /* keep empty */
            }
            appendBlockToAutoTurn({
              kind: "tool_use",
              id: aut.toolUseId ?? "",
              name: aut.toolName ?? "?",
              arguments: parsedArgs,
            });
          }
          return;
        }

        const tracked = blocks.find((b) => b.index === event.index);
        if (!tracked) return;
        if (tracked.kind === "text") {
          const block = output.content[tracked.piIndex] as TextContent;
          stream?.push({
            type: "text_end",
            contentIndex: tracked.piIndex,
            content: block.text,
            partial: output,
          });
          tlog(
            `pushed text_end      contentIndex=${tracked.piIndex} ` +
              `len=${block.text.length}`,
          );
        } else if (tracked.kind === "thinking") {
          const block = output.content[tracked.piIndex] as ThinkingContent;
          stream?.push({
            type: "thinking_end",
            contentIndex: tracked.piIndex,
            content: block.thinking,
            partial: output,
          });
        } else if (tracked.kind === "tool_use") {
          let parsedArgs: Record<string, unknown> = {};
          try {
            parsedArgs = JSON.parse(tracked.partialJson ?? "");
          } catch {
            /* fall through with empty args */
          }
          (output.content[tracked.piIndex] as ToolCall).arguments = parsedArgs;
          stream?.push({
            type: "toolcall_end",
            contentIndex: tracked.piIndex,
            toolCall: output.content[tracked.piIndex] as ToolCall,
            partial: output,
          });
          tlog(
            `pushed toolcall_end   contentIndex=${tracked.piIndex} ` +
              `name=${tracked.toolName} id=${String((output.content[tracked.piIndex] as ToolCall).id).slice(-8)}`,
          );
        }
        return;
      }

      case "message_delta": {
        // Auto-trigger mode: skip touching the user-visible segment's
        // stopReason/usage.
        if (currentTurnKind === "auto_triggered") return;
        if (event.delta?.stop_reason) {
          rawStopReason = event.delta.stop_reason;
        }
        if (event.usage) updateUsage(event.usage);
        return;
      }

      case "message_stop": {
        // Auto-trigger mode: don't mark sawMessageStop (user-response
        // segment isn't ready yet).
        if (currentTurnKind === "auto_triggered") {
          return;
        }
        sawMessageStop = true;
        tlog(`saw message_stop      pendingToolUseIds=${pendingToolUseIds.size}`);
        return;
      }
    }
  }

  /**
   * Defensive recovery for the case where the SDK emitted subagent SSE
   * `stream_event` partials that we couldn't filter at the time (the
   * stream-event wrapper doesn't carry `parent_tool_use_id`).  When the
   * subsequent typed `assistant` event arrives and tells us those blocks
   * were subagent-internal, walk its tool_use ids and:
   *
   *  1. Remove them from `pendingToolUseIds` (otherwise the segment never
   *     closes — we'll never get a matching parent=null tool_result for a
   *     subagent-internal tool).
   *  2. Remove them from `segmentToolUseIds` (so they don't show up in the
   *     "phantom-detection" set for the next streamSimple).
   *  3. Remove the corresponding `output.content` entries so pi doesn't
   *     see ghost tool_call blocks.
   *
   * If the SDK never leaks subagent partials (the expected case with
   * `forwardSubagentText: false` / unset), this function is a no-op
   * because none of the listed ids will be in our tracking maps.
   */
  function cleanupLeakedSubagentToolUses(subagentContent: any[]): void {
    const subagentIds = new Set<string>();
    for (const b of subagentContent) {
      if (b?.type === "tool_use" && typeof b.id === "string") {
        subagentIds.add(b.id);
      }
    }
    if (subagentIds.size === 0) return;
    let cleaned = 0;
    for (const id of subagentIds) {
      if (pendingToolUseIds.delete(id)) cleaned++;
    }
    segmentToolUseIds = segmentToolUseIds.filter((id) => !subagentIds.has(id));
    // Walk blocks/output and drop matching tool_use entries.  Index in
    // output.content is `piIndex`; remove from both blocks[] tracking
    // and output.content.  Iterate in reverse so splices don't disturb
    // earlier indices.
    for (let i = blocks.length - 1; i >= 0; i--) {
      const tracked = blocks[i];
      if (
        tracked.kind === "tool_use" &&
        subagentIds.has((output.content[tracked.piIndex] as ToolCall).id)
      ) {
        const piIndex = tracked.piIndex;
        output.content.splice(piIndex, 1);
        blocks.splice(i, 1);
        // Shift remaining piIndex references that pointed AFTER the
        // removed slot.
        for (const other of blocks) {
          if (other.piIndex > piIndex) other.piIndex -= 1;
        }
      }
    }
    if (cleaned > 0 && DEBUG) {
      console.error(
        `[pi-cas/debug] cleaned up ${cleaned} leaked subagent tool_use(s) ` +
          `from pending set: ${[...subagentIds].map((id) => id.slice(-8)).join(",")}`,
      );
    }
  }

  function ingestToolResult(block: any, sdkToolUseResult: unknown): void {
    const id: string = block.tool_use_id;
    if (!id) return;
    const isError = block.is_error === true;
    const content = normalizeToolResultContent(block.content);
    // Resolve the tool name: we need it for pi's display.  Look it up from
    // tracked blocks in the current segment.
    const tracked = blocks.find((b) => b.kind === "tool_use" && id === (output.content[b.piIndex] as ToolCall).id);
    const toolName = tracked?.toolName ?? "Unknown";

    // If this tool_result is for a Task tool that ran a subagent, attach
    // the collected subagent transcript to the cache entry's `details`
    // (under `_piCasSubagentTranscript`).  The Task stub's renderResult
    // reads it and renders the nested transcript.  Take semantics free
    // the in-memory entry so it doesn't accumulate across long sessions.
    const subagentTranscript = transcriptTake(id);
    let details: unknown = sdkToolUseResult;
    if (subagentTranscript) {
      // Merge: preserve SDK's `tool_use_result` shape (object | string |
      // undefined) under a sibling key when it's not plain-object-shaped,
      // or splat it when it is.  The Task stub looks up
      // `_piCasSubagentTranscript` regardless of the surrounding shape.
      const sdkIsPlainObject =
        sdkToolUseResult !== null &&
        typeof sdkToolUseResult === "object" &&
        !Array.isArray(sdkToolUseResult);
      if (sdkIsPlainObject) {
        details = {
          ...(sdkToolUseResult as Record<string, unknown>),
          _piCasSubagentTranscript: subagentTranscript,
        };
      } else {
        details = {
          _piCasSubagentTranscript: subagentTranscript,
          ...(sdkToolUseResult !== undefined
            ? { _piCasToolUseResult: sdkToolUseResult }
            : {}),
        };
      }
      if (DEBUG) {
        console.error(
          `[pi-cas/debug] attached subagent transcript to ${toolName} ` +
            `tool_result (tu=${id.slice(-8)}, ${subagentTranscript.messages.length} msgs, ` +
            `status=${subagentTranscript.finalStatus ?? "?"})`,
        );
      }
    }

    const entry: CachedToolResult = {
      content,
      isError,
      toolName,
      details,
    };
    cacheToolResult(id, entry);
    pendingToolUseIds.delete(id);
    tlog(
      `ingested tool_result name=${toolName} id=${id.slice(-8)} ` +
        `isError=${isError} pendingNow=${pendingToolUseIds.size}`,
    );
  }

  function updateUsage(u: any): void {
    if (typeof u.input_tokens === "number") output.usage.input = u.input_tokens;
    if (typeof u.output_tokens === "number") output.usage.output = u.output_tokens;
    if (typeof u.cache_read_input_tokens === "number")
      output.usage.cacheRead = u.cache_read_input_tokens;
    if (typeof u.cache_creation_input_tokens === "number")
      output.usage.cacheWrite = u.cache_creation_input_tokens;
    output.usage.totalTokens =
      output.usage.input +
      output.usage.output +
      output.usage.cacheRead +
      output.usage.cacheWrite;
    calculateCost(currentModel, output.usage);
  }

  function appendFinalBlock(b: any): void {
    if (b.type === "text") {
      output.content.push({ type: "text", text: b.text ?? "" } as TextContent);
    } else if (b.type === "thinking") {
      output.content.push({
        type: "thinking",
        thinking: b.thinking ?? "",
        thinkingSignature: b.signature ?? "",
      } as ThinkingContent);
    } else if (b.type === "tool_use") {
      // Mirror the partial-event path: notify the provider so it can
      // register a catch-all stub for unknown names before pi tries to
      // execute the tool.  This branch is the diagnostic fallback for
      // SDK messages that arrived without streaming partials.
      if (!isSupportedStubTool(b.name) && options.onUnknownToolName) {
        try {
          options.onUnknownToolName(b.name);
        } catch (err) {
          console.error(
            `[pi-cas] onUnknownToolName callback threw for "${b.name}": ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }
      output.content.push({
        type: "toolCall",
        id: b.id,
        name: b.name,
        arguments: (b.input ?? {}) as Record<string, unknown>,
      } as ToolCall);
      pendingToolUseIds.add(b.id);
      segmentToolUseIds.push(b.id);
    }
  }

  function mapStopReason(raw: string | undefined): PiStopReason {
    switch (raw) {
      case "tool_use":
        return "toolUse";
      case "max_tokens":
        return "length";
      case "end_turn":
      default:
        return "stop";
    }
  }

  function isSegmentReady(): boolean {
    // Segment is ready when message_stop is observed AND every tool_use
    // emitted in this segment has its tool_result ingested.
    if (!sawMessageStop) return false;
    if (pendingToolUseIds.size > 0) return false;
    return true;
  }

  function closeSegment(): AssistantMessage {
    if (DEBUG) {
      console.error(
        `[pi-cas/debug] closing segment: ` +
          `content=${output.content.length} blocks, ` +
          `toolUseIds=${segmentToolUseIds.length}, ` +
          `stopReason=${rawStopReason}, sawMessageStop=${sawMessageStop}`,
      );
    }
    const stopReason = mapStopReason(rawStopReason);
    output.stopReason = stopReason;
    if (stream) {
      ensureStreamStarted();
      stream.push({ type: "done", reason: stopReason, message: output } as any);
      stream.end();
    }
    const finalized = output;
    // Reset for next segment.  Cross-segment state (sdkSessionId, cost, etc.)
    // is preserved.
    resetSegment();
    stream = undefined;
    return finalized;
  }

  return {
    attachStream(s, model) {
      stream = s;
      // Adopt the segment's selected model.  Mid-session switches (via
      // pi's model picker / setModel) need this so output.model and
      // calculateCost both reflect the new model, not the one we were
      // first constructed with.  If the segment is currently in-progress
      // (rare), also refresh output.model so existing accumulators stay
      // consistent with the new rates.
      const modelChanged = model.id !== currentModel.id || model.provider !== currentModel.provider;
      currentModel = model;
      if (modelChanged) {
        output.provider = model.provider;
        output.model = model.id;
      }
      // If we're starting a NEW segment (because the previous one's done was
      // pushed and the iterator is paused at a message boundary), reset segment
      // state.  If we're mid-segment (rare — provider should always close
      // before re-attaching), keep state intact.
      if (segmentStarted) {
        // Re-attaching mid-segment: push `start` with current output so the
        // new stream is well-formed.
        stream.push({ type: "start", partial: output });
      }
    },
    resetTurn(): void {
      // Called by the provider after consuming a turn-final `result` event,
      // so a subsequent streamSimple call for a new turn starts cleanly.
      // Per-segment state is already clean post-closeSegment; only the
      // cross-segment turn-level flags need clearing.
      turnDone = false;
      turnError = undefined;
    },
    getTurnError: () => turnError,
    /** Whether the bridge has accumulated any partial content for the
     * current segment.  Used by the provider's error-handling path to
     * decide whether to surface partial content vs. push an empty error. */
    hasPartialContent(): boolean {
      return segmentStarted || output.content.length > 0 || sawAnyContentForSegment;
    },
    getPartialOutput(): AssistantMessage {
      // Defensive clone: callers shouldn't mutate our internal state.
      // Content blocks are shallow-cloned (the inner text/thinking strings
      // are primitives, and ToolCall.arguments is best-effort already).
      return {
        ...output,
        content: output.content.map((c) => ({ ...c })) as AssistantMessage["content"],
        usage: { ...output.usage, cost: { ...output.usage.cost } },
      };
    },
    closeStreamWithError(message: string): void {
      output.stopReason = "error";
      output.errorMessage = message;
      if (stream) {
        ensureStreamStarted();
        stream.push({ type: "error", reason: "error", error: output } as any);
        stream.end();
      }
      resetSegment();
      stream = undefined;
    },
    handle,
    isSegmentReady,
    isTurnDone: () => turnDone,
    getSegmentStopReason: () => mapStopReason(rawStopReason),
    getCurrentSegmentToolUseIds: () => [...segmentToolUseIds],
    closeSegment,
    getSdkSessionId: () => sdkSessionId,
    getFastModeState: () => fastModeState,
    getCost: () => cost,
    notePush(pushTime: number): void {
      const wasIdleAtPushTime = sdkState === "idle";
      pushQueue.push({ pushTime, wasIdleAtPushTime });
      if (DEBUG) {
        console.error(
          `[pi-cas/debug] notePush t=${pushTime} sdkState=${sdkState} ` +
            `wasIdle=${wasIdleAtPushTime} queueLen=${pushQueue.length}`,
        );
      }
    },
    getSyntheticToolUseIdsForCurrentSegment: () => [...segmentSyntheticToolUseIds],
  };
}

/* ----------------------------- helpers ----------------------------- */

function freshOutput(model: Model<any>): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: PROVIDER_ID as any,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

/** Normalize the SDK's tool_result `content` field (string | array) into
 * pi's content block array. */
function normalizeToolResultContent(c: unknown): (TextContent | ImageContent)[] {
  if (typeof c === "string") {
    return [{ type: "text", text: c } as TextContent];
  }
  if (Array.isArray(c)) {
    const blocks: (TextContent | ImageContent)[] = [];
    for (const item of c) {
      if (!item || typeof item !== "object") continue;
      if (item.type === "text") {
        blocks.push({ type: "text", text: item.text ?? "" } as TextContent);
      } else if (item.type === "image") {
        // Anthropic image source { type: "base64", media_type, data }
        const src = item.source ?? {};
        blocks.push({
          type: "image",
          data: src.data ?? "",
          mimeType: src.media_type ?? "image/png",
        } as ImageContent);
      }
    }
    return blocks;
  }
  // Defensive: unknown shape → stringify.
  return [{ type: "text", text: typeof c === "undefined" ? "" : JSON.stringify(c) } as TextContent];
}
