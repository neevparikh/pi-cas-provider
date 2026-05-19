/**
 * Convert pi's conversation history into a Claude Code transcript JSONL.
 *
 * The output entries match the on-disk format used by Claude Code at
 * `~/.claude/projects/<projectKey>/<sessionId>.jsonl`. They are returned to the
 * SDK via `SessionStore.load()`, which materializes them to a temp file the
 * subprocess resumes from. No flattening, no labelled-text hack — the model
 * sees a real conversation with real tool_use / tool_result pairings.
 *
 * Splitting rule (revised to fix "Picking up where I left off" injection)
 * ----------------------------------------------------------------------
 * Naive split would be: "everything up to last assistant in historic;
 * everything after in new prompt."  That made every tool-use turn produce a
 * disk transcript ending in `assistant(tool_use)` with the matching
 * `tool_result` only arriving over the SDK's new-prompt channel.  The bundled
 * `claude` binary's resume normalizer then
 *   1. orphan-pruned the dangling assistant (`iO6`), and
 *   2. detected the buffer as `interrupted_turn` (`Xg5`), splicing in two
 *      synthetic placeholders: `user("Continue from where you left off.")`
 *      and `assistant("No response requested.")`.
 * The model then opened replies with "Picking up where I left off…" and the
 * conversation degraded into a `(no content)` feedback loop.
 *
 * Fix: include trailing `tool_result` entries that pair with the last
 * historic assistant's `tool_use`s INSIDE the historic transcript, then
 * append a synthetic assistant marker so the disk JSONL ends in an assistant
 * message.  The new prompt then carries only genuinely-new user-side content
 * (typed text, images), often empty for tool-result-only continuation turns.
 *
 * See writeups/write_up.md for the full design and empirical validation.
 */

import { randomUUID } from "node:crypto";
import { piToClaude } from "./tool-shim.js";

// Pi types — we duplicate the shape locally to keep this file free of external
// imports at test time. (Real type comes from @earendil-works/pi-ai at runtime.)
type PiContent = string | Array<{ type: string; [k: string]: any }>;
type PiMessage =
  | { role: "user"; content: PiContent; timestamp?: number }
  | { role: "assistant"; content: Array<{ type: string; [k: string]: any }>; timestamp?: number; model?: string; usage?: any }
  | { role: "toolResult"; toolCallId: string; toolName: string; content: PiContent; isError?: boolean; timestamp?: number };

/** Shape of a single line in the JSONL transcript. */
export interface TranscriptEntry {
  parentUuid: string | null;
  isSidechain: false;
  userType: "external";
  cwd: string;
  sessionId: string;
  version: string;
  gitBranch: string;
  type: "user" | "assistant";
  message: unknown;
  uuid: string;
  timestamp: string;
}

/** Anthropic API content-block shapes used in transcript messages. */
export type AnthropicContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } }
  | { type: "thinking"; thinking: string; signature?: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: any; is_error?: boolean };

export interface BuildTranscriptResult {
  /** Entries representing history strictly before the new user-side turn. */
  transcript: TranscriptEntry[];
  /** Content the SDK should treat as the new user message for this turn. */
  newUserContent: AnthropicContentBlock[];
}

export interface BuildTranscriptOpts {
  cwd: string;
  sessionId: string;
  /** Claude Code's transcript schema version. Capture from runtime; we default. */
  version?: string;
  /** Git branch label for entries (cosmetic). */
  gitBranch?: string;
}

/**
 * Build the transcript-plus-new-prompt split from a pi messages array.
 *
 * Algorithm:
 *   1. Find the last assistant turn.
 *   2. Collect the set of `tool_use` IDs on that assistant turn (if any).
 *   3. Split trailing messages (everything after the last assistant) into:
 *      - paired tool_results (those whose `toolCallId` is in the set) → fold
 *        into the historic transcript right after the assistant
 *      - leftover (user text, unpaired tool_results) → newUserContent
 *   4. Append a synthetic assistant marker as the very last historic entry.
 *
 * The synthetic marker uses the bundled binary's own internal sentinel
 * (`model: "<synthetic>"`, text `"No response requested."`).  Various places
 * in the binary already special-case this shape (usage tracking excludes it,
 * certain filters strip it, etc.) so it plays nicely with the binary's
 * resume normalizer instead of confusing it.
 */
export function piToTranscript(
  messages: readonly PiMessage[],
  opts: BuildTranscriptOpts,
): BuildTranscriptResult {
  // Step 1: locate the last assistant turn.
  let lastAssistantIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "assistant") {
      lastAssistantIdx = i;
      break;
    }
  }

  // First-turn case: no assistant yet — transcript is empty, the entire
  // history is the new prompt.  No synthetic marker (nothing to ward off the
  // normalizer from).
  if (lastAssistantIdx === -1) {
    return {
      transcript: [],
      newUserContent: buildNewUserContent(messages),
    };
  }

  // Step 2: collect tool_use ids on the last assistant turn (the pre-shim
  // ids — pi stores them under `toolCall.id` with their original values,
  // matching tool_result.toolCallId).
  const lastAsst = messages[lastAssistantIdx];
  const unmatchedToolUseIds = new Set<string>();
  if (lastAsst.role === "assistant" && Array.isArray(lastAsst.content)) {
    for (const b of lastAsst.content) {
      if (b.type === "toolCall" && typeof b.id === "string") {
        unmatchedToolUseIds.add(b.id);
      }
    }
  }

  // Step 3: split trailing messages into (a) tool_results that pair 1:1 with
  // the last assistant's tool_uses, and (b) everything else.
  //
  // Pairing is consumed: each matched tool_use_id is removed from the set so
  // a second tool_result with the same id (defensive case — shouldn't happen
  // in normal pi flows) falls into `leftover` rather than producing a
  // duplicate `tool_result` block on disk, which the Anthropic API rejects.
  //
  // Once we encounter any non-toolResult message, or a toolResult whose id
  // doesn't match an unmatched tool_use, we stop pairing — everything else
  // is genuine new content (user text, unpaired tool_results, etc.).
  const trailing = messages.slice(lastAssistantIdx + 1);
  const pairedToolResults: PiMessage[] = [];
  const leftover: PiMessage[] = [];
  let stillPairing = unmatchedToolUseIds.size > 0;
  for (const m of trailing) {
    if (stillPairing && m.role === "toolResult" && unmatchedToolUseIds.has(m.toolCallId)) {
      pairedToolResults.push(m);
      unmatchedToolUseIds.delete(m.toolCallId); // consume the pairing
      if (unmatchedToolUseIds.size === 0) stillPairing = false;
      continue;
    }
    stillPairing = false;
    leftover.push(m);
  }

  // Step 4: build historic = [..., last_assistant_turn, paired_tool_results, synth_marker]
  const historicSourceMessages = [
    ...messages.slice(0, lastAssistantIdx + 1),
    ...pairedToolResults,
  ];
  const historicEntries = buildHistoricEntries(historicSourceMessages, opts);
  appendSynthAssistantMarker(historicEntries, opts);

  return {
    transcript: historicEntries,
    newUserContent: buildNewUserContent(leftover),
  };
}

/* ---------------------- synth-asst marker ---------------------- */

/**
 * The synthetic assistant marker that goes at the end of every non-empty
 * historic transcript.
 *
 * The exact strings here are the bundled `claude` binary's own internal
 * sentinels:
 *   - `model: "<synthetic>"`  (the binary's `jG` constant)
 *   - `text: "No response requested."`  (the binary's `TGH` constant)
 *
 * Various filters in the binary already special-case these (usage tracking
 * excludes them, certain views strip them, etc.), so our marker is
 * indistinguishable from a marker the binary itself would synthesize during
 * its own resume-recovery flow.
 *
 * Why we need this entry at the end of the transcript:
 *
 *   `gG8` (the resume normalizer) does roughly:
 *     1. iO6 — drop assistant turns whose tool_uses are ALL orphans (no
 *        matching tool_result in the buffer).  We avoid this by folding
 *        trailing paired tool_results into the historic transcript, so no
 *        assistant tool_use is orphan on disk.
 *     2. Xg5 — if the buffer's last non-system/non-progress entry is a
 *        user with content[0].type === "tool_result", classify as
 *        `interrupted_turn` and splice in `user("Continue from where you
 *        left off.")`.  We avoid this by making the last entry an assistant
 *        — our synth marker.
 *     3. Unconditional TGH splice — if the last entry is still a user,
 *        splice in `assistant("No response requested.")` after.  Our synth
 *        marker makes the last entry an assistant, so this also doesn't fire.
 */
const SYNTH_ASSISTANT_TEXT = "No response requested.";
const SYNTH_ASSISTANT_MODEL = "<synthetic>";

function appendSynthAssistantMarker(
  entries: TranscriptEntry[],
  opts: BuildTranscriptOpts,
): void {
  if (entries.length === 0) return; // No history → no marker needed.
  const last = entries[entries.length - 1];
  const ts = new Date().toISOString();
  const uuid = randomUUID();
  entries.push({
    isSidechain: false,
    userType: "external",
    cwd: opts.cwd,
    sessionId: opts.sessionId,
    version: opts.version ?? "2.1.143",
    gitBranch: opts.gitBranch ?? "",
    parentUuid: last.uuid,
    type: "assistant",
    uuid,
    timestamp: ts,
    message: {
      model: SYNTH_ASSISTANT_MODEL,
      id: `msg_${randomUUID().replace(/-/g, "")}`,
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: SYNTH_ASSISTANT_TEXT }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  });
}

/* ---------------------- new-prompt content assembly ---------------------- */

function buildNewUserContent(trailing: readonly PiMessage[]): AnthropicContentBlock[] {
  const blocks: AnthropicContentBlock[] = [];
  for (const m of trailing) {
    if (m.role === "toolResult") {
      blocks.push({
        type: "tool_result",
        tool_use_id: m.toolCallId,
        content: piContentToAnthropicForToolResult(m.content),
        is_error: m.isError ?? false,
      });
    } else if (m.role === "user") {
      blocks.push(...piContentToAnthropicBlocks(m.content));
    }
    // historic assistant messages cannot appear in `trailing` by construction
  }
  // If pi gave us *only* a string-content user message and nothing else, that
  // collapses to a single text block — but we always normalize to blocks so
  // the SDK can attach a tool_result alongside if needed.
  return blocks;
}

/* ---------------------- historic entries (transcript) ---------------------- */

function buildHistoricEntries(
  historic: readonly PiMessage[],
  opts: BuildTranscriptOpts,
): TranscriptEntry[] {
  const out: TranscriptEntry[] = [];
  let parentUuid: string | null = null;
  const base = {
    isSidechain: false as const,
    userType: "external" as const,
    cwd: opts.cwd,
    sessionId: opts.sessionId,
    version: opts.version ?? "2.1.143",
    gitBranch: opts.gitBranch ?? "",
  };

  // Anthropic-format conversations require tool_results to live inside a USER
  // message whose content is `[{type:"tool_result",...}, ...]`, immediately
  // following the assistant turn that issued the tool_use. Pi stores tool
  // results as separate ToolResultMessage entries. We merge runs of those into
  // synthetic user-role entries.
  let i = 0;
  while (i < historic.length) {
    const m = historic[i];
    const ts = m.timestamp ? new Date(m.timestamp).toISOString() : new Date().toISOString();

    if (m.role === "user") {
      const uuid = randomUUID();
      out.push({
        ...base, parentUuid, type: "user", uuid, timestamp: ts,
        message: {
          role: "user",
          content: piContentToAnthropicBlocks(m.content),
        },
      });
      parentUuid = uuid;
      i++;
      continue;
    }

    if (m.role === "assistant") {
      const uuid = randomUUID();
      out.push({
        ...base, parentUuid, type: "assistant", uuid, timestamp: ts,
        message: {
          model: (m as any).model ?? "claude-sonnet-4-5",
          id: `msg_${randomUUID().replace(/-/g, "")}`,
          type: "message",
          role: "assistant",
          content: piAssistantBlocksToAnthropic(m.content),
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      });
      parentUuid = uuid;
      i++;
      continue;
    }

    // toolResult: gather a contiguous run, emit as one user-role entry.
    if (m.role === "toolResult") {
      const run: PiMessage[] = [];
      while (i < historic.length && historic[i].role === "toolResult") {
        run.push(historic[i]);
        i++;
      }
      const uuid = randomUUID();
      out.push({
        ...base, parentUuid, type: "user", uuid, timestamp: ts,
        message: {
          role: "user",
          content: run.map((r) => ({
            type: "tool_result",
            tool_use_id: (r as any).toolCallId,
            content: piContentToAnthropicForToolResult((r as any).content),
            is_error: (r as any).isError ?? false,
          })),
        },
      });
      parentUuid = uuid;
      continue;
    }
    i++;
  }

  return out;
}

/* ---------------------- content-block translators ---------------------- */

/** Pi user/text content → Anthropic blocks. Used for user messages.
 *  Empty text blocks are dropped — Anthropic API rejects them. */
export function piContentToAnthropicBlocks(content: PiContent): AnthropicContentBlock[] {
  if (typeof content === "string") {
    return content.length > 0 ? [{ type: "text", text: content }] : [];
  }
  if (!Array.isArray(content)) return [];
  const blocks: AnthropicContentBlock[] = [];
  for (const b of content) {
    if (b.type === "text") {
      const t = b.text ?? "";
      if (t.length > 0) blocks.push({ type: "text", text: t });
    } else if (b.type === "image" && typeof b.data === "string" && typeof b.mimeType === "string") {
      blocks.push({
        type: "image",
        source: { type: "base64", media_type: b.mimeType, data: b.data },
      });
    }
    // unknown block types silently dropped
  }
  return blocks;
}

/**
 * Pi tool-result content → Anthropic tool_result `content` field.
 * The Anthropic API accepts either a string or an array of blocks. We use the
 * block form so images-in-tool-results pass through.
 */
function piContentToAnthropicForToolResult(content: PiContent): any {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const blocks: any[] = [];
  for (const b of content) {
    if (b.type === "text") blocks.push({ type: "text", text: b.text ?? "" });
    else if (b.type === "image" && typeof b.data === "string" && typeof b.mimeType === "string") {
      blocks.push({
        type: "image",
        source: { type: "base64", media_type: b.mimeType, data: b.data },
      });
    }
  }
  // Empty array is invalid for tool_result; fall back to empty string.
  return blocks.length > 0 ? blocks : "";
}

/** Pi assistant content (text/thinking/toolCall) → Anthropic content blocks.
 *
 * Two transformations beyond a straight type map:
 *
 * 1. **Thinking blocks dropped.** Anthropic API rejects thinking blocks without
 *    a valid signature, and pi cannot always preserve the signature across
 *    persistence boundaries. Historical thinking is process, not state — the
 *    model produces fresh thinking each turn.
 *
 * 2. **Trailing content after tool_use is truncated.** When canUseTool denies
 *    a tool with `interrupt: true`, the SDK still lets the model emit a final
 *    "sorry, I can't" text block. If we replay that into history, the next turn
 *    sees a contradictory assistant message: "I can't read the file" followed
 *    by a tool_result containing the file. The model then re-issues the tool
 *    call to resolve the contradiction, looping. We strip everything after the
 *    last tool_use so the assistant turn ends cleanly on its tool calls.
 */
export function piAssistantBlocksToAnthropic(
  content: Array<{ type: string; [k: string]: any }>,
): AnthropicContentBlock[] {
  if (!Array.isArray(content)) return [];

  // First pass: map blocks, dropping thinking + empty text.
  const mapped: Array<AnthropicContentBlock & { _origIdx: number }> = [];
  let lastToolUseIdx = -1;
  for (let i = 0; i < content.length; i++) {
    const b = content[i];
    if (b.type === "text") {
      const t = b.text ?? "";
      if (t.length > 0) {
        mapped.push({ type: "text", text: t, _origIdx: i } as any);
      }
    } else if (b.type === "toolCall") {
      const { name, input } = piToClaude(b.name, b.arguments ?? {});
      mapped.push({ type: "tool_use", id: b.id, name, input, _origIdx: i } as any);
      lastToolUseIdx = i;
    }
    // thinking + empty text + unknown block types silently dropped
  }

  // Second pass: if any tool_use present, drop trailing blocks past the last one.
  const filtered = lastToolUseIdx >= 0
    ? mapped.filter((b: any) => b._origIdx <= lastToolUseIdx)
    : mapped;
  const out: AnthropicContentBlock[] = filtered.map(({ _origIdx, ...rest }: any) => rest);

  // An assistant turn must have at least one block. If we filtered everything
  // out (e.g. thinking-only turn), insert a placeholder so the API doesn't 400.
  if (out.length === 0) out.push({ type: "text", text: "(empty assistant turn)" });
  return out;
}
