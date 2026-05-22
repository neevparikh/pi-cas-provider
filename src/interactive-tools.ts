/**
 * Interactive-tool host: bridges the SDK's `canUseTool` permission hook
 * to pi-tui UI, so model-driven `AskUserQuestion` calls actually surface a
 * picker to the user instead of being auto-denied by the SDK.
 *
 * # Why
 *
 * `AskUserQuestion` (and a few other tools — see `INTERACTIVE_TOOL_NAMES`)
 * are "client-side" in the SDK: their `checkPermissions()` always returns
 * `{behavior: "ask", message: "Answer questions?"}`, meaning the SDK
 * delegates the actual user-facing flow to the host application.  The CC
 * interactive app renders a TUI picker; we render a pi-tui picker.
 *
 * # Flow
 *
 *   Model emits tool_use: AskUserQuestion {questions: [...]}
 *     │
 *     ▼
 *   SDK calls `canUseTool("AskUserQuestion", input, {signal, ...})`
 *     │
 *     ▼
 *   `handleCanUseTool` (this module) inspects toolName, dispatches to
 *   `askUserQuestionDialog(input, ctx, signal)`
 *     │
 *     ▼
 *   pi-tui overlay rendered via `ctx.ui.custom(...)`; user picks options
 *     │
 *     ▼
 *   Returns `{behavior: "allow", updatedInput: {...input, answers}}` to SDK
 *     │
 *     ▼
 *   SDK calls the tool's `call({questions, answers, annotations})`,
 *   which formats the standard `"User has answered your questions: ..."`
 *   tool_result.  Model sees a real answer.
 *
 * # Getting an ExtensionContext into canUseTool
 *
 * `canUseTool` is an SDK option callback — it has no `ctx` parameter and
 * pi's `ExtensionAPI` has no global `.ui` accessor.  The UI is only
 * available via the `ctx: ExtensionContext` passed to event handlers and
 * tool `execute()` calls.
 *
 * Workaround: we stash the most recently-seen `ctx` in a closure (see
 * `provider.ts` `ctxRef`).  Pi fires `before_agent_start` / `turn_start`
 * etc. well before any tool_use streams out, so by the time the SDK
 * invokes canUseTool, `ctxRef.current` is set.  Headless / RPC mode has
 * `ctx.hasUI === false` and we gracefully deny.
 *
 * # Limitations (v1)
 *
 * - One question at a time (modal); multi-question prompts iterate.
 * - No "Other" / free-text fallback (we don't render an inline editor).
 * - No preview-content rendering for options with `preview` (mockups/code).
 * - No annotation/notes support (the SDK schema allows free-text per-
 *   question notes; we don't collect them).
 * - SDK signal abort closes the dialog cleanly; pi's own escape works.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";

const DEBUG = process.env.PI_CAS_DEBUG === "1";

/**
 * Targeted timing diagnostic — see the matching constant in
 * `event-bridge.ts`.  Same `T0` (process start) so log timestamps line up
 * across modules.  Enable with PI_CAS_SEGMENT_TIMING=1.
 */
const TIMING_DEBUG = process.env.PI_CAS_SEGMENT_TIMING === "1";
const TIMING_T0 = Date.now();
function tlog(msg: string): void {
  if (!TIMING_DEBUG) return;
  const t = String(Date.now() - TIMING_T0).padStart(7);
  console.error(`[pi-cas/timing][askuser] +${t}ms ${msg}`);
}
function truncateForLog(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}...` : s;
}

/* ----------------------------- types ----------------------------- */

/**
 * A single question, mirroring the SDK's AskUserQuestion input schema.
 *
 * The SDK validates shape upstream of canUseTool, so we don't strictly need
 * runtime validation here — but the dialog is defensive about each field
 * (missing options, empty labels, etc.) to avoid hard-crashing the UI.
 */
export interface AskQuestion {
  question: string;
  header?: string;
  options: Array<{ label: string; description?: string; preview?: string }>;
  multiSelect?: boolean;
}

/** Per-question answer payload accepted by the SDK's call(). */
export type AskUserAnswers = Record<string, string>;

/**
 * Result of `askUserQuestionDialog`:
 *  - `answered`: user picked options for every question
 *  - `cancelled`: user pressed Esc on any question OR signal aborted OR
 *                  no UI available; SDK should return a deny.
 */
export type AskUserResult =
  | { kind: "answered"; answers: AskUserAnswers }
  | { kind: "cancelled"; reason: string };

/* ----------------------------- public API ----------------------------- */

/**
 * Render one or more questions and collect the user's answers.
 *
 * Iterates one question at a time (modal overlay per question).  Returns
 * `cancelled` on first Esc / abort; subsequent questions are skipped.
 */
export async function askUserQuestionDialog(
  input: { questions?: AskQuestion[] } | undefined,
  ctx: ExtensionContext,
  signal: AbortSignal,
): Promise<AskUserResult> {
  if (!ctx.hasUI) {
    return { kind: "cancelled", reason: "no-ui-available" };
  }
  const questions = Array.isArray(input?.questions) ? input.questions : [];
  if (questions.length === 0) {
    // Nothing to ask; treat as a successful no-op (SDK will format an
    // empty `User has answered your questions:` result).
    return { kind: "answered", answers: {} };
  }
  if (signal.aborted) {
    return { kind: "cancelled", reason: "aborted-before-start" };
  }

  const answers: AskUserAnswers = {};
  for (let i = 0; i < questions.length; i++) {
    if (signal.aborted) return { kind: "cancelled", reason: "aborted" };
    const q = questions[i];
    if (!q || typeof q.question !== "string" || !Array.isArray(q.options) || q.options.length === 0) {
      // Malformed question entry; the SDK should have validated this,
      // but be defensive — skip it rather than crash the dialog.
      if (DEBUG) {
        console.error(
          `[pi-cas/debug] askUserQuestionDialog: skipping malformed question #${i + 1}: ${JSON.stringify(q).slice(0, 200)}`,
        );
      }
      continue;
    }
    tlog(`opening question ${i + 1}/${questions.length}: ${truncateForLog(q.question, 60)}`);
    const answer = await singleQuestionDialog(q, i + 1, questions.length, ctx, signal);
    tlog(`question ${i + 1}/${questions.length} resolved answer=${answer === null ? "null(cancel)" : truncateForLog(answer, 60)}`);
    if (answer === null) return { kind: "cancelled", reason: "user-cancelled" };
    answers[q.question] = answer;
  }
  return { kind: "answered", answers };
}

/* ----------------------------- internal: one-question dialog ----------------------------- */

/**
 * Render one question and return the user's selection as a single string.
 *
 * For multi-select: returns a comma-joined list of selected option labels
 * (matches the SDK's documented format: "multi-select answers are
 * comma-separated").  Returns `null` on cancel / abort.
 */
async function singleQuestionDialog(
  q: AskQuestion,
  index: number,
  total: number,
  ctx: ExtensionContext,
  signal: AbortSignal,
): Promise<string | null> {
  return ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
    let cursorIndex = 0;
    const selected = new Set<number>();
    const multi = q.multiSelect === true;
    let finished = false;

    function finish(result: string | null) {
      if (finished) return;
      finished = true;
      try {
        signal.removeEventListener("abort", onAbort);
      } catch {
        /* ignore */
      }
      done(result);
    }

    const onAbort = () => finish(null);
    if (signal.aborted) {
      // We need to defer slightly so `done` is callable; queueMicrotask
      // is the cheapest way to escape the synchronous factory body.
      queueMicrotask(() => finish(null));
    } else {
      signal.addEventListener("abort", onAbort, { once: true });
    }

    function refresh() {
      tui.requestRender();
    }

    let firstRenderSeen = false;
    let firstInputSeen = false;

    function moveCursor(delta: number) {
      const next = cursorIndex + delta;
      if (next < 0 || next >= q.options.length) return;
      cursorIndex = next;
      refresh();
    }

    function submit() {
      if (multi) {
        // If user pressed Enter with nothing checked, treat the cursor's
        // option as the implicit selection (single-pick fallback).  This
        // is what most TUI multi-select pickers do; without it the user
        // has to do Space-then-Enter for a 1-of-N pick.
        const indices =
          selected.size > 0 ? [...selected].sort((a, b) => a - b) : [cursorIndex];
        const labels = indices.map((i) => q.options[i]?.label ?? "").filter((s) => s.length > 0);
        finish(labels.length > 0 ? labels.join(", ") : null);
      } else {
        const label = q.options[cursorIndex]?.label ?? "";
        finish(label || null);
      }
    }

    function toggleAtCursor() {
      if (!multi) return;
      if (selected.has(cursorIndex)) selected.delete(cursorIndex);
      else selected.add(cursorIndex);
      refresh();
    }

    function handleInput(data: string) {
      if (!firstInputSeen) {
        firstInputSeen = true;
        tlog(`first keystroke received for question ${index}/${total}`);
      }
      if (matchesKey(data, Key.up)) return moveCursor(-1);
      if (matchesKey(data, Key.down)) return moveCursor(1);
      if (matchesKey(data, Key.enter)) return submit();
      if (matchesKey(data, Key.escape)) return finish(null);
      // Space toggles in multi-select mode.
      // (Key.space isn't exported by pi-tui; check raw " ").
      if (multi && data === " ") return toggleAtCursor();
      // Number-key shortcuts: 1..9 toggle / select option N.
      if (data.length === 1 && data >= "1" && data <= "9") {
        const target = Number(data) - 1;
        if (target < q.options.length) {
          cursorIndex = target;
          if (multi) toggleAtCursor();
          else submit();
        }
      }
    }

    function render(width: number): string[] {
      if (!firstRenderSeen) {
        firstRenderSeen = true;
        tlog(`overlay first render  question ${index}/${total} width=${width}`);
      }
      const lines: string[] = [];
      const add = (s: string) => lines.push(truncateToWidth(s, width));

      add(theme.fg("borderAccent", "─".repeat(width)));
      const headerPrefix = q.header ? `[${q.header}] · ` : "";
      add(theme.fg("muted", ` ${headerPrefix}Question ${index} of ${total}`));
      add(theme.fg("text", ` ${q.question}`));
      lines.push("");

      for (let i = 0; i < q.options.length; i++) {
        const opt = q.options[i];
        const isCursor = i === cursorIndex;
        const isChecked = multi ? selected.has(i) : isCursor;
        const cursor = isCursor ? theme.fg("accent", "> ") : "  ";
        const marker = multi
          ? isChecked
            ? theme.fg("success", "[x]")
            : theme.fg("dim", "[ ]")
          : isChecked
            ? theme.fg("success", "(•)")
            : theme.fg("dim", "( )");
        const label = isCursor
          ? theme.fg("accent", opt?.label ?? "(no label)")
          : theme.fg("text", opt?.label ?? "(no label)");
        const numberHint = i < 9 ? theme.fg("dim", ` ${i + 1}. `) : "    ";
        add(`${cursor}${marker}${numberHint}${label}`);
        if (opt?.description) {
          add(`      ${theme.fg("muted", opt.description)}`);
        }
      }

      lines.push("");
      const hint = multi
        ? "↑↓ navigate · space toggle · 1-9 quick-toggle · enter submit · esc cancel"
        : "↑↓ navigate · 1-9 quick-pick · enter submit · esc cancel";
      add(theme.fg("dim", ` ${hint}`));
      add(theme.fg("borderAccent", "─".repeat(width)));

      return lines;
    }

    return {
      render,
      invalidate: () => {
        // We don't cache lines, so nothing to invalidate per render.
      },
      handleInput,
    };
  });
}

/* ----------------------------- dispatcher ----------------------------- */

/**
 * Names of SDK tools that we know are "ask-the-user" tools (their
 * `checkPermissions()` always returns `{behavior: "ask"}`).  For these,
 * pi-cas's canUseTool handler renders a UI; for everything else we
 * default-allow (see `handleCanUseTool`).
 */
export const INTERACTIVE_TOOL_NAMES_WE_HOST: ReadonlySet<string> = new Set([
  "AskUserQuestion",
]);

/**
 * Top-level dispatcher invoked by the SDK's canUseTool hook.  Returns a
 * `PermissionResult` shape (allow / deny).
 *
 * Behaviour:
 *  - `AskUserQuestion`: render the question dialog, return allow with
 *    answers in `updatedInput`, or deny with "User declined..." message.
 *  - Anything else: allow with the original input.  See module docstring
 *    "Limitations" — we don't currently render a generic permission UI
 *    for SDK-internal prompts (dangerous Bash, write outside cwd, etc.).
 *    Users who need that should set `permissionMode` appropriately so the
 *    SDK doesn't ask in the first place.
 */
export async function handleCanUseTool(
  toolName: string,
  input: Record<string, unknown>,
  opts: {
    signal: AbortSignal;
    toolUseID: string;
  },
  getCtx: () => ExtensionContext | undefined,
): Promise<
  | { behavior: "allow"; updatedInput?: Record<string, unknown> }
  | { behavior: "deny"; message: string; interrupt?: boolean }
> {
  if (toolName === "AskUserQuestion") {
    const ctx = getCtx();
    {
      const qs = (input as { questions?: AskQuestion[] })?.questions;
      const count = Array.isArray(qs) ? qs.length : 0;
      tlog(`canUseTool entered    toolUseID=${opts.toolUseID.slice(-8)} questions=${count}`);
    }
    if (!ctx) {
      // We have no ctx — neither session_start nor turn_start has fired
      // yet.  Should be rare; in practice an AskUserQuestion mid-session
      // always has a prior turn_start.  Fall back to deny so the model
      // sees a clean failure instead of hanging.
      if (DEBUG) {
        console.error(
          `[pi-cas/debug] canUseTool(${toolName}): no captured ctx; denying`,
        );
      }
      return {
        behavior: "deny",
        message: "User declined to answer questions (pi-cas: no UI context captured)",
      };
    }
    if (DEBUG) {
      const qs = input?.questions;
      const count = Array.isArray(qs) ? qs.length : 0;
      console.error(
        `[pi-cas/debug] canUseTool(AskUserQuestion): rendering dialog ` +
          `(${count} question${count === 1 ? "" : "s"}, hasUI=${ctx.hasUI})`,
      );
    }
    tlog(`dispatching to dialog toolUseID=${opts.toolUseID.slice(-8)}`);
    const result = await askUserQuestionDialog(
      input as { questions?: AskQuestion[] },
      ctx,
      opts.signal,
    );
    tlog(`dialog returned       toolUseID=${opts.toolUseID.slice(-8)} kind=${result.kind}`);
    if (result.kind === "cancelled") {
      if (DEBUG) {
        console.error(`[pi-cas/debug] canUseTool(AskUserQuestion): cancelled (${result.reason})`);
      }
      return {
        behavior: "deny",
        message: "User declined to answer questions",
      };
    }
    if (DEBUG) {
      console.error(
        `[pi-cas/debug] canUseTool(AskUserQuestion): answered ` +
          `(${Object.keys(result.answers).length} answers)`,
      );
    }
    return {
      behavior: "allow",
      updatedInput: { ...input, answers: result.answers },
    };
  }

  // Default: allow.  See "Limitations" in module docstring for the
  // implications.
  return { behavior: "allow", updatedInput: input };
}
