// Probe: validate the "stub tools / stream-aligned segmentation" design.
//
// Specifically test:
//   1. Event sequence when SDK runs Bash internally.
//      Does `tool_result` (via SDKUserMessage) arrive BEFORE the next
//      assistant message_start, or interleaved?  Is there a clean boundary
//      we can break at after each pi-visible assistant message?
//
//   2. Whether the `result` event waits for ALL internal SDK work to finish,
//      including the final assistant text.
//
//   3. Whether we can identify tool_results in the SDK event stream and
//      cache them by tool_use_id (so a stub pi tool can look them up).
//
//   4. Confirm that what we see lines up with the design's requirements:
//      after `content_block_stop` for a tool_use, we MUST wait for the
//      tool_result SDKUserMessage before pushing `done` to pi — otherwise
//      pi's stub tool's `execute()` runs and finds no cached result.
//
// Usage:
//   ANTHROPIC_API_KEY=... node /tmp/pi-cas-probe-stub-tools.mjs

import { query } from "@anthropic-ai/claude-agent-sdk";

// Use the user's real ~/.claude so we don't have to set up auth ourselves.

const startTime = Date.now();
const log = (kind, info) => {
  const t = String(Date.now() - startTime).padStart(6);
  console.error(`[${t}ms] ${kind.padEnd(28)} ${info ?? ""}`);
};

const events = [];

async function* prompt() {
  yield {
    type: "user",
    message: {
      role: "user",
      content: "Run the bash command `echo hello-from-bash` and tell me what it printed back. Then run `echo second` and tell me what THAT printed.",
    },
    parent_tool_use_id: null,
  };
  // Keep the iterator alive so the SDK doesn't think we're done sending input.
  // We'll signal completion by letting the iterator close from outside.
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

let lastAssistantMessageHadToolUse = false;
let assistantMessageCount = 0;
let toolUseIds = [];
const toolResultsByToolUseId = new Map();

for await (const msg of q) {
  const t = Date.now() - startTime;
  events.push({ t, msg });

  if (msg.type === "system" && msg.subtype === "init") {
    log("system.init", `session_id=${msg.session_id?.slice(0, 8)}...`);
    continue;
  }

  if (msg.type === "stream_event") {
    const e = msg.event;
    if (e.type === "message_start") {
      assistantMessageCount += 1;
      log("stream.message_start", `(assistant #${assistantMessageCount})`);
    } else if (e.type === "content_block_start") {
      const cb = e.content_block;
      if (cb.type === "tool_use") {
        toolUseIds.push(cb.id);
        log("stream.cbs(tool_use)", `name=${cb.name} id=${cb.id.slice(-8)}`);
        lastAssistantMessageHadToolUse = true;
      } else {
        log("stream.cbs", `${cb.type}`);
      }
    } else if (e.type === "content_block_delta") {
      // Skip — too noisy
    } else if (e.type === "content_block_stop") {
      log("stream.cb_stop", `index=${e.index}`);
    } else if (e.type === "message_delta") {
      log("stream.message_delta", `stop=${e.delta?.stop_reason}`);
    } else if (e.type === "message_stop") {
      log("stream.message_stop", `(assistant #${assistantMessageCount} done; had_tool_use=${lastAssistantMessageHadToolUse})`);
      lastAssistantMessageHadToolUse = false;
    } else {
      log("stream." + e.type, JSON.stringify(e).slice(0, 80));
    }
    continue;
  }

  if (msg.type === "assistant") {
    // Final whole-assistant-message event.
    const contentSummary = msg.message?.content?.map((b) => {
      if (b.type === "text") return `text(${b.text?.length}b)`;
      if (b.type === "tool_use") return `tool_use(${b.name}, id=${b.id.slice(-8)})`;
      return b.type;
    }).join(",");
    log("assistant (final)", contentSummary);
    continue;
  }

  if (msg.type === "user") {
    // After SDK runs a tool, it sends back a user message with tool_result.
    const c = msg.message?.content;
    if (Array.isArray(c)) {
      for (const block of c) {
        if (block.type === "tool_result") {
          toolResultsByToolUseId.set(block.tool_use_id, block);
          const preview = typeof block.content === "string"
            ? block.content.slice(0, 60).replace(/\n/g, "\\n")
            : JSON.stringify(block.content).slice(0, 60);
          log("user(tool_result)", `id=${block.tool_use_id.slice(-8)} is_error=${block.is_error ?? false} content=${preview}`);
        } else {
          log("user(other)", block.type);
        }
      }
    } else {
      log("user(string)", String(c).slice(0, 60));
    }
    if (msg.tool_use_result !== undefined) {
      log("user.tool_use_result", JSON.stringify(msg.tool_use_result).slice(0, 80));
    }
    continue;
  }

  if (msg.type === "result") {
    log("result", `subtype=${msg.subtype} cost=$${msg.total_cost_usd?.toFixed(4)}`);
    break;
  }

  log(msg.type, JSON.stringify(msg).slice(0, 80));
}

// Stop the SDK's iterator cleanly.
try { await q.interrupt(); } catch {}

console.error("\n=== ANALYSIS ===\n");

// 1. For each tool_use id, find: when did content_block_stop arrive vs when did the matching tool_result arrive vs when did the next message_start arrive?
//
// Walk through events and for each tool_use_id record:
//    t_cb_stop:       timestamp of content_block_stop for the tool_use block
//    t_tool_result:   timestamp of the user(tool_result) for that id
//    t_next_msg:      timestamp of the next stream message_start after that

const timings = new Map();  // tool_use_id -> { t_cb_start, t_cb_stop, t_tool_result, t_next_msg }
{
  let pendingToolUseIds = []; // tool_use_ids whose cb_stop is awaiting tool_result and next_msg
  for (let i = 0; i < events.length; i++) {
    const { t, msg } = events[i];
    if (msg.type === "stream_event") {
      const e = msg.event;
      if (e.type === "content_block_start" && e.content_block?.type === "tool_use") {
        const id = e.content_block.id;
        timings.set(id, { name: e.content_block.name, t_cb_start: t });
        pendingToolUseIds.push(id);
      } else if (e.type === "content_block_stop") {
        // Match against most-recently-started, but we don't have index→id easily here
        // — instead, find the most-recent tool_use whose stop we haven't recorded
        for (const id of pendingToolUseIds) {
          const rec = timings.get(id);
          if (rec && !rec.t_cb_stop) {
            // The cb_stop event's index corresponds to a content_block — we recorded
            // tool_use blocks above. There can be cb_stop for text blocks too.  We
            // need to match by index.  Look back for the tool_use cb_start with this index.
            // Simpler: only the most-recent unstopped tool_use whose index equals e.index.
          }
        }
        // (We'll do the matching after the loop using indices.)
      } else if (e.type === "message_start") {
        // mark next_msg for all pending unresolved tool_use_ids
        for (const id of pendingToolUseIds) {
          const rec = timings.get(id);
          if (rec && !rec.t_next_msg) rec.t_next_msg = t;
        }
      }
    } else if (msg.type === "user") {
      const c = msg.message?.content;
      if (Array.isArray(c)) {
        for (const block of c) {
          if (block.type === "tool_result") {
            const rec = timings.get(block.tool_use_id);
            if (rec) rec.t_tool_result = t;
          }
        }
      }
    }
  }
}

// Re-walk to fill t_cb_stop using content_block indices.
{
  const indexToToolUseId = new Map();  // content_block index → tool_use_id (within current message)
  for (const { t, msg } of events) {
    if (msg.type !== "stream_event") continue;
    const e = msg.event;
    if (e.type === "message_start") {
      indexToToolUseId.clear();
    } else if (e.type === "content_block_start" && e.content_block?.type === "tool_use") {
      indexToToolUseId.set(e.index, e.content_block.id);
    } else if (e.type === "content_block_stop") {
      const id = indexToToolUseId.get(e.index);
      if (id) {
        const rec = timings.get(id);
        if (rec) rec.t_cb_stop = t;
      }
    }
  }
}

console.error("Tool-use timing summary:");
console.error("  id (last 8)  name          cb_start  cb_stop  tool_result  next_msg  result_delay  next_msg_delay");
for (const [id, r] of timings.entries()) {
  const idShort = id.slice(-8);
  const cbStop = r.t_cb_stop ?? "?";
  const tr = r.t_tool_result ?? "?";
  const nm = r.t_next_msg ?? "?";
  const resultDelay = (r.t_tool_result != null && r.t_cb_stop != null)
    ? r.t_tool_result - r.t_cb_stop : "?";
  const nextMsgDelay = (r.t_next_msg != null && r.t_tool_result != null)
    ? r.t_next_msg - r.t_tool_result : "?";
  console.error(`  ${idShort}     ${r.name?.padEnd(12)}  ${String(r.t_cb_start).padStart(6)}    ${String(cbStop).padStart(5)}    ${String(tr).padStart(9)}    ${String(nm).padStart(6)}    ${String(resultDelay).padStart(10)}    ${String(nextMsgDelay).padStart(12)}`);
}

console.error("\nKey questions:");

// Q1: For each tool_use, did the tool_result arrive BEFORE the next message_start?
let allResultsBeforeNextMsg = true;
let allResultsAfterCbStop = true;
for (const [id, r] of timings.entries()) {
  if (r.t_tool_result == null) {
    console.error(`  WARN: no tool_result captured for ${id.slice(-8)}`);
    continue;
  }
  if (r.t_next_msg != null && r.t_tool_result > r.t_next_msg) {
    allResultsBeforeNextMsg = false;
    console.error(`  ${id.slice(-8)}: tool_result arrived AFTER next message_start (${r.t_tool_result}ms > ${r.t_next_msg}ms)`);
  }
  if (r.t_cb_stop != null && r.t_tool_result < r.t_cb_stop) {
    allResultsAfterCbStop = false;
    console.error(`  ${id.slice(-8)}: tool_result arrived BEFORE its tool_use's content_block_stop (${r.t_tool_result}ms < ${r.t_cb_stop}ms)`);
  }
}

console.error(`\n  Q: Does tool_result always arrive AFTER content_block_stop for its tool_use?`);
console.error(`     ${allResultsAfterCbStop ? "YES ✓" : "NO ✗"}`);
console.error(`\n  Q: Does tool_result always arrive BEFORE the next assistant message_start?`);
console.error(`     ${allResultsBeforeNextMsg ? "YES ✓" : "NO ✗"}`);

console.error(`\n  Implication for design:`);
if (allResultsAfterCbStop && allResultsBeforeNextMsg) {
  console.error(`    ✓ Safe boundary: push pi 'done' on user(tool_result), not on content_block_stop.`);
  console.error(`    ✓ Cache results in event-bridge from user(tool_result) before pi's stub tool runs.`);
  console.error(`    ✓ Stream-aligned segmentation is feasible.`);
} else {
  console.error(`    ✗ Timing is NOT what we assumed — design needs revision.`);
}

console.error(`\n  Total assistant messages: ${assistantMessageCount}`);
console.error(`  Total tool uses: ${toolUseIds.length}`);
console.error(`  Total tool results captured: ${toolResultsByToolUseId.size}`);

process.exit(0);
