# Continuation context

## Status

**Stream-aligned segmentation + stub tools is the current architecture.**
Commit `b42040e` ... HEAD.  Tests pass (94/94), both e2e probes pass.
Follow-up review-feedback commits: `17fd2bd` (P1/P2), `192217c` (code
review + test coverage).

For the full design, choices, and history of what was tried/rejected, read
`write_up.md`.  For the chronological development log read
`progress_log.md`.

## How to rebuild and re-run probes

```bash
cd /Users/neev/repos/pi-cas-provider

# Compile to dist-probe (.mjs probes can import from it)
rm -rf dist-probe
npx tsc --noEmit false --outDir dist-probe \
  --module ESNext --moduleResolution node --target ES2022 \
  --esModuleInterop --skipLibCheck src/*.ts

# Probes need API access + clean state
export PI_CAS_BUILD=$PWD/dist-probe
export ANTHROPIC_API_KEY=$(security find-generic-password -s "Claude Code" -w)
export PI_CAS_STATE_PATH=/tmp/pi-cas-clean-state.json
rm -f $PI_CAS_STATE_PATH

# Full multi-segment e2e (most valuable single probe)
node probe-stub-tools-full.mjs

# Provider-surface validation
node probe-refactor-e2e.mjs

# Low-level SDK timing probes
node probe-stub-tools.mjs
node probe-stub-tools-edge.mjs
```

## Key files

- `src/provider.ts` — top-level `streamViaSDK`; phantom detection; consume
  loop.  Where most of the architectural logic lives.
- `src/event-bridge.ts` — segment state machine.  Read alongside
  provider.ts to follow the flow.
- `src/stub-tools.ts` — six CC stub `ToolDefinition`s + executor.
- `src/tool-result-cache.ts` — small singleton cache.
- `tests/event-bridge.test.ts` + `tests/classify-new-content.test.ts` —
  the most useful tests for understanding intended behavior.
- `probe-stub-tools-full.mjs` — drives the multi-segment flow end-to-end
  against the real API.  Useful regression check.

## Tribal knowledge

- **Persistent iterator pattern.**  `PiSession.iter` is captured once via
  `query[Symbol.asyncIterator]()` and reused across every streamSimple
  call.  Using `for await (const msg of query) { ... break }` calls
  `iter.return()` and CLOSES the generator.  Subsequent turns then hang.
  Discovered empirically.  See PiSession.iter docstring.

- **`turnDone` flag rearm.**  Whenever the consume loop drains an SDK
  `result` event (after an end_turn segment), the provider MUST call
  `bridge.resetTurn()` so the next `streamSimple` doesn't see stale
  `turnDone=true` and exit immediately.  This was a real bug found in
  development.

- **Stub-tool isError propagation.**  Pi has no return-side `isError`
  field on `AgentToolResult` — pi infers it from throws.  We use the
  `tool_result` extension event to override `isError` post-execution,
  reading `_piCasIsError` from `details`.  See provider.ts where the
  handler is registered.

- **probe-refactor-e2e.mjs is gitignored** (in `.gitignore` twice,
  legacy).  Don't bother committing edits to it.

- **Auth: API key for probes.** Use `security find-generic-password -s
  "Claude Code" -w` on macOS.  Persisted state file
  (`/Users/neev/.pi/agent/pi-cas.json`) may have okta-relay enabled —
  set `PI_CAS_STATE_PATH=/tmp/pi-cas-clean-state.json` and delete it
  before running probes from a clean state.

- **Build dir caveat.** Probes must run with `PI_CAS_BUILD=$PWD/dist-probe`
  (NOT `/tmp/pi-cas-build-v3`) because the compiled output needs to
  resolve `@anthropic-ai/claude-agent-sdk` from `node_modules`, which
  only works when the dist directory is inside the repo.

## What's currently in-progress / blocked

Nothing in-progress.  Open paths are documented in `write_up.md` under
"Open paths".

### Recently shipped (commit: pending — full toolset + subagent Phase A + fork/compact + catch-all)

- **Catch-all stub for unknown CC tools.**  `src/stub-tools.ts`
  `createGenericStub(name)` + `isValidDynamicToolName(name)`.
  `src/event-bridge.ts` `createEventBridge(model, {onUnknownToolName})`
  callback.  Provider wires the callback to `pi.registerTool` of a
  dynamic stub.  Pi no longer crashes when the SDK emits an
  unrecognized tool_use.
- **Full Claude Code tool preset enabled.**  Switched
  `tools: [...SUPPORTED_CC_TOOL_NAMES]` → `tools: { type: 'preset',
  preset: 'claude_code' }`.  Model now has Task (subagents), WebFetch,
  WebSearch, NotebookEdit, TodoWrite, ExitPlanMode, MCP tools, etc.
  All routed through the catch-all stub path.
- **Subagent Phase A + B: capture inner events + render nested
  transcripts.**  Typed messages with `parent_tool_use_id != null`
  and `system.task_*` events are captured into per-Task
  `SubagentTranscript` (see `src/subagent-transcript.ts`).  The
  bridge attaches the transcript to the Task tool_result's cache
  entry; a custom `Task` stub (`src/task-stub.ts`) renders the
  nested view (text/thinking, tool calls with `formatToolCall`,
  final Markdown answer, usage stats) — modeled on the
  [pi-subagent](https://github.com/mariozechner/pi-subagent)
  extension.  SDK option `forwardSubagentText: true` enabled so
  subagent text arrives as typed events.  Defensive
  `cleanupLeakedSubagentToolUses` covers the hypothetical case
  of leaked SSE partials.
- **Fork preserves model history.**  `session_before_fork` calls SDK
  `forkSession()`, stashes the forked session id in
  `config.pendingFork`.  Next streamSimple on the new pi session id
  resumes into the forked SDK session via
  `resolveResumeForFreshSession`.  Limitation: full source session
  copied (no `upToMessageId` yet).
- **Compact keeps SDK alive.**  `session_before_compact` flags every
  active session with `needsLastSentReset` instead of tearing down.
  Next streamSimple reseats `lastSentCount` to N-1.  The SDK keeps
  its full internal history; pi's view is the compacted summary.

### Still deferred

- **H4 (abort/signal unit tests)**: requires mocking the Agent SDK's
  `query()`.  E2E probes don't cover in-flight abort.  Defer as a
  separate task.
- **Live in-flight subagent progress.**  The rendered transcript
  currently appears only after the subagent completes (pi-cas holds
  the bridging segment open until the parent tool_result arrives).
  Showing live progress mid-flight would require emitting partial pi
  events during the SDK's subagent run.
- **Recursive nested-subagent expansion.**  Inner Task within a
  subagent is shown as a tool call but its own transcript isn't
  recursively expanded under it.
- **Probe-validation of subagent flow.**  `probe-subagent-events.mjs`
  ready; needs run against the real API.
- **Pi entry-id ↔ SDK message-uuid map**: blocks both
  `forkSession({ upToMessageId })` and any future subagent-panel
  scoping work.
- **Forward pi compact to SDK** via `/compact` user-message slash
  command so the two views stay in sync.
