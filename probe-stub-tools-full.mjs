// Full end-to-end probe for stream-aligned-segmentation architecture.
//
// Drives the complete multi-segment flow that pi's agent loop would
// produce: user msg → streamSimple → done(toolUse) → run stub tools → send
// phantom toolResults → streamSimple → done(stop) with continuation text.
//
// Verifies:
//   - Each segment closes cleanly with the right stop reason
//   - Stub tools find cached results
//   - Phantom toolResult detection skips enqueueing to SDK
//   - The model's continuation text appears in segment 2
//
// Usage:
//   cd /Users/neev/repos/pi-cas-provider
//   rm -rf dist-probe && npx tsc --noEmit false --outDir dist-probe \
//     --module ESNext --moduleResolution node --target ES2022 \
//     --esModuleInterop --skipLibCheck src/*.ts
//   export ANTHROPIC_API_KEY=$(security find-generic-password -s "Claude Code" -w)
//   export PI_CAS_STATE_PATH=/tmp/pi-cas-clean-state.json
//   rm -f $PI_CAS_STATE_PATH
//   node probe-stub-tools-full.mjs

import { getModels } from "@earendil-works/pi-ai";

const PROVIDER_BUILD = process.env.PI_CAS_BUILD ?? "./dist-probe";
const provider = await import(`${PROVIDER_BUILD}/provider.js`);

const SESSION_ID = "stub-tools-probe";
const log = (...args) => console.error("[probe]", ...args);

// Stub pi.
const registeredTools = new Map();
const eventHandlersByType = new Map();
const fakePi = {
  registerProvider(_id, def) { fakePi._provider = def; },
  registerCommand() {},
  registerTool(t) { registeredTools.set(t.name, t); },
  on(event, handler) {
    const list = eventHandlersByType.get(event) ?? [];
    list.push(handler);
    eventHandlersByType.set(event, list);
  },
  events: { emit() { return []; } },
};

provider.registerProvider(fakePi);
log("registered tools:", [...registeredTools.keys()].join(", "));

const sonnet = getModels("anthropic").find((m) => m.id === "claude-sonnet-4-5");
log("model:", sonnet.id);

const piMessages = [];

async function runOneStreamSimple(label) {
  log(`\n=== ${label} (msgs=${piMessages.length}) ===`);
  const stream = fakePi._provider.streamSimple(
    sonnet,
    { messages: [...piMessages], systemPrompt: "Be concise. Use Bash when asked." },
    { sessionId: SESSION_ID, cwd: process.cwd() },
  );
  let text = "";
  const toolCalls = [];
  let done = null;
  let err = null;
  let eventCount = 0;
  for await (const ev of stream) {
    eventCount++;
    if (ev.type === "text_delta") text += ev.delta;
    else if (ev.type === "toolcall_end") {
      toolCalls.push({ id: ev.toolCall.id, name: ev.toolCall.name, args: ev.toolCall.arguments });
    } else if (ev.type === "done") done = ev;
    else if (ev.type === "error") err = ev.error;
  }
  log(`  ${eventCount} events, done.reason=${done?.reason}, toolCalls=${toolCalls.length}, text="${text.slice(0, 80).replace(/\n/g, "\\n")}"`);
  if (err) { log(`  ERROR: ${err.errorMessage}`); return { error: err }; }
  for (const tc of toolCalls) {
    log(`  tool: ${tc.name}(${JSON.stringify(tc.args).slice(0, 80)}) id=${tc.id.slice(-8)}`);
  }
  return { text, toolCalls, done };
}

// ---------- TURN 1: real user input ----------
piMessages.push({ role: "user", content: "Run `printf two` via Bash and then tell me what it printed." });
const seg1 = await runOneStreamSimple("SEGMENT 1: user → SDK runs tool → done(toolUse)");
if (seg1.error) { log("FAIL: turn 1 errored"); process.exit(1); }
if (seg1.done?.reason !== "toolUse") {
  log("FAIL: expected done.reason=toolUse, got", seg1.done?.reason);
  process.exit(1);
}
if (seg1.toolCalls.length === 0) {
  log("FAIL: expected at least one toolCall");
  process.exit(1);
}

// Push the assistant message into pi history (pi's loop would do this).
piMessages.push(seg1.done.message);

// ---------- Simulate pi running the stub tools ----------
log("\n=== STUB EXECUTION (simulating pi's agent loop) ===");
const tool_results = [];
for (const tc of seg1.toolCalls) {
  const tool = registeredTools.get(tc.name);
  if (!tool) {
    log(`FAIL: pi has no tool named ${tc.name}`);
    process.exit(1);
  }
  log(`  invoking stub ${tc.name}(id=${tc.id.slice(-8)})...`);
  const result = await tool.execute(tc.id, tc.args ?? {}, undefined, undefined, /* ctx */ {});
  log(`    content blocks: ${result.content.length}`);
  log(`    first content: ${JSON.stringify(result.content[0]).slice(0, 100)}`);
  log(`    details: ${JSON.stringify(result.details).slice(0, 100)}`);

  // Fire the tool_result extension event so isError propagates.
  let isError = false;
  const flag = result.details?._piCasIsError;
  if (typeof flag === "boolean") isError = flag;
  const handlers = eventHandlersByType.get("tool_result") ?? [];
  for (const h of handlers) {
    const r = await h({
      type: "tool_result",
      toolName: tc.name,
      toolCallId: tc.id,
      input: tc.args ?? {},
      content: result.content,
      details: result.details,
      isError,
    }, {});
    if (r?.isError !== undefined) isError = r.isError;
  }

  tool_results.push({
    role: "toolResult",
    toolCallId: tc.id,
    toolName: tc.name,
    content: result.content,
    details: result.details,
    isError,
    timestamp: Date.now(),
  });
}

// Push tool results to pi history.
piMessages.push(...tool_results);

// ---------- TURN 2: phantom toolResults — provider should NOT enqueue ----------
const seg2 = await runOneStreamSimple("SEGMENT 2: phantom toolResults → SDK continues → done(stop)");
if (seg2.error) { log("FAIL: turn 2 errored"); process.exit(1); }
if (seg2.done?.reason !== "stop") {
  log("FAIL: expected done.reason=stop after stub execution, got", seg2.done?.reason);
  process.exit(1);
}
if (!/two/i.test(seg2.text)) {
  log("FAIL: expected continuation text to mention 'two', got:", JSON.stringify(seg2.text));
  process.exit(1);
}

// ---------- TURN 3: user follow-up after a complete tool turn ----------
piMessages.push(seg2.done.message);
piMessages.push({ role: "user", content: "What number did you print before?" });
const seg3 = await runOneStreamSimple("SEGMENT 3: follow-up question (no tool needed)");
if (seg3.error) { log("FAIL: turn 3 errored"); process.exit(1); }
if (seg3.done?.reason !== "stop") {
  log("FAIL: expected done.reason=stop on follow-up, got", seg3.done?.reason);
  process.exit(1);
}
if (!/two/i.test(seg3.text)) {
  log("FAIL: expected follow-up text to recall 'two', got:", JSON.stringify(seg3.text));
  process.exit(1);
}

// ---------- Cleanup ----------
const shutdownHandlers = eventHandlersByType.get("session_shutdown") ?? [];
for (const h of shutdownHandlers) await h({ type: "session_shutdown", reason: "quit" });

log("\n=== PASS: stream-aligned segmentation with stub tools works end-to-end ===");
process.exit(0);
