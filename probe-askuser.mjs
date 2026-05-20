// Probe: what events does the SDK emit when the model calls AskUserQuestion
// in subprocess mode without an answering UI host?
//
// We're trying to figure out:
//   1. Does the SDK emit a tool_result for AskUserQuestion (even an error one)?
//   2. If not, what does it emit?  (control_request? system event? nothing?)
//   3. When does the segment "close" from pi-cas's perspective?
//   4. Does message_stop fire?
//
// Usage:
//   cd ~/repos/pi-cas-provider
//   node /tmp/probe-askuser.mjs

import { query } from "@anthropic-ai/claude-agent-sdk";

const startTime = Date.now();
const log = (kind, info) => {
  const t = String(Date.now() - startTime).padStart(6);
  console.error(`[${t}ms] ${kind.padEnd(32)} ${info ?? ""}`);
};

async function* prompt() {
  yield {
    type: "user",
    message: {
      role: "user",
      content:
        "Use the AskUserQuestion tool to ask me what my favorite color is, with options red/blue/green/yellow. Just call the tool, don't say anything else.",
    },
    parent_tool_use_id: null,
  };
  // Keep iter alive
  await new Promise((r) => setTimeout(r, 120_000));
}

const q = query({
  prompt: prompt(),
  options: {
    settingSources: [],
    permissionMode: "default",
    includePartialMessages: true,
    forwardSubagentText: true,
    cwd: process.cwd(),
    tools: { type: "preset", preset: "claude_code" },
  },
});

let pendingToolUseIds = new Set();
let toolResults = new Map();
let timeout = setTimeout(() => {
  log("TIMEOUT", `pending=${[...pendingToolUseIds].map((s) => s.slice(-8)).join(",")} cached=${[...toolResults.keys()].map((s) => s.slice(-8)).join(",")}`);
  process.exit(2);
}, 90_000);

try {
  for await (const msg of q) {
    if (msg.type === "system" && msg.subtype === "init") {
      log("system.init", `session=${msg.session_id?.slice(-8)}`);
      continue;
    }
    if (msg.type === "system") {
      log(`system.${msg.subtype}`, JSON.stringify(msg).slice(0, 200));
      continue;
    }
    if (msg.type === "stream_event") {
      const e = msg.event;
      if (e.type === "message_start") {
        log("stream.message_start", "");
      } else if (e.type === "content_block_start") {
        const cb = e.content_block;
        if (cb.type === "tool_use") {
          log("stream.tool_use_start", `id=${cb.id?.slice(-8)} name=${cb.name}`);
          pendingToolUseIds.add(cb.id);
        } else if (cb.type === "text") {
          log("stream.text_start", "");
        } else if (cb.type === "thinking") {
          log("stream.thinking_start", "");
        } else {
          log("stream.cb_start", `type=${cb.type}`);
        }
      } else if (e.type === "content_block_delta") {
        const d = e.delta;
        if (d.type === "input_json_delta") {
          log("stream.input_json_delta", `idx=${e.index} partial=${JSON.stringify(d.partial_json).slice(0, 80)}`);
        }
      } else if (e.type === "content_block_stop") {
        log("stream.cb_stop", `idx=${e.index}`);
      } else if (e.type === "message_delta") {
        log("stream.msg_delta", `stop_reason=${e.delta?.stop_reason}`);
      } else if (e.type === "message_stop") {
        log("stream.message_stop", "");
      }
      continue;
    }
    if (msg.type === "assistant") {
      const blocks = msg.message?.content?.map((c) => c.type).join(",");
      log("assistant", `parent=${msg.parent_tool_use_id?.slice(-8) ?? "null"} blocks=[${blocks}]`);
      // Dump the full tool_use input for inspection.
      for (const b of msg.message?.content ?? []) {
        if (b.type === "tool_use") {
          const inputStr = JSON.stringify(b.input);
          log("assistant.tool_use_input", `name=${b.name} input_len=${inputStr.length} input_head=${inputStr.slice(0, 200)}`);
          // Print full input on its own line so we can copy it.
          console.error("FULL INPUT:", inputStr);
        }
      }
      continue;
    }
    if (msg.type === "user") {
      const c = msg.message?.content;
      if (Array.isArray(c)) {
        for (const block of c) {
          if (block.type === "tool_result") {
            const id = block.tool_use_id;
            log("user.tool_result", `id=${id?.slice(-8)} is_error=${block.is_error} content=${JSON.stringify(block.content).slice(0, 100)}`);
            pendingToolUseIds.delete(id);
            toolResults.set(id, block);
          } else {
            log("user.other", `type=${block.type}`);
          }
        }
      }
      continue;
    }
    if (msg.type === "result") {
      log("result", `subtype=${msg.subtype} is_error=${msg.is_error} stop=${msg.stop_reason ?? "?"}`);
      log("end", `pending=${[...pendingToolUseIds].map((s) => s.slice(-8)).join(",")} cached=${[...toolResults.keys()].map((s) => s.slice(-8)).join(",")}`);
      clearTimeout(timeout);
      process.exit(0);
    }
    log("other", `type=${msg.type}`);
  }
} catch (err) {
  log("ERROR", err.message);
  process.exit(1);
}
