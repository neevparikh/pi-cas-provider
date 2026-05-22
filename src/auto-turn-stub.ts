/**
 * Stub tool for rendering an absorbed "auto-triggered" turn.
 *
 * # Why this exists
 *
 * The SDK auto-runs the model in response to a `task-notification` injected
 * by various background-producing tools (Monitor stdout, backgrounded Bash
 * completion, ScheduleWakeup firing, etc.).  These auto-turns arrive in our
 * iter buffer without us pushing any prompt, and would otherwise desync
 * pi's view of the conversation (see `writeups/monitor_desync.md` or this
 * provider's commit history for the full story).
 *
 * The fix: when the event bridge detects an auto-turn during a streamSimple
 * call's consume loop, it BUFFERS the auto-turn's content (text, thinking,
 * any nested tool calls + their results) and SYNTHESIZES a tool_use block
 * for THIS stub into pi's view of the current real-response assistant
 * message.  Pi then "executes" this stub via {@link executeStub}, which
 * looks up the buffered content from the tool-result-cache.  Pi renders it
 * via {@link renderResult} below as a collapsed card, modelled on the
 * subagent transcript renderer in `task-stub.ts`.
 *
 * # Naming
 *
 * The tool name is `__pi_cas_auto_turn`.  Double-underscore prefix +
 * provider-namespaced + clearly synthetic — should be impossible to collide
 * with any real CC tool name.  Surfaced to the user in pi's UI as
 * "AutoTurn (claude-code)" via the `label`.
 *
 * # What's in the cache entry
 *
 * The same `tool-result-cache` we already use for SDK-side tools.  The
 * entry's `details` field is shaped per {@link AutoTurnDetails} — the
 * event-bridge populates it when it finishes absorbing an auto-turn.
 */

import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { defineTool, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";

import { executeStub, formatToolCall } from "./stub-tools.js";

/** Stub tool name.  Prefixed to avoid colliding with real CC tools. */
export const AUTO_TURN_TOOL_NAME = "__pi_cas_auto_turn";

/**
 * Shape of the `details` field for a cached auto-turn tool_result.  Populated
 * by `event-bridge.ts` when an auto-turn finishes; consumed by
 * {@link renderResult} below.
 */
export interface AutoTurnDetails {
  /** Whether the auto-turn ended with an error result. */
  _piCasIsError?: boolean;
  /** Always "__pi_cas_auto_turn" — same convention as other stubs. */
  _piCasToolName?: string;

  /** Optional metadata about what triggered the auto-turn.  We get this
   * when a `system.task_notification` event correlates with the auto-turn
   * (e.g. background Bash completion carries the originating tool_use_id,
   * the bash command's description, and an output_file path).  For
   * Monitor's per-stdout-line notifications no system event surfaces, so
   * `trigger` may be omitted. */
  trigger?: {
    /** Originating tool's tool_use_id (e.g. the Bash{run_in_background} call). */
    toolUseId?: string;
    /** Originating tool's name, if we resolved it from the cache. */
    toolName?: string;
    /** "completed", "failed", "stopped" — task lifecycle status. */
    status?: string;
    /** Human-readable summary from the task_notification event. */
    summary?: string;
    /** Path to the task's output file, if applicable. */
    outputFile?: string;
  };

  /** The absorbed turn's content blocks, in order.  Both assistant
   * messages emitted during the auto-turn and any tool results that fired
   * back into them, flattened. */
  blocks: AutoTurnBlock[];

  /** Token usage + cost from the auto-turn's `result` event, if captured. */
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    totalTokens?: number;
    cost?: number;
  };
}

/** A single block within an absorbed auto-turn.  Flattens assistant content
 * blocks and tool_result blocks into one ordered list for rendering. */
export type AutoTurnBlock =
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "tool_use"; id: string; name: string; arguments: Record<string, unknown> }
  | { kind: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };

/**
 * Build the AutoTurn stub.  Registered by the provider at startup.
 *
 * `execute` reuses the generic stub-tool cache lookup — when the bridge
 * synthesises this stub's tool_call, it ALSO pre-populates the cache entry
 * keyed by the synthetic tool_use_id, so the lookup succeeds.
 */
export function createAutoTurnStub(): ToolDefinition {
  return defineTool({
    name: AUTO_TURN_TOOL_NAME,
    label: "AutoTurn (claude-code)",
    description:
      "Synthesised pi-cas tool representing an autonomous turn the model " +
      "took in response to a task-notification (Monitor stdout, " +
      "backgrounded Bash completion, scheduled wakeup, etc.) while pi was " +
      "between user inputs.  Never invoked by the model directly — " +
      "pi-cas's event bridge inserts it into the assistant message so " +
      "pi's UI can render the absorbed turn as a first-class tool entry.",
    parameters: Type.Object(
      {
        // The bridge populates these into the synthesized tool_use's
        // arguments so renderCall has something to show.  Loose schema
        // because this is internal and we control both ends.
        trigger_summary: Type.Optional(Type.String()),
        trigger_tool_name: Type.Optional(Type.String()),
        block_count: Type.Optional(Type.Number()),
      },
      { additionalProperties: true },
    ),
    executionMode: "sequential",
    prepareArguments: (args) => (args ?? {}) as any,
    async execute(toolCallId) {
      // Reuse the generic cache lookup — bridge has already populated the
      // cache by the time pi's executor reaches us.
      return executeStub(AUTO_TURN_TOOL_NAME, toolCallId);
    },

    renderCall(args, theme) {
      // Compact one-line label.  Mirrors task-stub's renderCall style.
      const summary = (args as any).trigger_summary as string | undefined;
      const trigToolName = (args as any).trigger_tool_name as string | undefined;
      const blockCount = (args as any).block_count as number | undefined;

      const header =
        theme.fg("toolTitle", theme.bold("AutoTurn ")) +
        theme.fg("accent", trigToolName ?? "(notification)");
      let body = "";
      if (summary) {
        const trimmed = summary.length > 80 ? `${summary.slice(0, 80)}...` : summary;
        body += "\n  " + theme.fg("dim", trimmed);
      } else if (typeof blockCount === "number") {
        body += "\n  " + theme.fg("dim", `(${blockCount} content block${blockCount === 1 ? "" : "s"} absorbed)`);
      }
      return new Text(header + body, 0, 0);
    },

    renderResult(result, { expanded }, theme) {
      const details = (result.details as AutoTurnDetails | undefined) ?? {
        blocks: [],
      };
      const isError = Boolean(details._piCasIsError);
      const mdTheme = getMarkdownTheme();

      const icon = isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
      const triggerToolName = details.trigger?.toolName ?? "notification";
      const title =
        icon +
        " " +
        theme.fg("toolTitle", theme.bold("AutoTurn ")) +
        theme.fg("accent", triggerToolName) +
        (details.trigger?.status
          ? theme.fg("muted", ` [${details.trigger.status}]`)
          : "");

      const blocks = details.blocks ?? [];

      // For the "final answer" — same convention as task-stub: take the
      // trailing text block(s) and render them as markdown when expanded.
      const finalText = extractFinalText(blocks);

      // Display items: every block EXCEPT the trailing text that's already
      // shown as final answer.  Same pattern as task-stub's
      // collectDisplayItems / extractFinalText split.
      const displayBlocks = finalText ? blocks.slice(0, lastTextIndex(blocks)) : blocks;

      if (expanded) {
        const container = new Container();
        container.addChild(new Text(title, 0, 0));
        if (details.trigger?.summary) {
          container.addChild(new Spacer(1));
          container.addChild(new Text(theme.fg("muted", "─── Trigger ───"), 0, 0));
          container.addChild(new Text(theme.fg("dim", details.trigger.summary), 0, 0));
        }
        if (details.trigger?.outputFile) {
          container.addChild(
            new Text(theme.fg("dim", `  output: ${details.trigger.outputFile}`), 0, 0),
          );
        }
        container.addChild(new Spacer(1));
        container.addChild(new Text(theme.fg("muted", "─── Model activity ───"), 0, 0));
        if (displayBlocks.length === 0 && !finalText) {
          container.addChild(new Text(theme.fg("muted", "(no output)"), 0, 0));
        } else {
          for (const b of displayBlocks) {
            container.addChild(new Text(renderBlock(b, theme), 0, 0));
          }
          if (finalText) {
            container.addChild(new Spacer(1));
            container.addChild(new Markdown(finalText.trim(), 0, 0, mdTheme));
          }
        }
        const usageStr = formatUsage(details.usage);
        if (usageStr) {
          container.addChild(new Spacer(1));
          container.addChild(new Text(theme.fg("dim", usageStr), 0, 0));
        }
        return container;
      }

      // Collapsed view: title + trigger summary + last few items + usage.
      const COLLAPSED = 6;
      let text = title;
      if (details.trigger?.summary) {
        const trimmed =
          details.trigger.summary.length > 80
            ? `${details.trigger.summary.slice(0, 80)}...`
            : details.trigger.summary;
        text += `\n  ${theme.fg("dim", trimmed)}`;
      }
      if (displayBlocks.length === 0 && !finalText) {
        text += `\n  ${theme.fg("muted", "(no output)")}`;
      } else {
        const toShow = displayBlocks.slice(-COLLAPSED);
        const skipped = displayBlocks.length - toShow.length;
        if (skipped > 0) text += `\n  ${theme.fg("muted", `... ${skipped} earlier items`)}`;
        for (const b of toShow) {
          text += `\n  ${renderBlock(b, theme)}`;
        }
        if (finalText) {
          const firstLine = finalText.split("\n")[0]?.trim() ?? "";
          const preview = firstLine.length > 100 ? `${firstLine.slice(0, 100)}...` : firstLine;
          text += `\n  ${theme.fg("toolOutput", preview)}`;
        }
        if (displayBlocks.length > COLLAPSED) {
          text += `\n  ${theme.fg("muted", "(Ctrl+O to expand)")}`;
        }
      }
      const usageStr = formatUsage(details.usage);
      if (usageStr) text += `\n${theme.fg("dim", usageStr)}`;
      return new Text(text, 0, 0);
    },
  });
}

/* ----------------------------- rendering helpers ----------------------------- */

function renderBlock(
  b: AutoTurnBlock,
  theme: { fg: (color: any, text: string) => string; bold: (text: string) => string },
): string {
  switch (b.kind) {
    case "text": {
      const text = b.text.trim();
      const firstLine = text.split("\n")[0] ?? "";
      const preview = firstLine.length > 100 ? `${firstLine.slice(0, 100)}...` : firstLine;
      return theme.fg("toolOutput", preview);
    }
    case "thinking": {
      const text = b.text.trim();
      const firstLine = text.split("\n")[0] ?? "";
      const preview = firstLine.length > 80 ? `${firstLine.slice(0, 80)}...` : firstLine;
      return theme.fg("dim", `💭 ${preview}`);
    }
    case "tool_use": {
      return theme.fg("muted", "→ ") + formatToolCall(b.name, b.arguments, theme);
    }
    case "tool_result": {
      const text = (b.content ?? "").trim();
      const firstLine = text.split("\n")[0] ?? "";
      const preview = firstLine.length > 100 ? `${firstLine.slice(0, 100)}...` : firstLine;
      const colour = b.is_error ? "error" : "dim";
      return theme.fg(colour, `  ← ${preview}`);
    }
  }
}

/** Index of the LAST text block in `blocks` (for splitting "final answer"
 * from "intermediate items").  Returns blocks.length if no text block exists. */
function lastTextIndex(blocks: AutoTurnBlock[]): number {
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (blocks[i].kind === "text") return i;
  }
  return blocks.length;
}

function extractFinalText(blocks: AutoTurnBlock[]): string {
  // Convention: the trailing text block is the model's final response in
  // this auto-turn (it stops emitting tool_use blocks once it's "done").
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i];
    if (b.kind === "text") return b.text;
    // If we hit a tool_use / tool_result before any text, there's no
    // clean "final answer" — return empty so renderer falls back to
    // just listing the items.
    if (b.kind === "tool_use" || b.kind === "tool_result") return "";
  }
  return "";
}

function formatUsage(u: AutoTurnDetails["usage"] | undefined): string | undefined {
  if (!u) return undefined;
  const parts: string[] = [];
  if (u.totalTokens) parts.push(`${u.totalTokens.toLocaleString()} tok`);
  else if (u.input || u.output) {
    parts.push(`↑${u.input ?? 0} ↓${u.output ?? 0}`);
  }
  if (u.cost) parts.push(`$${u.cost.toFixed(4)}`);
  return parts.length > 0 ? parts.join(" ") : undefined;
}
