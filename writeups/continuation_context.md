# Continuation context

## Status: Option A refactor COMPLETE

The "Picking up where I left off" bug is fixed structurally via a complete
architectural pivot: long-lived `query()` per pi session, SDK runs all tools
natively, no on-disk JSONL replay during steady state.

### What shipped

**New architecture** (`src/provider.ts`):
- One long-lived `query()` per pi session, lazily spawned on first `streamSimple`.
- `prompt: AsyncIterable<SDKUserMessage>` stays open for session lifetime.
- `permissionMode: "bypassPermissions"` (configurable via `/cas-perm`,
  `PI_CAS_PERMISSION_MODE`, or pi-cas.json).
- SDK runs every tool natively; pi-cas just forwards `tool_use`/`tool_result`
  stream events to pi for display.
- Per-turn: extract new user content from `context.messages.slice(lastSentCount)`,
  enqueue into the long-lived AsyncIterable, consume SDK events until `result`.
- Lifecycle: `session_shutdown` tears down + persists sdk_session_id;
  `session_before_fork` / `session_before_compact` tear down + clear mapping
  (v1 limitation: model history is lost on fork).

**Critical implementation details**:

1. **Persistent iterator** (`PiSession.iter`): captured once via
   `query[Symbol.asyncIterator]()` and reused across every turn. Using
   `for await (const msg of query) { ... break }` calls `iter.return()` and
   CLOSES the generator, so subsequent turns hang forever. Discovered via the
   e2e probe (scenario 2 hung on the second turn until this was fixed).

2. **Event-bridge message_start reset** (`src/event-bridge.ts:246-263`):
   Anthropic resets `content_block` indices at every assistant message
   boundary. SDK-runs-tools means one streamSimple call now spans multiple
   assistant messages (text+tool_use → tool ran → final text are separate
   Anthropic messages). Must clear the tracked-blocks list on
   `message_start` to avoid index collisions that route the final text's
   deltas to the first message's text block (causing empty replies on
   tool turns).

3. **lastSentCount divergence detection**: pi sends the full message
   history on every streamSimple. We extract only `messages.slice(lastSentCount)`
   and reduce to user-role content blocks (skipping any toolResult blocks —
   the SDK already saw them internally).

**Deleted modules** (no longer needed):
- `src/transcript.ts` + `tests/transcript.test.ts`
- `src/session-store.ts`
- `src/tool-shim.ts` + `tests/tool-shim.test.ts`

**Added**:
- `/cas-perm <mode>` slash command (in `provider.ts`)
- `permissionMode` field in `PersistedState` (in `persistence.ts`)
- `getSessionMapping` / `setSessionMapping` / `clearSessionMapping` helpers
- `tests/persistence.test.ts` — 15 tests for persistence helpers + mode parsing

### Validation

- **Typecheck clean.** `npx tsc --noEmit` passes.
- **Unit tests**: 44/44 pass (`tests/persistence.test.ts` is new; relay,
  http-log-proxy, thinking unchanged).
- **E2E probe** (`probe-refactor-e2e.mjs` in repo root): 5/5 scenarios pass
  against the real `claude` binary + Anthropic API:
  1. First turn, text-only
  2. Same session, tool turn (the case that originally exposed the
     iterator-close and message_start bugs)
  3. No new user content → no-op
  4. Follow-up question after tool turn
  5. Post-shutdown lazy respawn

### Accepted limitations (deliberate, documented in README + writeups)

1. **No pi permission UI for tools.** `bypassPermissions` skips all
   permission checks. Switch to `permissionMode: "default"` via `/cas-perm`
   if you want the SDK's classifier-+-ask path, but pi-cas does NOT route
   `can_use_tool` requests to pi's UI — unsafe tools will hang.
2. **No pi custom tools / extension MCP servers.** Model sees only Claude
   Code built-ins. Adding them back is Design 1 (pi-tools-as-MCP-bridge);
   deferred.
3. **No pi tool-hook translation.** User confirmed they don't use any
   today. SDK `PreToolUse` hooks are the bridge if needed later.
4. **Cancel latency.** `query.interrupt()` waits for current tool handler
   to complete.
5. **Fork/compact loses model history.** Tear-down-and-respawn for v1.
   SDK's `forkSession + resumeSessionAt` could preserve; deferred to v2.
6. **Compaction-summary "Picking back up..." bug.** Separate bug, separate
   code path. May or may not still occur in new architecture; needs
   verification.

### Probe locations (kept for reference)

- `/Users/neev/repos/pi-cas-provider/probe-refactor-e2e.mjs` — main e2e
  validation (lives in repo so it can import deps).
- `/tmp/pi-cas-resume-probe/probe-sdk-runs-baseline.mjs` — 5-turn baseline
  validation that built the case for this refactor.
- `/tmp/pi-cas-resume-probe/probe-sdk-runs-control-apis.mjs` — control APIs
  (setModel, setPermissionMode, interrupt) validation.
- `/tmp/pi-cas-resume-probe/probe-sdk-runs-fork.mjs` — `forkSession +
  resumeSessionAt` validation (not yet wired into pi-cas, but proves the
  v2 path is viable).
- Clean SDK config dir for probes: `/tmp/pi-cas-clean-config`.
- Auth: `ANTHROPIC_API_KEY=$(security find-generic-password -s "Claude Code" -w)`.

### How to rebuild + re-run the e2e probe

```bash
cd /Users/neev/repos/pi-cas-provider
rm -rf dist-probe
npx tsc --noEmit false --outDir dist-probe \
  --module ESNext --moduleResolution node --target ES2022 \
  --esModuleInterop --skipLibCheck src/*.ts
export ANTHROPIC_API_KEY=$(security find-generic-password -s "Claude Code" -w)
export PI_CAS_BUILD=$PWD/dist-probe
node probe-refactor-e2e.mjs
```

### Earlier work (pre-refactor synth-marker fix)

Three commits in git history (`9e784f2`, `9433cc3`, `1ebc00f`) implemented a
transcript-synthesis-layer workaround that's now superseded. The deleted
modules (transcript.ts, session-store.ts, tool-shim.ts) come from that
era. The commits remain in history for reference; the synth-marker is no
longer needed because the bug is structurally impossible in the new
architecture.

## Open paths (for whoever picks this up next)

1. **Pi UI for permission prompts.** Add a `can_use_tool` control_request
   handler that forwards to pi's notification/confirm UI; enable
   `permissionMode: "default"` as a non-hanging mode.
2. **Pi custom tools via MCP.** Mirror pi's registered tools into an
   in-process MCP server (Design 1 from earlier branch); restore parity
   with v0.x while keeping the SDK-runs-builtins benefits.
3. **Fork-with-history.** Wire `forkSession + resumeSessionAt` into the
   `session_before_fork` handler — probe 3 (`probe-sdk-runs-fork.mjs`)
   already validated this works at the SDK level.
4. **Compaction-summary bug verification.** Repro the compaction case and
   check whether the new architecture still triggers "Picking back up...".
5. **Cancel latency for long built-in tools.** Investigate whether the SDK
   exposes any per-tool timeout for built-ins (MCP_TOOL_TIMEOUT only
   covers MCP tools).
