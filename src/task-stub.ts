/**
 * Custom `Task` stub tool with rich rendering of the subagent's transcript.
 *
 * # Why
 *
 * When the main model uses the `Task` tool to delegate to a subagent, the
 * Agent SDK runs the subagent in-process and emits its inner conversation
 * (text, thinking, tool_uses, tool_results) as events with
 * `parent_tool_use_id != null`.  The bridge captures these into a
 * `SubagentTranscript` (see `src/subagent-transcript.ts`) and attaches it
 * to the parent Task tool_result's cache entry under
 * `_piCasSubagentTranscript`.
 *
 * Without this stub, pi would render the Task tool result via the default
 * generic catch-all rendering: just the SDK's final summary text.  With
 * this stub, pi renders a nested transcript modeled on `pi-subagent`'s
 * renderer (see `~/repos/pi-subagent/src/index.ts`):
 *
 *   ✓ Task (Explore)
 *   ─── Task ───
 *   Find every file that imports typebox
 *   ─── Output ───
 *   → grep import typebox
 *   → read src/foo.ts
 *   ...
 *   {final markdown answer}
 *   3 turns ↑850 ↓120 $0.0034 sonnet
 *
 * # Relationship to other stubs
 *
 * Functionally identical to {@link createGenericStub} on the execute()
 * side: looks up the SDK-cached result by tool_use_id and returns it.
 * The only difference is `renderResult` which knows how to inspect
 * `details._piCasSubagentTranscript` and lay out the nested view.
 *
 * If the model emits a `Task` call but no subagent transcript was
 * captured (e.g., the SDK changed its event shape, or the user disabled
 * `forwardSubagentText`), the renderer falls back to displaying the
 * tool_result text content like the generic stub would — nothing breaks,
 * just less detail.
 */

import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { defineTool, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";

import { executeStub } from "./stub-tools.js";
import type { SubagentTranscript } from "./subagent-transcript.js";

/**
 * Name of the SDK's Agent / subagent tool as emitted in tool_use blocks.
 * Exported so the provider can pre-register this stub (instead of leaving
 * Task to the dynamic catch-all path).
 */
export const TASK_TOOL_NAME = "Task";

/** Build the Task tool stub. */
export function createTaskStub(): ToolDefinition {
  return defineTool({
    name: TASK_TOOL_NAME,
    label: "Task (subagent)",
    description:
      "Delegate to a Claude Code subagent. Executed by the Agent SDK; " +
      "pi-cas renders the captured subagent transcript (reasoning, tool " +
      "calls, final output) in the result view.",
    parameters: Type.Object(
      {
        description: Type.Optional(Type.String()),
        prompt: Type.Optional(Type.String()),
        subagent_type: Type.Optional(Type.String()),
      },
      { additionalProperties: true },
    ),
    executionMode: "sequential",
    prepareArguments: (args) => (args ?? {}) as any,
    async execute(toolCallId) {
      return executeStub("Task", toolCallId);
    },

    renderCall(args, theme) {
      // Inspired by pi-subagent's renderCall: bold "subagent" + agent
      // type, then a dim preview of the task description / prompt.
      const subType = (args as any).subagent_type ?? "default";
      const description = (args as any).description ?? "";
      const prompt = (args as any).prompt ?? "";
      const preview = description || prompt || "(no description)";
      const truncated = preview.length > 80 ? `${preview.slice(0, 80)}...` : preview;
      const header =
        theme.fg("toolTitle", theme.bold("Task ")) + theme.fg("accent", String(subType));
      const body = "\n  " + theme.fg("dim", truncated);
      return new Text(header + body, 0, 0);
    },

    renderResult(result, { expanded }, theme) {
      const details = (result.details as Record<string, unknown> | undefined) ?? {};
      const transcript = details._piCasSubagentTranscript as
        | SubagentTranscript
        | undefined;
      const isError =
        Boolean((details as any)._piCasIsError) ||
        transcript?.finalStatus === "failed" ||
        transcript?.finalStatus === "stopped";

      // Fallback path: no transcript captured (forwardSubagentText off,
      // SDK didn't emit subagent events for some reason, or the catch-all
      // generic stub was used instead).  Render the tool_result content
      // as plain text so the user still sees the SDK's summary.
      if (!transcript) {
        const text =
          result.content
            .filter((c) => c.type === "text")
            .map((c) => (c as any).text)
            .join("\n") || "(no output)";
        return new Text(formatPlainFallback(text, isError, theme), 0, 0);
      }

      const icon = isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
      const title =
        icon +
        " " +
        theme.fg("toolTitle", theme.bold("Task ")) +
        theme.fg("accent", transcript.subagentType ?? "default") +
        (transcript.finalStatus ? theme.fg("muted", ` [${transcript.finalStatus}]`) : "");

      const displayItems = collectDisplayItems(transcript);
      const finalOutput = extractFinalText(transcript);

      if (expanded) {
        const container = new Container();
        container.addChild(new Text(title, 0, 0));
        if (transcript.taskPrompt || transcript.description) {
          container.addChild(new Spacer(1));
          container.addChild(new Text(theme.fg("muted", "─── Task ───"), 0, 0));
          container.addChild(
            new Text(theme.fg("dim", transcript.description ?? transcript.taskPrompt ?? ""), 0, 0),
          );
        }
        container.addChild(new Spacer(1));
        container.addChild(new Text(theme.fg("muted", "─── Output ───"), 0, 0));
        if (displayItems.length === 0 && !finalOutput) {
          container.addChild(new Text(theme.fg("muted", "(no output)"), 0, 0));
        } else {
          for (const item of displayItems) {
            container.addChild(new Text(renderDisplayItem(item, theme), 0, 0));
          }
          if (finalOutput) {
            container.addChild(new Spacer(1));
            container.addChild(new Markdown(finalOutput.trim(), 0, 0, getMarkdownTheme()));
          }
        }
        const usageStr = formatUsageStats(transcript);
        if (usageStr) {
          container.addChild(new Spacer(1));
          container.addChild(new Text(theme.fg("dim", usageStr), 0, 0));
        }
        return container;
      }

      // Collapsed view: keep it compact.  Show title + last few display
      // items + usage.
      const COLLAPSED_ITEMS = 10;
      let text = title;
      if (transcript.description) {
        text += `\n${theme.fg("dim", "  " + transcript.description)}`;
      }
      if (displayItems.length === 0) {
        const fallbackLine = transcript.progressSummary
          ? theme.fg("dim", transcript.progressSummary)
          : theme.fg("muted", "(running...)");
        text += `\n  ${fallbackLine}`;
      } else {
        const toShow = displayItems.slice(-COLLAPSED_ITEMS);
        const skipped = displayItems.length - toShow.length;
        if (skipped > 0) text += `\n  ${theme.fg("muted", `... ${skipped} earlier items`)}`;
        for (const item of toShow) {
          text += `\n  ${renderDisplayItem(item, theme)}`;
        }
        if (displayItems.length > COLLAPSED_ITEMS) {
          text += `\n  ${theme.fg("muted", "(Ctrl+O to expand)")}`;
        }
      }
      const usageStr = formatUsageStats(transcript);
      if (usageStr) text += `\n${theme.fg("dim", usageStr)}`;
      return new Text(text, 0, 0);
    },
  });
}

/* ----------------------------- helpers ----------------------------- */

type DisplayItem =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "toolCall"; name: string; args: Record<string, unknown> };

function collectDisplayItems(t: SubagentTranscript): DisplayItem[] {
  const items: DisplayItem[] = [];
  for (const m of t.messages) {
    if (m.role !== "assistant") continue;
    for (const part of m.content) {
      if (part.type === "text") {
        items.push({ type: "text", text: (part as any).text ?? "" });
      } else if (part.type === "thinking") {
        items.push({ type: "thinking", text: (part as any).thinking ?? "" });
      } else if (part.type === "toolCall") {
        items.push({
          type: "toolCall",
          name: (part as any).name ?? "?",
          args: ((part as any).arguments ?? {}) as Record<string, unknown>,
        });
      }
    }
  }
  return items;
}

function extractFinalText(t: SubagentTranscript): string {
  // The subagent's last assistant message is conventionally the final
  // answer.  Pull the text blocks from it.
  for (let i = t.messages.length - 1; i >= 0; i--) {
    const m = t.messages[i];
    if (m.role !== "assistant") continue;
    const text = m.content
      .filter((c) => c.type === "text")
      .map((c) => (c as any).text ?? "")
      .join("\n")
      .trim();
    if (text) return text;
  }
  // If no assistant text, fall back to the task_notification summary.
  return t.finalSummary ?? "";
}

function renderDisplayItem(
  item: DisplayItem,
  theme: { fg: (color: any, text: string) => string; bold: (text: string) => string },
): string {
  if (item.type === "text") {
    // First line only (collapsed view; expanded view shows full text via
    // the final-output Markdown block).
    const firstLine = item.text.split("\n")[0]?.trim() ?? "";
    const preview = firstLine.length > 100 ? `${firstLine.slice(0, 100)}...` : firstLine;
    return theme.fg("toolOutput", preview);
  }
  if (item.type === "thinking") {
    const firstLine = item.text.split("\n")[0]?.trim() ?? "";
    const preview = firstLine.length > 100 ? `${firstLine.slice(0, 100)}...` : firstLine;
    return theme.fg("dim", `💭 ${preview}`);
  }
  return theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme);
}

/**
 * Compact per-call formatting modeled on pi-subagent's `formatToolCall`,
 * adapted to CC's PascalCase tool names (Bash, Read, Write, Edit, Grep,
 * Glob, plus generic fallback for everything else).
 */
export function formatToolCall(
  toolName: string,
  args: Record<string, unknown>,
  theme: { fg: (color: any, text: string) => string },
): string {
  const fg = theme.fg.bind(theme);
  const home = process.env.HOME ?? "";
  const shortenPath = (p: string) =>
    home && p.startsWith(home) ? `~${p.slice(home.length)}` : p;

  switch (toolName) {
    case "Bash": {
      const command = (args.command as string) ?? "...";
      const preview = command.length > 60 ? `${command.slice(0, 60)}...` : command;
      return fg("muted", "$ ") + fg("toolOutput", preview);
    }
    case "Read": {
      const filePath = shortenPath((args.file_path as string) ?? "...");
      const offset = args.offset as number | undefined;
      const limit = args.limit as number | undefined;
      let text = fg("accent", filePath);
      if (offset !== undefined || limit !== undefined) {
        const startLine = offset ?? 1;
        const endLine = limit !== undefined ? startLine + limit - 1 : "";
        text += fg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
      }
      return fg("muted", "read ") + text;
    }
    case "Write": {
      const filePath = shortenPath((args.file_path as string) ?? "...");
      const content = (args.content as string) ?? "";
      const lines = content ? content.split("\n").length : 0;
      let text = fg("muted", "write ") + fg("accent", filePath);
      if (lines > 1) text += fg("dim", ` (${lines} lines)`);
      return text;
    }
    case "Edit": {
      const filePath = shortenPath((args.file_path as string) ?? "...");
      return fg("muted", "edit ") + fg("accent", filePath);
    }
    case "Grep": {
      const pattern = (args.pattern as string) ?? "";
      const filePath = shortenPath((args.path as string) ?? ".");
      return (
        fg("muted", "grep ") +
        fg("accent", `/${pattern}/`) +
        fg("dim", ` in ${filePath}`)
      );
    }
    case "Glob": {
      const pattern = (args.pattern as string) ?? "*";
      const filePath = shortenPath((args.path as string) ?? ".");
      return fg("muted", "glob ") + fg("accent", pattern) + fg("dim", ` in ${filePath}`);
    }
    case "Task": {
      // Nested Task call — render the same way Task renders its call.
      const subType = (args.subagent_type as string) ?? "default";
      const desc = ((args.description as string) ?? (args.prompt as string) ?? "").slice(0, 60);
      return fg("muted", "Task ") + fg("accent", subType) + fg("dim", ` ${desc}`);
    }
    default: {
      const argsStr = JSON.stringify(args ?? {});
      const preview = argsStr.length > 50 ? `${argsStr.slice(0, 50)}...` : argsStr;
      return fg("accent", toolName) + fg("dim", ` ${preview}`);
    }
  }
}

function formatTokens(count: number): string {
  if (count < 1000) return String(count);
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
  return `${(count / 1_000_000).toFixed(1)}M`;
}

function formatUsageStats(t: SubagentTranscript): string {
  const u = t.usage;
  const parts: string[] = [];
  if (u.turns) parts.push(`${u.turns} turn${u.turns > 1 ? "s" : ""}`);
  if (u.input) parts.push(`↑${formatTokens(u.input)}`);
  if (u.output) parts.push(`↓${formatTokens(u.output)}`);
  if (u.cacheRead) parts.push(`R${formatTokens(u.cacheRead)}`);
  if (u.cacheWrite) parts.push(`W${formatTokens(u.cacheWrite)}`);
  if (u.total) parts.push(`$${u.total.toFixed(4)}`);
  if (u.contextTokens && u.contextTokens > 0) parts.push(`ctx:${formatTokens(u.contextTokens)}`);
  if (t.model) parts.push(t.model);
  return parts.join(" ");
}

function formatPlainFallback(
  text: string,
  isError: boolean,
  theme: { fg: (color: any, text: string) => string; bold: (text: string) => string },
): string {
  const icon = isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
  const title = icon + " " + theme.fg("toolTitle", theme.bold("Task ")) + theme.fg("muted", "(no transcript)");
  return title + "\n" + theme.fg("toolOutput", text);
}
