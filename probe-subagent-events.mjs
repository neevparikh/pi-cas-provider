// Probe: capture every SDK event emitted during a subagent (Task tool) run.
//
// Companion to writeups/subagent_investigation.md.  Run this before
// shipping any subagent support to validate the open questions in that
// document:
//
//   1. Do `message_start` SSE events for parent-tool-use messages carry
//      `parent_tool_use_id` on the BetaMessage object?  (Determines whether
//      we can filter at the SSE stream level or need to buffer.)
//   2. Order of `task_started`, nested `assistant`, `task_progress`,
//      `task_notification`, parent `tool_result` events.
//   3. Whether `forwardSubagentText: false` (default) really omits subagent
//      text or just suppresses content within forwarded messages.
//
// Usage (after `npm install`):
//   export PI_CAS_BUILD=$PWD/dist-probe
//   export ANTHROPIC_API_KEY=$(security find-generic-password -s "Claude Code" -w)
//   rm -rf dist-probe && npx tsc --noEmit false --outDir dist-probe \
//     --module ESNext --moduleResolution node --target ES2022 \
//     --esModuleInterop --skipLibCheck src/*.ts
//   node probe-subagent-events.mjs
//
// Or skip the build (the probe doesn't import from dist-probe):
//   node probe-subagent-events.mjs

import { query } from "@anthropic-ai/claude-agent-sdk";
import { inspect } from "node:util";

const startTime = Date.now();
const log = (kind, info) => {
  const t = String(Date.now() - startTime).padStart(6);
  console.error(`[${t}ms] ${kind.padEnd(36)} ${info ?? ""}`);
};

const ifTruthy = (v, fmt) => (v ? ` ${fmt(v)}` : "");
const trunc = (s, n = 80) =>
  typeof s === "string" ? s.slice(0, n).replace(/\n/g, "\\n") : "";

async function* prompt() {
  yield {
    type: "user",
    message: {
      role: "user",
      content:
        "Use the Explore subagent to find the file in this repository that " +
        "defines SUPPORTED_CC_TOOL_NAMES.  Just delegate this lookup; " +
        "you don't need to do the search directly.",
    },
    parent_tool_use_id: null,
  };
  // Keep the iterator alive so the SDK keeps emitting events.
  await new Promise((r) => setTimeout(r, 120_000));
}

const q = query({
  prompt: prompt(),
  options: {
    model: "claude-sonnet-4-5",
    permissionMode: "bypassPermissions",
    settingSources: [],
    // Open the full preset so Task and subagent infrastructure are
    // available.  (An alternative is to pass an explicit list including
    // 'Task', but the preset gives us a representative environment.)
    tools: { type: "preset", preset: "claude_code" },
    includePartialMessages: true,
    // Open question #3 from the investigation doc: try both values in
    // separate runs.  Default is false; set to true to see whether the
    // subagent's internal text/thinking is forwarded.
    forwardSubagentText: false,
    cwd: process.cwd(),
    env: { ...process.env },
  },
});

const events = [];

for await (const msg of q) {
  const t = Date.now() - startTime;
  events.push({ t, msg });

  // Common metadata visible on most message types.
  const meta = [
    ifTruthy(msg.parent_tool_use_id, (v) => `parent_tool_use_id=${v.slice(-8)}`),
    ifTruthy(msg.subagent_type, (v) => `subagent_type=${v}`),
    ifTruthy(msg.task_description, (v) => `task=${JSON.stringify(v).slice(0, 60)}`),
  ].join("");

  if (msg.type === "system") {
    if (msg.subtype === "init") {
      log("system.init", `session_id=${msg.session_id?.slice(0, 8)}...${meta}`);
    } else if (msg.subtype === "task_started") {
      log(
        "system.task_started",
        `task_id=${msg.task_id?.slice(-8)} tu=${msg.tool_use_id?.slice(-8) ?? "?"} ` +
          `type=${msg.subagent_type ?? msg.task_type ?? "?"} ` +
          `prompt=${trunc(msg.prompt, 60)} skip_transcript=${msg.skip_transcript ?? false}`,
      );
    } else if (msg.subtype === "task_progress") {
      log(
        "system.task_progress",
        `task_id=${msg.task_id?.slice(-8)} tools=${msg.usage?.tool_uses} ` +
          `last=${msg.last_tool_name ?? "?"} summary=${trunc(msg.summary, 40)}`,
      );
    } else if (msg.subtype === "task_notification") {
      log(
        "system.task_notification",
        `task_id=${msg.task_id?.slice(-8)} status=${msg.status} ` +
          `summary=${trunc(msg.summary, 60)}`,
      );
    } else if (msg.subtype === "task_updated") {
      log("system.task_updated", `task_id=${msg.task_id?.slice(-8)} patch=${JSON.stringify(msg.patch)}`);
    } else if (msg.subtype === "compact_boundary") {
      log("system.compact_boundary", `trigger=${msg.compact_metadata?.trigger}`);
    } else {
      log(`system.${msg.subtype ?? "?"}`, meta);
    }
    continue;
  }

  if (msg.type === "tool_progress") {
    log(
      "tool_progress",
      `tu=${msg.tool_use_id?.slice(-8)} name=${msg.tool_name} ` +
        `parent=${msg.parent_tool_use_id?.slice(-8) ?? "null"} ` +
        `task_id=${msg.task_id?.slice(-8) ?? "?"} elapsed=${msg.elapsed_time_seconds}s`,
    );
    continue;
  }

  if (msg.type === "stream_event") {
    const e = msg.event;
    if (e.type === "message_start") {
      // Critical for the investigation: does message_start expose
      // parent_tool_use_id on the BetaMessage object?
      const innerParent = e.message?.parent_tool_use_id;
      log(
        "stream.message_start",
        `inner.parent_tool_use_id=${innerParent ?? "absent"} ` +
          `inner.role=${e.message?.role}`,
      );
    } else if (e.type === "content_block_start") {
      const cb = e.content_block;
      log(
        "stream.cbs",
        cb.type === "tool_use"
          ? `tool_use name=${cb.name} id=${cb.id.slice(-8)}`
          : cb.type,
      );
    } else if (e.type === "content_block_delta") {
      // Skip — too noisy.
    } else if (e.type === "content_block_stop") {
      // log("stream.cb_stop", `index=${e.index}`); // also noisy
    } else if (e.type === "message_delta") {
      log("stream.message_delta", `stop=${e.delta?.stop_reason}`);
    } else if (e.type === "message_stop") {
      log("stream.message_stop");
    } else {
      log(`stream.${e.type}`, "");
    }
    continue;
  }

  if (msg.type === "assistant") {
    const contentSummary = msg.message?.content
      ?.map((b) => {
        if (b.type === "text") return `text(${b.text?.length}b)`;
        if (b.type === "thinking") return `thinking(${b.thinking?.length}b)`;
        if (b.type === "tool_use") return `tool_use(${b.name}, id=${b.id.slice(-8)})`;
        return b.type;
      })
      .join(",");
    log("assistant", `${contentSummary}${meta}`);
    continue;
  }

  if (msg.type === "user") {
    const c = msg.message?.content;
    if (Array.isArray(c)) {
      for (const block of c) {
        if (block.type === "tool_result") {
          const preview =
            typeof block.content === "string"
              ? trunc(block.content, 60)
              : trunc(JSON.stringify(block.content), 60);
          log(
            "user(tool_result)",
            `id=${block.tool_use_id?.slice(-8)} is_error=${block.is_error ?? false} ` +
              `content=${preview}${meta}`,
          );
        } else {
          log("user(other)", `type=${block.type}${meta}`);
        }
      }
    } else {
      log("user(string)", `${trunc(String(c), 60)}${meta}`);
    }
    continue;
  }

  if (msg.type === "result") {
    log(
      "result",
      `subtype=${msg.subtype} is_error=${msg.is_error ?? false} ` +
        `cost=$${msg.total_cost_usd?.toFixed(4) ?? "?"}`,
    );
    break;
  }

  log(`other.${msg.type}`, trunc(JSON.stringify(msg), 80));
}

try {
  await q.interrupt();
} catch {}

console.error("\n=== SUMMARY ===\n");

const subagentEvents = events.filter(({ msg }) => {
  if (msg.parent_tool_use_id) return true;
  if (msg.type === "system" && /^task_/.test(msg.subtype ?? "")) return true;
  if (msg.type === "tool_progress" && msg.parent_tool_use_id) return true;
  return false;
});

console.error(`Total events: ${events.length}`);
console.error(`Subagent-tagged events: ${subagentEvents.length}`);
console.error(
  `Task tool_use blocks observed: ` +
    events.filter(
      ({ msg }) =>
        msg.type === "stream_event" &&
        msg.event?.type === "content_block_start" &&
        msg.event.content_block?.type === "tool_use" &&
        msg.event.content_block.name === "Task",
    ).length,
);
console.error(
  `task_started messages: ` +
    events.filter(({ msg }) => msg.type === "system" && msg.subtype === "task_started").length,
);
console.error(
  `task_notification messages: ` +
    events.filter(({ msg }) => msg.type === "system" && msg.subtype === "task_notification").length,
);

const firstNestedAssistant = events.find(
  ({ msg }) => msg.type === "assistant" && msg.parent_tool_use_id,
);
console.error(
  `First nested assistant message: ${
    firstNestedAssistant ? `t=${firstNestedAssistant.t}ms` : "(none — forwardSubagentText was probably false)"
  }`,
);

// Optional: dump the full event list as JSON for offline analysis.
if (process.env.PROBE_DUMP_PATH) {
  const fs = await import("node:fs");
  fs.writeFileSync(
    process.env.PROBE_DUMP_PATH,
    JSON.stringify(events, null, 2),
  );
  console.error(`\nFull event dump written to ${process.env.PROBE_DUMP_PATH}`);
}

console.error("\nFor full investigation context see writeups/subagent_investigation.md.");
