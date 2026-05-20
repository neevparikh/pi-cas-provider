## Catch-all stub + fork/compact preservation + subagent investigation 05/20/2026 - HEAD

### Motivation

User-requested follow-ups from the deferred list (`continuation_context.md`):
1. Catch-all stub for unknown CC tools so pi doesn't crash with
   `Tool <name> not found` if the SDK ever surfaces a tool we didn't
   pre-register.
2. Fork/compact preservation (was: tear-down-and-respawn, model history
   lost).
3. Investigate how the SDK exposes subagents and what pi would see.

### Shipped

**Phase 1 — catch-all stub:**
- `src/stub-tools.ts`: added `createGenericStub(name)`,
  `isValidDynamicToolName(name)`, `VALID_DYNAMIC_TOOL_NAME` regex.
- `src/event-bridge.ts`: `createEventBridge(model, options)` second arg
  with optional `onUnknownToolName(name)` callback.  Bridge fires the
  callback on `content_block_start` for tool_use blocks not in
  `SUPPORTED_CC_TOOL_NAMES`, and on the diagnostic `appendFinalBlock`
  path.  Callback throws are caught + logged so they don't corrupt the
  segment.
- `src/config.ts`: added `ProviderConfig.registerDynamicStub` field.
- `src/provider.ts`: `registerProvider` sets up
  `config.registerDynamicStub`.  Tracks registered names in a closure
  Set seeded from `SUPPORTED_CC_TOOL_NAMES`.  Validates name, calls
  `pi.registerTool(createGenericStub(name))`, warns to stderr
  (visible without DEBUG).  Bridge creation passes the callback.

**Phase 2 — fork/compact preservation:**
- Added `forkSession` import from `@anthropic-ai/claude-agent-sdk`.
- `src/config.ts`: added `ProviderConfig.pendingFork` field.
- `src/provider.ts` `session_before_fork` handler: now calls
  `sdkForkSession(sdkSessionId)`, stashes the new SDK session id in
  `config.pendingFork`.  Tears down the live query but does NOT clear
  the source mapping (preserves backward navigation).  Falls back to
  v1 behavior on `forkSession()` failure (logs warning).
- `src/provider.ts` `session_before_compact` handler: no longer tears
  down.  Flags every active session with `needsLastSentReset`.
- `src/provider.ts` `session_shutdown` handler: now also keeps the
  mapping on `reason === "fork"` (was: only `"quit"`).
- `interface PiSession`: added `needsLastSentReset?: boolean`.
- `streamSimple`: before classification, if `needsLastSentReset`, reset
  `lastSentCount = initialLastSentCount(messages.length)`.  Clears flag.
- `ensureSession`: now calls extracted helper
  `resolveResumeForFreshSession(piId, pendingFork, persistedId)` to
  decide the resume id.  If pendingFork is consumed, persists the new
  mapping and clears the stash.
- `resolveResumeForFreshSession` exported for testing.

**Phase 3 — subagent investigation (no code; deliverable is docs):**
- `writeups/subagent_investigation.md`: full coverage of SDK surface
  (Task tool, AgentDefinition, parent_tool_use_id, task_* events,
  forwardSubagentText), required bridge changes, phasing recommendation
  (Phase A passive support → Phase B nested-transcript rendering),
  open questions for empirical resolution.
- `probe-subagent-events.mjs`: companion probe that delegates to a
  subagent and logs every SDK event with subagent metadata visible.
  Includes `PROBE_DUMP_PATH` env for JSON dump.  Syntax-checked but
  NOT run against the real API in this commit — needs the user to
  validate when they have API access + want to make a decision on
  subagent support.

**Phase 5 — subagent Phase B: nested-transcript rendering (added on
further user request, modeled on
[pi-subagent](https://github.com/mariozechner/pi-subagent)):**

User asked: "can we try and display subagent reasoning/outputs/toolcalls
the way that the pi-subagent extension works?".  Read pi-subagent's
src/index.ts to understand its rendering approach (Container +
Markdown + Text + Spacer via @mariozechner/pi-tui; per-tool-name
formatting via `formatToolCall`; collapsed/expanded modes; usage
stats line).  Adapted it for pi-cas's architecture: instead of
spawning child pi processes and parsing JSON-mode events, we
collect the SDK's typed subagent events into a transcript and
render it at result-time.

Changes:
- **`src/subagent-transcript.ts`** (new): module singleton
  `Map<parentToolUseId, SubagentTranscript>`.  Functions: `start`,
  `appendAssistant` (maps Anthropic content → pi shape +
  accumulates usage), `appendToolResult` (normalizes content),
  `recordProgress` (summary + lastToolName + subagentType
  backfill), `markFinished` (status + summary), `take` / `peek` /
  `clear` / `size`.  Idempotent `ensure()` for late-arriving
  appends.
- **`src/event-bridge.ts`**: replaced the "drop subagent events"
  early-return with structured CAPTURE.  Typed `assistant` →
  `transcriptAppendAssistant`.  Typed `user(tool_result)` →
  `transcriptAppendToolResult`.  `system.task_started` →
  `transcriptStart`.  `system.task_progress` →
  `transcriptRecordProgress`.  `system.task_notification` →
  `transcriptMarkFinished`.  `system.task_updated` and
  `tool_progress` still dropped (no useful UI consumption).
- **`src/event-bridge.ts ingestToolResult`**: on the main-thread
  Task tool_result, call `transcriptTake(id)` and attach the
  transcript to the cache entry's `details` under
  `_piCasSubagentTranscript`.  Spread vs assign-under-key handled
  carefully so a string `tool_use_result` (rare error case) isn't
  splatted into character keys.
- **`src/task-stub.ts`** (new): hand-tuned `Task` ToolDefinition with
  `renderCall` (title + dim description preview) and `renderResult`
  (collapsed: title + last 10 items + usage; expanded: Container
  with task prompt, tool calls via `formatToolCall`, final Markdown
  answer, usage stats).  `formatToolCall` exported helper covers
  Bash/Read/Write/Edit/Grep/Glob/Task with paths shortened to ~ for
  $HOME; generic JSON preview fallback for unknown tools.  Fallback
  path when no transcript captured (renders the raw text content
  with a "(no transcript)" marker).
- **`src/stub-tools.ts`**: exported `executeStub` so task-stub.ts
  can delegate to the same cache-lookup logic.
- **`src/provider.ts`**: registered `createTaskStub()` alongside the
  named stubs (with `TASK_TOOL_NAME` added to `registeredStubNames`
  so the catch-all path won't double-register).  Set
  `forwardSubagentText: true` in SDK options with a docstring
  explaining the implication.
- **`src/system-prompt.ts`**: replaced the "no nested rendering"
  caveat with the new behavior ("the host UI renders the subagent's
  reasoning, intermediate tool calls, and final answer inline under
  the parent Task call (collapsed by default, Ctrl+O to expand).
  Delegate liberally for self-contained sub-tasks…").
- **`package.json`**: added `@earendil-works/pi-tui` to
  peerDependencies (needed for `Container` / `Markdown` / `Text` /
  `Spacer` in task-stub.ts).

Tests:
- **`tests/subagent-transcript.test.ts`** (new, 15 tests):
  start/ensure idempotency, appendAssistant content mapping,
  multi-turn usage accumulation, model first-write-wins,
  appendToolResult with string/array content + is_error flag,
  malformed-block defense, recordProgress fields,
  subagentType-backfill once-only, markFinished, take/peek/clear.
- **`tests/task-stub.test.ts`** (new, 15 tests): tool definition
  shape, execute() delegates to executeStub and surfaces transcript
  in details, cache-miss path, smoke-test renderCall and
  renderResult (both branches: with/without transcript, collapsed
  + expanded), `formatToolCall` per-tool string output (Bash, Read
  w/ offset+limit, Write line count, Edit, Grep `/pattern/ in path`,
  Glob, nested Task, unknown name fallback, HOME shortening).
- **`tests/event-bridge.test.ts`**: updated the
  `parent_tool_use_id` test set to verify CAPTURE (not just
  dropping):
  - "subagent events are captured into a transcript and attached to
    the Task tool_result cache entry": end-to-end main-thread Task
    + subagent assistant + subagent tool_result + task_notification,
    asserts transcript shape on the cache entry.
  - "typed subagent events do not leak into pi's main-segment
    output": negative test on the main output.
  - "when there is no subagent transcript, the Task tool_result
    cache entry has no _piCasSubagentTranscript": fallback safety.
  - "task_progress updates the transcript (summary, lastToolName)":
    in-flight UI metadata via `peekTranscript`.
  - "system task_updated is dropped silently".
  Helpers updated to pass `tool_use_id` on `task_*` system messages
  (matches the real SDK shape).
- **Total: 153/153 pass** (was 120; +15 transcript + 15 task-stub
  + 3 added/refactored event-bridge tests).
- `npx tsc --noEmit`: clean.

Docs:
- `README.md`: "What you get" describes inline transcript rendering.
  "Known caveats" updated for Phase B shipped + remaining limits.
- `writeups/write_up.md`: new "Subagent capture + rendering
  (Phase B)" section replacing the old "Subagent filtering"
  section.  Known limitations 8 + 9 added for "no live progress" and
  "no recursive nested expansion".
- `writeups/subagent_investigation.md`: rewritten Status section
  ("Phase A AND Phase B SHIPPED").
- `writeups/continuation_context.md`: replaced the Phase A entry
  with the Phase A+B description.

---

**Phase 4 — open the tool surface + subagent Phase A (added on
user request after Phase 3 investigation):**

The investigation document was framed around "we'd need to make these
changes to enable Phase A".  User asked to ship Phase A immediately.

- `src/provider.ts`: `tools: [...SUPPORTED_CC_TOOL_NAMES]` →
  `tools: { type: 'preset', preset: 'claude_code' }` in `ensureSession`.
  The model now has the full CC tool preset.  Long docstring updated.
- `src/event-bridge.ts handle()`: explicit early-return on
  - `msg.parent_tool_use_id != null` (any typed event, covers
    subagent-internal assistant/user/tool_progress).
  - `msg.type === "system"` + subtype in `{task_started, task_progress,
    task_updated, task_notification}`.
  - `msg.type === "tool_progress"` (both main-thread and subagent;
    we don't surface per-tool progress yet).
- `src/event-bridge.ts`: added `cleanupLeakedSubagentToolUses(content)`
  for the defensive case where SDK ever leaks subagent SSE partials.
  Removes leaked ids from `pendingToolUseIds`, `segmentToolUseIds`,
  and `output.content`.  No-op in the expected case.
- `src/system-prompt.ts`: updated to list the full toolset and
  include a Phase A subagent UX caveat.  ("the host UI shows the
  parent Task call and its final result, but does NOT yet show the
  subagent's internal reasoning or tool calls.  Prefer subagents for
  self-contained sub-tasks…")
- `tests/event-bridge.test.ts`: 4 new tests covering:
  - Typed subagent assistant events are dropped (no content leakage).
  - `system.task_*` messages dropped silently.
  - `tool_progress` events (both main and subagent) dropped.
  - Defensive cleanup of leaked subagent tool_uses.
- README + write_up + continuation_context + subagent_investigation
  updated to reflect "Phase A SHIPPED" state.
- `npx tsc --noEmit`: clean.
- 120/120 tests pass (was 116; +4 subagent-filtering tests).

### Tests

- 17 tests in `tests/stub-tools.test.ts` (was 9): + 8 for
  `createGenericStub`, `isValidDynamicToolName`.
- 21 tests in `tests/event-bridge.test.ts` (was 16): + 5 for
  `onUnknownToolName` callback (fires/doesn't fire, no dedupe, throw
  safety, backward compat without callback).
- 9 tests in new `tests/fork-and-compact.test.ts`: cover all
  `resolveResumeForFreshSession` precedence cases including the
  documented single-slot-pendingFork limitation, plus
  `initialLastSentCount` re-pinning for compact-recovery use.
- Total: 116/116 pass (was 94/94).
- `npx tsc --noEmit`: clean.

### Writeups updated

- `README.md`: "Known caveats" updated to reflect new fork/compact
  behavior + catch-all stub.  "Tested / known caveats" bullet added
  for fork/compact preservation + catch-all.
- `writeups/write_up.md`: new "Fork & compact handling (v2)" section.
  New "Catch-all stub for unknown CC tools" section.  "Known
  limitations" updated (5+6 changed, 7 added for resolved
  unknown-tool crash; double-fork-without-open documented as
  sub-limitation).
- `writeups/continuation_context.md`: "What's currently in-progress /
  blocked" now lists what shipped + what's still deferred.
- `writeups/subagent_investigation.md`: new file.
- `probe-subagent-events.mjs`: new file.

### Not done / deferred for future work

- Probe-validating subagent behavior against the real API.  Document
  ready, code not yet run.
- Pi-entry-id ↔ SDK-message-uuid map.  Blocks proper
  `forkSession({ upToMessageId })` AND subagent-panel scoping.
- Map-based `pendingFork` (instead of single slot) to handle
  multi-fork-without-open.  Documented as a known limitation;
  unlikely to bite in practice.
- Forwarding pi compact to SDK via `/compact` user-message.  Would
  keep token usage on the SDK side in sync with pi's view.
- Phase A subagent support (add Task to SUPPORTED_CC_TOOL_NAMES +
  bridge filtering for parent_tool_use_id events).  Bigger UX
  decision; needs probe validation first.

---

## Initial investigation — Option B blocked by SDK auto-allow 05/19/2026 14:51 - commit c650d22 (before fix)

### What was done
- Wrote probe `/tmp/pi-cas-resume-probe/probe-warm-multi-turn.mjs` to validate Option B's long-lived `query()` + AsyncIterable<SDKUserMessage> + `canUseTool: deny+interrupt` pattern.
- Ran probe with multiple configurations.

### Key empirical findings (unexpected)

1. **`canUseTool: deny+interrupt` does NOT reliably fire**. With pi-cas's exact production config (`allowedTools: [Read,Write,Edit,Bash,Grep,Glob]`), the binary auto-allows tool calls in 3ms — too fast for an IPC roundtrip to the canUseTool callback. SDK debug log confirms `permissionDecisionMs=3` for benign Bash commands.

2. **`allowedTools` is an AUTO-ALLOW list, not a tool-availability list.** Setting `allowedTools: [Bash]` means "Bash is auto-allowed without permission prompt." To make Bash AVAILABLE but require permission, use `tools: [Bash]` + `allowedTools: []`. Even with that, the binary still auto-allowed.

3. **Pi-cas's production HTTP captures confirm the subprocess auto-runs tools**: every API request body ends in a `user` message (text or tool_result), never in `assistant(tool_use)`. The subprocess always sends a follow-up request with the auto-generated tool_result. Pi-cas's iterator-break is apparently losing the race; pi runs the tool too, producing latent double-execution that idempotent tools tolerate silently.

### Implication
Option B as designed (long-lived query + canUseTool: deny → pi runs tools) doesn't work cleanly. Pivoting to the synth-asst marker fix.

---

## Shipped synth-asst marker fix 05/19/2026 14:53 - commit 9e784f2

### What was done
- Implemented synth-asst marker in `src/transcript.ts`: trailing tool_results that pair with the last historic assistant's tool_uses get folded INTO the historic transcript, and a synthetic assistant marker (`model:"<synthetic>"`, text `"No response requested."`) is appended at the end.
- Added `CONTINUATION_HINT = "Continue based on the tool result above."` in `src/provider.ts` to be yielded via promptGen when `newUserContent` is empty (otherwise the synth-marker + `(no content)` substitution makes the model say generic acknowledgements like "I'm here if you need anything else").
- Downgraded the loud "newUserContent empty" warning to a DEBUG-mode log — empty is now the expected case after the transcript restructuring.
- Updated `tests/transcript.test.ts` with new scenarios and an `expectSynthMarkerAt` helper.

### E2E validation
`/tmp/pi-cas-resume-probe/probe-e2e-scenarios.mjs` runs against the real `claude` binary + Anthropic API. All 5 scenarios pass:
- tool-result-only continuation (the original bug case) → model: `"The command printed: zztop"` (was: `"Picking up where I left off..."`)
- user follow-up after a tool turn
- pure text conversation
- first turn (no history)
- multi-step tool sequence

### Caveats
- Tests: 72/72 pass, typecheck clean.
- README still has stale claims about canUseTool semantics — should be updated separately.

---

## Review subagent findings + follow-up fixes 05/19/2026 16:16 - commit (pending)

### Three review subagents (parallel)
- `autonomous-task-reviewer-with-writeups`: pivot too early? canUseTool auto-allow might be user-settings leakage, not intrinsic. Suggested clean-config-dir probe + permissionMode variants + PreToolUse hook.
- `reviewer` (code quality): real bug — duplicate `toolCallId` pairing is unbounded, could produce duplicate `tool_result` blocks (Anthropic API rejects). Plus stale comment in `provider.ts`, suggestions for module-scope `CONTINUATION_HINT` and additional test coverage.
- `documentation-reviewer`: `write_up.md` "Current status" section stale, `progress_log.md` had literal `$(date)` not interpolated, no entry for the actual fix commit, missing CONTINUATION_HINT rationale in `write_up.md`.

### Investigation: was the Option B pivot premature?

**Clean-config-dir probe (`/tmp/pi-cas-resume-probe/probe-canusetool-clean-config.mjs`):**
With `CLAUDE_CONFIG_DIR=/tmp/pi-cas-clean-config` (empty dir, no settings.json) + `permissionMode: "default"` + `settingSources: []` + `tools: ["Bash"]` + `allowedTools: []` + `canUseTool`:
→ canUseTool fired **0 times**. Model output: "Done. Output: cleanprobe". Subprocess auto-allowed Bash.

So the auto-allow is intrinsic to the binary, NOT just user-settings leakage. My original finding stands.

**Multi-mode probe (`/tmp/pi-cas-resume-probe/probe-canusetool-various-modes.mjs`):**
Tested permissionMode in `["default", "acceptEdits", "plan", "dontAsk"]` with `canUseTool: deny`:
→ All four: canUseTool 0 times, tool_use seen, subprocess auto-ran. None route through canUseTool for benign Bash.

**PreToolUse hook (the interesting finding):**
With `hooks: { PreToolUse: [{ hooks: [async (input, toolUseId) => {...}] }] }`:
→ Hook **DID fire**. With `hookSpecificOutput: { permissionDecision: "deny" }` it successfully blocked the tool.

But: the model interpreted the deny as a tool error and produced text like "I encountered an error when trying to run the command." Subsequently yielding the real tool_result via the gen would produce a duplicate `tool_use_id` (subprocess already paired the synthetic deny tool_result internally), which the Anthropic API rejects.

With `permissionDecision: "defer"`: the model retries 3 times then gives up, stop_reason becomes `tool_deferred`. The retry behavior is undesirable.

**Conclusion**: The PreToolUse hook IS a real mechanism to gate tool execution (unlike canUseTool which silently no-ops), but it doesn't unlock clean Option B — the duplicate-tool_use_id problem still exists.

The pivot stands. The synth-asst marker fix is the right ship-now answer. Option B may still be reachable via a deeper architectural change (e.g., SDK-runs-tools semantics — Option A revisited) but that's a bigger refactor.

### Code fixes applied per reviewer feedback
- **`src/transcript.ts`**: Fixed duplicate-`toolCallId` pairing. The pairing set now consumes each matched id via `delete`, so a second `tool_result` with the same id falls into `leftover` rather than producing duplicate blocks. Added `is_error` test, unpaired-toolResult test, duplicate-id test. Removed `(b as any).id` cast.
- **`src/provider.ts`**: Hoisted `CONTINUATION_HINT` to module scope with full doc comment. Fixed stale "." comment.
- **`tests/transcript.test.ts`**: Added 3 new test scenarios (unpaired toolResult, duplicate paired id, isError=true). Removed duplicate "empty history" and "first-turn" tests (subsumed by tests in the first describe block).
- **Writeups**: Rewriting `write_up.md` Status section, expanding `progress_log.md` (this entry).

### Result
Tests: 73/73 pass. Typecheck clean. E2E probe still passes all 5 scenarios.

---

## Option A refactor regression: pi tries to execute CC tool names 05/19/2026 20:00 - commit a59ed68 (regression discovered)

### What was discovered
After shipping the Option A refactor (a59ed68), an end-to-end test surfaced
`Tool Bash not found` errors visible to the user during tool turns.

Root cause analysis (in conversation, not in code yet):
- Option A's design comment in `provider.ts:20–21` claims pi-cas just
  forwards `tool_use` blocks to pi for display. **This is wrong about pi's
  behavior.**
- Pi's agent loop (`pi-agent-core/dist/agent-loop.js:113-117`) unconditionally
  executes every `toolCall` content block in an assistant message via
  `executeToolCalls`, regardless of stopReason.
- Pi's tool registry uses lowercase names (`bash`, `read`, `edit`). The SDK
  emits CC names (`Bash`, `Read`, `Edit`). `prepareToolCall` raises
  `Tool Bash not found`.
- Pi's `AssistantMessage.content` type literally has no slot for
  "display-only" tool calls (`type.d.ts:191`: `(TextContent | ThinkingContent
  | ToolCall)[]`). The contract is: any `ToolCall` in content means execute.

The misconception arose because Option A's design was validated in a probe
that bypassed pi entirely (`probe-refactor-e2e.mjs` simulates pi but doesn't
run pi's actual agent loop).

### Approach considered and rejected

1. **Strip toolCalls from `output.content` before `done`.** Lossy — hides
   tool history from the user.
2. **Use SDK's `canUseTool` to deny+interrupt the SDK's tool execution, let
   pi run tools.** Investigated in detail. `canUseTool` denial generates a
   synthetic `is_error` tool_result that lives forever in the SDK's session
   JSONL (sdk.d.ts:3242). On the next API call the request would contain
   both the synthetic deny tool_result AND our injection of the real one
   from pi, with the same `tool_use_id` — Anthropic API rejects, model
   confused. Confirmed via prior `PreToolUse` probe (this conversation).
3. **Revert to per-turn `query()` + transcript reconstruction (pre-refactor).**
   Works but reintroduces the resume normalizer maintenance burden the
   Option A refactor was specifically trying to escape.
4. **Drop the SDK entirely.** Talk to Anthropic API directly using SDK's
   auth. Loses the SDK's value proposition.

### Approach chosen: stream-aligned segmentation + stub tools

Key insight: the SDK ALREADY runs tools correctly. We don't need to change
tool execution. We need to fix the impedance mismatch between the SDK's
multi-message turn (one `query()` user message → many assistant messages
with tools running between them) and pi's turn-by-turn loop.

Design:
- Keep Option A's long-lived `query()` per pi session.
- Stop accumulating all SDK assistant messages into one pi `done`. Instead,
  break per SDK assistant message: push one pi `done` per assistant message.
- Wait for `user(tool_result)` SDKUserMessage events before pushing
  `done(toolUse)`. Cache the results keyed by `tool_use_id`.
- Register pi tools matching CC tool names (`Bash`, `Read`, `Write`, `Edit`,
  `Grep`, `Glob`, etc.) whose `execute()` returns the cached result.
  Side-effect-free, instant — the SDK already executed the real tool.
- On pi's next `streamSimple` (which arrives with the phantom toolResults
  from pi running our stubs), detect that all new content is phantom
  toolResults with ids we just emitted → don't enqueue to the SDK, just
  resume consuming events from the persistent iterator for the next SDK
  assistant message.

### Validation probes

Wrote two probes (committed at `probe-stub-tools.mjs` and
`probe-stub-tools-edge.mjs`) hitting the real Anthropic API + SDK:

**Basic probe** (Bash → echo hello, echo second):
- `content_block_stop` of `tool_use` arrives at 4938ms / 5289ms
- `message_stop` at 5351ms
- `user(tool_result)` for both ids at 5535-5536ms (after message_stop)
- next `message_start` at 7783ms (~2s gap)

**Edge case probe** (parallel Bash, one with `exit 7`):
- Both `tool_use` blocks in one assistant message ✓
- Both `tool_result` events arrive (5786ms, 5806ms) before next message_start (7468ms) ✓
- Error result comes through with `is_error: true`, no crash ✓
- `SDKUserMessage.tool_use_result` carries `{stdout, stderr, interrupted,
  isImage, noOutputExpected}` for success, plain error string for failure ✓

### Pi-side feasibility confirmed
- `pi.registerTool` (loader.js:178) writes into the extension's tool map
  and calls `runtime.refreshTools()` — tools become visible in
  `currentContext.tools` for the agent loop.
- `AgentToolResult.terminate?: boolean` is optional, default false — our
  stubs simply don't set it, pi continues looping, giving us the next tick.
- `AgentToolResult` has both model-facing `content` and arbitrary `details`
  — we pass through `tool_use_result` as details for nicer UI.

### Next step
Implement the refactor.

---

## Shipped: stream-aligned segmentation + stub tools 05/19/2026 21:30 - commit b42040e

### What was done

Implemented and validated the design proposed in the prior session:

- **New `src/tool-result-cache.ts`** (3 KB): module-singleton
  `Map<tool_use_id, CachedToolResult>` with one-shot `put`/`take`/`has`
  semantics.  Cross-session uniqueness via Anthropic's UUID-ish tool_use_ids.

- **New `src/stub-tools.ts`** (9 KB): six pi `ToolDefinition`s, one per
  CC built-in (`Bash`/`Read`/`Write`/`Edit`/`Grep`/`Glob`).  Each
  `execute()` calls `take()` from the cache and returns
  `{content, details}` with `_piCasIsError` stuffed into details for
  later propagation.  Loose TypeBox schemas (`additionalProperties: true`).

- **Rewrote `src/event-bridge.ts`** (~550 lines): stream-aligned
  segmenting bridge.  Per-session state machine.  Public surface:
  `attachStream` / `handle(msg)` / `isSegmentReady()` / `closeSegment()`
  / `resetTurn()` / various getters.  Holds the segment open until both
  `message_stop` arrives AND every paired `tool_result` has been
  ingested.  Caches results as they arrive.

- **Updated `src/provider.ts`** (~420-line diff):
  - `registerProvider` now registers stub tools via `pi.registerTool`
    and a `tool_result` handler that propagates `_piCasIsError`.
  - `PiSession` gained `bridge: EventBridge` and
    `recentlyEmittedToolUseIds: Set<string>` for phantom detection.
  - SDK opts gain `tools: [...SUPPORTED_CC_TOOL_NAMES]` to constrain
    the model.
  - `streamViaSDK` rewritten for multi-segment driving.  Replaced
    `extractNewUserContent` with `classifyNewContent` (now exported
    for tests).
  - Consume loop tracks `segmentStopReason`; drains `result` event
    when segment closed at end_turn / length; calls `resetTurn`.

- **Simplified `src/system-prompt.ts`**: dropped the misleading "shim
  translation" notes (no shim exists in this architecture; SDK runs CC
  tools with their native arg shapes).  Replaced with a short
  environment note telling the model to use CC PascalCase names if
  pi's prompt references lowercase ones.

### New tests (33 total added)

- `tests/tool-result-cache.test.ts` — 6 tests
- `tests/stub-tools.test.ts` — 7 tests
- `tests/event-bridge.test.ts` — 9 tests (synthesizes SDK messages,
  exercises segment lifecycle, parallel tools, errors, thinking blocks,
  multi-segment turns, resetTurn)
- `tests/classify-new-content.test.ts` — 11 tests (phantom detection
  edge cases: real, phantom, mixed, embedded tool_result blocks,
  unexpected ids, etc.)

### Validation

- `npm run typecheck`: clean.
- `npm test`: **77/77** pass (was 44/44 before this work).
- `probe-stub-tools.mjs`: timing assumptions confirmed (one-tool case).
- `probe-stub-tools-edge.mjs`: parallel tools + error tool_result paths
  confirmed.
- `probe-stub-tools-full.mjs` (NEW): drives the full multi-segment
  flow against the real Anthropic API.  Segments 1 (`done(toolUse)`),
  2 (phantom toolResults → continuation `done(stop)` with "two" in
  text), and 3 (follow-up text question → `done(stop)` recalling "two"
  from prior context) all pass.
- `probe-refactor-e2e.mjs` (updated for new architecture): 5/5
  scenarios pass.  Scenarios 2 and 4 reworked to assert
  segment-aware invariants (done.reason=toolUse for tool turns,
  done.reason=stop with prior context for follow-ups).

### Real bug found and fixed during implementation

After segment 2 closed in the first multi-segment probe run, the
provider's consume loop returned without consuming the SDK's `result`
event.  This left `turnDone=true` set on the bridge for the NEXT
streamSimple, whose `isSegmentReady()` then returned true immediately
(`sawMessageStop || !segmentStarted` was the culprit), exiting the
consume loop without reading any events.  Result: segment 3 returned
an empty assistant message.

**Fix**: removed the `sawMessageStop = sawMessageStop || !segmentStarted`
line in the bridge's result handler; added explicit empty-turn handling
in the provider; added `bridge.resetTurn()` to clear `turnDone` after
draining the result event for the next turn.

### Choices that may warrant a second look

- **Loose TypeBox schemas on stubs.**  Trade: avoids lockstep
  maintenance with CC's actual schemas, but pi's UI can't render
  param-by-param previews (it gets the raw input dict).  Acceptable
  for v1.
- **Stuffing `_piCasIsError` into `details`.**  Documented in
  stub-tools.ts; relies on pi-coding-agent's `tool_result` event
  override semantics, which IS public API (extensions/types.d.ts).
- **`tools: SUPPORTED_CC_TOOL_NAMES`** restricts the model's tool
  surface to exactly the six we stub.  Adding more requires both a
  stub and a name list update.  Skills/agents/etc are NOT exposed.
- **No catch-all stub.**  If the SDK ever emits a tool outside our
  list (e.g. via skill activation we forgot to disable), pi will fail
  with "Tool X not found".  Could add a defensive catch in
  event-bridge.

### What's next

Run the review subagents.

---

## Addressed reviewer feedback (3 parallel reviews) 05/19/2026 23:00 - commit (pending)

### Three parallel reviewer subagents found

**autonomous-task-reviewer-with-writeups** flagged five P1/P2 issues addressed in commit 17fd2bd:
- piBlockToAnthropic silently dropped pi's canonical flat ImageContent shape (the unit test reinforced the wrong shape, hiding the bug)
- EventBridge captured model at construction; mid-session setModel didn't update bridge's cost calc or output.model
- Persisted resume + lastSentCount: 0 replayed the full pi transcript to the SDK on cross-process respawn
- Stub spread entry.details which corrupted string-typed Bash error details into {0:"E",1:"r",...}
- Stub cache-miss didn't set _piCasIsError, silently rendering an internal failure as successful

**reviewer (code review)** flagged three additional important issues:
- W1: SDK error results (auth/rate-limit/5xx) were silently swallowed as empty done(stop). Production failures would look like blank successful responses.
- W2: Mid-message error dropped partial content and produced an inconsistent stream (start → deltas → done(empty)).
- W3: msg.tool_use_result was applied to every tool_result block in a batched user message, latently cross-attributing tool A's details to tool B if the SDK ever batches.
- Plus cleanup: dead `inFlight` field, unused `has` import, promote unexpected-id warn to non-DEBUG.

**reviewer (test coverage)** flagged high-priority missing tests:
- H1: No regression test for the stale-turnDone bug (the actual shipped bug) — three-segment, two-turn sequence
- H2: No unit test for "turn ended without segment" path (SDK error result)
- H3: dual-key acceptance (`toolCallId` ?? `tool_use_id`) untested
- H4: Abort/signal handling untested anywhere
- M5: initialLastSent formula edge cases untested

### Fixes shipped

**Code:**
- `event-bridge.ts`:
  - Added `turnError` state captured from `result.is_error`/`result`/`error`; exposed via `getTurnError()` and `hasPartialContent()` accessors; cleared by `resetTurn()`.
  - Restructured tool_result ingestion: `tool_use_result` is only attached to the FIRST tool_result block per user SDKUserMessage (defensive against future SDK batching).
- `provider.ts`:
  - "Turn ended without segment" branch now distinguishes (a) SDK error → `pushError`, (b) partial-content + no completion → `pushError`, (c) truly empty no-op → empty done.
  - Removed dead `inFlight` field and all its assignment sites.
  - Promoted unexpected-toolResult-ids warning from DEBUG-only to always-on `console.warn`.
  - Extracted `initialLastSentCount(piMessagesLength)` as an exported helper.
- `stub-tools.ts`:
  - Removed unused `has` import.

**Tests added (10 new, total 92):**
- `tests/event-bridge.test.ts`:
  - H1 regression: stale-turnDone three-segment sequence (turn 1 end_turn → drain result → resetTurn → turn 2 starts cleanly).
  - H2 (×3): turn-level error before any segment / error after partial content / resetTurn clears turnError.
- `tests/classify-new-content.test.ts`:
  - H3: embedded tool_result with Anthropic-shape `tool_use_id` key.
  - M5 (×5): initialLastSentCount with empty/single/large/negative inputs; combined with classifyNewContent on a 5-message resumed slice.
- `tests/stub-tools.test.ts`:
  - String SDK details preserved under `_piCasToolUseResult`.
  - Structured (object) SDK details spread correctly.
  - Cache miss propagates `_piCasIsError: true`.

### Deferred

- H4 (abort/signal handling): unit testing requires mocking `@anthropic-ai/claude-agent-sdk`'s `query()`. The probe-refactor-e2e.mjs exercises a session_shutdown teardown but not in-flight abort. Adding a vitest mock of the SDK is significant work for one feature gap. The abort code is small (4 lines wiring options.signal to query.interrupt) and the e2e probes confirm the lifecycle teardown path works. Deferred as a separate hardening task.

### Validation

- `npm run typecheck`: clean.
- `npm test`: 92/92 pass (was 82).
- `probe-stub-tools-full.mjs`: passes (3 segments end-to-end).
- `probe-refactor-e2e.mjs`: 5/5 scenarios pass.

---

## Addressed choices + dead-code + documentation reviews 05/19/2026 23:40 - commit (pending)

### Three reviewers in this pass

**Choices reviewer**: assessed 10 non-obvious choices.  All sound; flagged:
- Choice #3 (restricted tool surface): brittle vs future CC tools \u2014 catch-all stub as Open Path #4.
- Choice #7 (initialLastSentCount): no signal when fresh-session-with-pi-history loses context.
- Choice #8 (surface SDK errors): partial content was being discarded by pushError; need to flush it first.
- Choice #10 (warn promotion): rate-limiting risk if extensions inject many unexpected ids.

**Dead-code reviewer**: flagged:
- `event-bridge.ts` `msg.type === 'assistant'` handler + `appendFinalBlock` are unreachable with `includePartialMessages: true` (kept as defensive).
- `tool-result-cache.ts` `has`/`clear`/`size` exported but only test-imported (kept; test-only is fine).
- `stub-tools.ts` `terminate?: boolean` field unused in return type \u2014 removed.
- `stub-tools.ts` `SupportedCcToolName` only internal (exported anyway; small).
- `provider.ts` `_model` unused param in `buildSubprocessEnv` \u2014 removed.
- `provider.ts` `emit()` had two unused params (`_pi`, `_customType`) \u2014 removed.

**Documentation reviewer**: ~35 stale claims, mostly in README.md describing the pre-refactor architecture.  Major rewrites required for:
- "What you get" bullets (stub tools, restricted tool surface, fast-mode-at-spawn semantics)
- Auth table (3 states + okta path, not 2)
- "How it works" architecture diagram + bullets (was stale from Option A; now describes segmentation + stubs + phantom detection)
- Tested / Known caveats (94 tests, multi-segment probe, restricted-tool surface, live-config-change limits, provider-switch context loss)
- Development section (94 tests, updated probe filenames)
- Fast mode caveats (~30x \u2192 ~2x; mid-conversation toggle clarification)
- Okta-relay mode (relay resolved at spawn, not per-turn)
- Removed retired UI-badge section (event bus is the only mechanism now)
- Removed duplicate `/cas-perm` row in slash-commands table
- writeups: test count 77 \u2192 94, commit hashes updated
- src/provider.ts top-of-file docstring: corrected the "never feeds history via --resume" claim
- continuation_context.md: status updated; H4 abort/signal hardening + catch-all stub listed as deferred

### Fixes shipped (this pass)

**Code:**
- `event-bridge.ts`: added `closeStreamWithError(message)` + `getPartialOutput()` accessors so the provider's error path preserves partial content streamed before the error.  Otherwise pi's UI showed text appear and then vanish on SDK error.
- `provider.ts`: error-path now calls `bridge.closeStreamWithError(msg)` instead of `pushError`, preserving partial content.
- Removed `_model` param from `buildSubprocessEnv` and `_pi`/`_customType` from `emit()`.
- Removed `terminate?: boolean` from `executeStub` return type (always unset).
- Source-level docstring in `provider.ts` corrected (resume + teardown).

**Tests added:**
- 2 new tests for `closeStreamWithError`: preserves partial text content; works with no partial content.

**Writeups + README:**
- `README.md`: major rewrite of "What you get", "How it works", "Status & known issues", "Development", "Fast mode caveats", "UI/Event-bus", "Okta-relay mode". Auth table now 3 states. Duplicate slash-command row removed.
- `writeups/write_up.md`: added "Error handling" section; added cross-process resume + fresh-session-with-pi-history paragraph; added Known Limitations bullet for the latter.
- `writeups/continuation_context.md`: status + test count updated; H4 + catch-all stub added to deferred list.

### Validation

- `npm run typecheck`: clean.
- `npm test`: 94/94 (was 92 before this pass).
- `probe-stub-tools-full.mjs`: 3 segments end-to-end against real Anthropic API.
- `probe-refactor-e2e.mjs`: 5/5 scenarios pass.

### Deferred (still open)

- H4: abort/signal unit tests (require SDK mocking).
- Catch-all stub for unknown CC tool names (Open path #4 in write_up.md).
- Provider-switch context-loss warning (Choice #7 review suggestion).
- Rate-limiting unexpected-id warnings (Choice #10 review suggestion; low priority).
