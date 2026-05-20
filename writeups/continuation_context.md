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

Deferred hardening from the review pass:
- **H4 (abort/signal unit tests)**: requires mocking the Agent SDK's
  `query()`.  E2E probes don't cover in-flight abort.  Defer as a
  separate task.
- **Catch-all stub for unknown CC tool names** (Open path #4 in
  write_up.md): would prevent `Tool <name> not found` crashes if a
  future CC release surfaces a tool we haven't added to
  `SUPPORTED_CC_TOOL_NAMES`.
