// Integration probe: pi-cas's bridge end-to-end with AskUserQuestion.
//
// Wires up:
//   - SDK query
//   - pi-cas event bridge  
//   - tool-result-cache
//   - executeStub
//
// And verifies that pi can take() the AskUserQuestion result without
// hitting a cache miss.

import { query } from "@anthropic-ai/claude-agent-sdk";
import { createEventBridge } from "./src/event-bridge.ts";
import { executeStub } from "./src/stub-tools.ts";
import { has as cacheHas, size as cacheSize } from "./src/tool-result-cache.ts";

const startTime = Date.now();
const log = (kind, info) => {
  const t = String(Date.now() - startTime).padStart(6);
  console.error(`[${t}ms] ${kind.padEnd(32)} ${info ?? ""}`);
};

const fakeModel = { id: "claude-sonnet-4-5", provider: "anthropic", input: 3, cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } };

async function* prompt() {
  yield {
    type: "user",
    message: {
      role: "user",
      content: "Use the AskUserQuestion tool to ask me my favorite color: red/blue/green/yellow. Don't say anything else.",
    },
    parent_tool_use_id: null,
  };
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

const fakeStream = {
  push: (event) => {
    if (event.type === "toolcall_start") {
      const cb = event.partial?.content?.[event.contentIndex];
      log("stream.toolcall_start", `id=${cb?.id?.slice(-8)} name=${cb?.name}`);
    } else if (event.type === "done") {
      log("stream.done", `reason=${event.reason} content=${event.message?.content?.map(c => c.type).join(",")}`);
    } else if (event.type === "error") {
      log("stream.error", `reason=${event.reason}`);
    }
  },
  end: () => log("stream.end", ""),
};

const bridge = createEventBridge(fakeModel);
bridge.attachStream(fakeStream, fakeModel);

const iter = q[Symbol.asyncIterator]();

let toolCalls = [];

try {
  let iterations = 0;
  while (iterations < 1000) {
    iterations++;

    if (bridge.isSegmentReady()) {
      log("READY", `pending=0, ready to close`);
      // Capture tool use ids before closing
      const segmentToolUseIds = bridge.getCurrentSegmentToolUseIds();
      const msg = bridge.closeSegment();
      log("CLOSED", `content blocks=[${msg.content.map(c => c.type).join(",")}], stopReason=${msg.stopReason}`);
      // Find toolCalls in the closed segment
      const toolCallBlocks = msg.content.filter(c => c.type === "toolCall");
      log("toolCalls", `count=${toolCallBlocks.length}, ids=${toolCallBlocks.map(t => t.id?.slice(-8)).join(",")}`);

      // Pretend pi is running execute() on each
      for (const tc of toolCallBlocks) {
        log("BEFORE_EXEC", `id=${tc.id?.slice(-8)} cache.has=${cacheHas(tc.id)} cache.size=${cacheSize()}`);
        const result = await executeStub(tc.name, tc.id);
        const isErr = result.details?._piCasIsError;
        const textContent = result.content?.[0]?.text?.slice(0, 80);
        log("AFTER_EXEC", `id=${tc.id?.slice(-8)} isError=${isErr} text=${textContent}`);
      }

      // For our purposes: stop after the first segment containing AskUserQuestion
      if (toolCallBlocks.some(tc => tc.name === "AskUserQuestion")) {
        log("DONE", "got AskUserQuestion segment, exiting");
        process.exit(0);
      }

      // Re-attach to a new fake stream (pi would call attachStream again in next streamSimple)
      bridge.attachStream(fakeStream, fakeModel);
      continue;
    }

    if (bridge.isTurnDone()) {
      log("TURN_DONE", `error=${bridge.getTurnError()}`);
      break;
    }

    const next = await iter.next();
    if (next.done) {
      log("iter.done", "");
      break;
    }
    const msg = next.value;
    if (msg.type === "user" && Array.isArray(msg.message?.content)) {
      for (const block of msg.message.content) {
        if (block.type === "tool_result") {
          log("about_to_ingest", `id=${block.tool_use_id?.slice(-8)} is_error=${block.is_error}`);
        }
      }
    }
    bridge.handle(msg);
  }
} catch (err) {
  log("ERROR", err.message);
  process.exit(1);
}

process.exit(0);
