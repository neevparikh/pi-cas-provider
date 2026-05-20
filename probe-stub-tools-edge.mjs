// Probe 2: edge cases for stub-tools design.
//
// Validate:
//   - Parallel tool calls in one assistant message → multiple tool_use blocks,
//     all paired with tool_results before the next message_start.
//   - Tool failures (is_error=true) — SDK still emits user(tool_result) cleanly?
//   - The order of tool_result events when parallel tools complete.
//   - SDKUserMessage.tool_use_result structure (so we know what details we
//     can pass through to pi's ToolResult.details).

import { query } from "@anthropic-ai/claude-agent-sdk";

const startTime = Date.now();
const log = (kind, info) => {
  const t = String(Date.now() - startTime).padStart(6);
  console.error(`[${t}ms] ${kind.padEnd(28)} ${info ?? ""}`);
};

async function* prompt() {
  yield {
    type: "user",
    message: {
      role: "user",
      content:
        "In one turn, please call Bash twice IN PARALLEL: " +
        "(1) `echo good`, and " +
        "(2) `bash -c 'exit 7'` (a deliberate non-zero exit). " +
        "Then in a SECOND assistant turn tell me what each printed and what their exit codes were.",
    },
    parent_tool_use_id: null,
  };
  await new Promise((r) => setTimeout(r, 60_000));
}

const q = query({
  prompt: prompt(),
  options: {
    model: "claude-sonnet-4-5",
    permissionMode: "bypassPermissions",
    settingSources: [],
    includePartialMessages: true,
    cwd: "/tmp",
    env: { ...process.env },
  },
});

const events = [];

for await (const msg of q) {
  const t = Date.now() - startTime;
  events.push({ t, msg });

  if (msg.type === "system" && msg.subtype === "init") {
    log("system.init", `session_id=${msg.session_id?.slice(0, 8)}...`);
    continue;
  }
  if (msg.type === "stream_event") {
    const e = msg.event;
    if (e.type === "message_start") log("stream.message_start");
    else if (e.type === "content_block_start" && e.content_block?.type === "tool_use")
      log("stream.cbs(tool_use)", `name=${e.content_block.name} id=${e.content_block.id.slice(-8)} index=${e.index}`);
    else if (e.type === "content_block_stop") log("stream.cb_stop", `index=${e.index}`);
    else if (e.type === "message_stop") log("stream.message_stop");
    continue;
  }
  if (msg.type === "user") {
    const c = msg.message?.content;
    if (Array.isArray(c)) {
      for (const block of c) {
        if (block.type === "tool_result") {
          const preview = typeof block.content === "string"
            ? block.content.slice(0, 60).replace(/\n/g, "\\n")
            : JSON.stringify(block.content).slice(0, 60);
          log("user(tool_result)", `id=${block.tool_use_id.slice(-8)} is_error=${block.is_error ?? false} content=${preview}`);
        }
      }
    }
    if (msg.tool_use_result !== undefined) {
      log("    tool_use_result keys", Object.keys(msg.tool_use_result ?? {}).join(", "));
      log("    tool_use_result", JSON.stringify(msg.tool_use_result).slice(0, 200));
    }
    continue;
  }
  if (msg.type === "assistant") continue;
  if (msg.type === "result") {
    log("result", `subtype=${msg.subtype}`);
    break;
  }
}

try { await q.interrupt(); } catch {}
process.exit(0);
