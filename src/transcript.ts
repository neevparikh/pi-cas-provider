/**
 * Convert pi's conversation history into a Claude Code transcript JSONL.
 *
 * The output entries match the on-disk format used by Claude Code at
 * `~/.claude/projects/<projectKey>/<sessionId>.jsonl`. They are returned to the
 * SDK via `SessionStore.load()`, which materializes them to a temp file the
 * subprocess resumes from. No flattening, no labelled-text hack — the model
 * sees a real conversation with real tool_use / tool_result pairings.
 *
 * Splitting rule
 * --------------
 *   transcript  = messages strictly before the new user-side turn
 *   prompt      = the new user-side turn that triggered this streamSimple call
 *
 * "User-side" means a contiguous trailing run of UserMessage and/or
 * ToolResultMessage entries — pi calls streamSimple either because the user
 * typed something or because pi just executed tools and needs the model to
 * continue. In both cases the trailing items become the new prompt.
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
 */
export function piToTranscript(
  messages: readonly PiMessage[],
  opts: BuildTranscriptOpts,
): BuildTranscriptResult {
  // Where does the trailing "new user turn" begin? It's the index just after
  // the last assistant message. If there is no assistant message yet, the
  // trailing run is the entire history (and the transcript is empty).
  let lastAssistantIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "assistant") {
      lastAssistantIdx = i;
      break;
    }
  }
  const historic = messages.slice(0, lastAssistantIdx + 1);
  const trailing = messages.slice(lastAssistantIdx + 1);

  const newUserContent = buildNewUserContent(trailing);
  const transcript = buildHistoricEntries(historic, opts);
  return { transcript, newUserContent };
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

/**
 * Defang pi's compaction-summary framing so Opus doesn't interpret it as a
 * Claude Code session-resume signal.
 *
 * Background
 * ----------
 * Pi's `/compact` replaces conversation history with a single message whose
 * text starts with this exact prefix (defined in pi's core/messages.ts):
 *
 *   "The conversation history before this point was compacted into the
 *    following summary:\n\n<summary>\n...\n</summary>"
 *
 * Claude Code uses the *same* phrasing for its own auto-compaction, and Opus
 * (especially in Claude Code mode, which pi-cas opts into via beta headers)
 * has clearly learned to recognize the pattern: when it sees a first user
 * message of this shape, it acts like a resumed session and starts replies
 * with "Picking back up…" / "Picking up where we left off…" boilerplate.
 *
 * Empirically observed in /tmp/pi-cas-http-pirouette.jsonl (May 2026): 1300+
 * message conversations whose first user message had the compaction prefix
 * consistently produced "Picking up…" assistant prefixes.
 *
 * Fix
 * ---
 * Replace the prefix + `<summary>` tag with neutral framing. We keep the
 * summary content (it's genuinely useful context) but strip the resume-flavor
 * wording and the specific tag name Opus seems to key off of.
 *
 * We do NOT touch other providers' rendering of this message — only pi-cas's
 * Anthropic wire format — because the resume-flavor recognition is
 * Claude-specific.
 */
const COMPACTION_PREFIX_RE =
  /^The conversation history before this point was compacted into the following summary:\n\n<summary>\n/;
const COMPACTION_SUFFIX_RE = /\n<\/summary>\s*$/;
const NEUTRAL_PREFIX = "[Earlier context in this conversation, summarized below.]\n\n";
const NEUTRAL_SUFFIX = "";

export function defangCompactionPrefix(text: string): string {
  if (!COMPACTION_PREFIX_RE.test(text)) return text;
  // Replace opening tag + framing…
  let out = text.replace(COMPACTION_PREFIX_RE, NEUTRAL_PREFIX);
  // …and the closing </summary> if present. Tolerate trailing whitespace.
  out = out.replace(COMPACTION_SUFFIX_RE, NEUTRAL_SUFFIX);
  return out;
}

/** Pi user/text content → Anthropic blocks. Used for user messages.
 *  Empty text blocks are dropped — Anthropic API rejects them.
 *  Compaction-prefix wording is rewritten via `defangCompactionPrefix`. */
export function piContentToAnthropicBlocks(content: PiContent): AnthropicContentBlock[] {
  if (typeof content === "string") {
    const t = defangCompactionPrefix(content);
    return t.length > 0 ? [{ type: "text", text: t }] : [];
  }
  if (!Array.isArray(content)) return [];
  const blocks: AnthropicContentBlock[] = [];
  for (const b of content) {
    if (b.type === "text") {
      const t = defangCompactionPrefix(b.text ?? "");
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
