# Continuation context

## What's shipped

Two commits address the "Picking up where I left off" bug:

- `9e784f2`: initial synth-asst marker fix — `src/transcript.ts` adds the
  marker logic, `src/provider.ts` adds `CONTINUATION_HINT` for empty-prompt
  case, `tests/transcript.test.ts` updated.
- Follow-up commit (pending): reviewer-feedback fixes — duplicate `toolCallId`
  pairing bug fixed, `CONTINUATION_HINT` hoisted to module scope with full doc
  comment, additional test scenarios (isError, unpaired, duplicate-id), README
  claims about canUseTool corrected.

73 tests pass. typecheck clean. E2E validated against the real `claude`
binary + Anthropic API across 5 scenarios (probe code at
`/tmp/pi-cas-resume-probe/probe-e2e-scenarios.mjs`).

## Important context for someone continuing this

### The pivot from Option B
The user explicitly asked for "the full refactor and implementation" of Option B (long-lived `query()` per pi session, structurally eliminating the bug). Empirical probing during this work discovered Option B as designed doesn't work cleanly because `canUseTool: deny+interrupt` doesn't reliably fire for benign tool calls — the bundled binary auto-allows in ~3ms, faster than an IPC roundtrip to the canUseTool callback. See `writeups/write_up.md` and `writeups/progress_log.md` for full investigation.

This pivot **changed the scope from what the user explicitly asked for**. The committed fix is smaller but verifiably works. If the user wants Option B revisited, see the "Open paths for Option B" section below.

### Key files
- `src/transcript.ts` — `piToTranscript` and `appendSynthAssistantMarker`. The new transcript shape ends in a synthetic assistant entry.
- `src/provider.ts` — `streamViaSDK`. Line ~395: `CONTINUATION_HINT` const + promptGen with the hint fallback.
- `tests/transcript.test.ts` — `expectSynthMarkerAt` helper + scenario tests.
- `writeups/write_up.md` — design rationale and failed approaches.
- `writeups/progress_log.md` — chronological notes.

### Probes (kept for reference, not part of pi-cas)
- `/tmp/pi-cas-resume-probe/probe-warm-multi-turn.mjs` — Option B long-lived query attempt; documented the canUseTool auto-allow blocker.
- `/tmp/pi-cas-resume-probe/probe-permission.mjs` — minimal repro showing canUseTool DOES fire for not-in-allowlist commands; useful for understanding what triggers vs bypasses canUseTool.
- `/tmp/pi-cas-resume-probe/probe-e2e-synth-asst.mjs` — single-scenario fix validation.
- `/tmp/pi-cas-resume-probe/probe-e2e-scenarios.mjs` — 5-scenario fix validation (the main one).
- `/tmp/pi-cas-build/` — TypeScript build output the probes import from. Rebuild with `npx tsc --noEmit false --outDir /tmp/pi-cas-build --module ESNext --moduleResolution node --allowImportingTsExtensions false --target ES2022 src/transcript.ts src/session-store.ts src/tool-shim.ts` from the pi-cas-provider root.
- HTTP capture proxy: `/tmp/pi-cas-resume-probe/proxy.mjs`. Start with `PROBE_TAG=warm node proxy.mjs &` then set `ANTHROPIC_BASE_URL=http://127.0.0.1:18284` in probe env.
- Auth: `ANTHROPIC_API_KEY=$(security find-generic-password -s "Claude Code" -w)`.

### Gotcha: user's ~/.claude/settings.json affects canUseTool firing
While probing, I discovered that `~/.claude/settings.json` allow rules (like `"Bash(echo:*)"`) cause the binary to auto-allow without going through canUseTool — even when the SDK is invoked with `settingSources: []`. Pi-cas users with permissive settings get more silent SDK auto-execution than users with strict settings. This is an *existing* pi-cas property, not introduced by the fix, but worth knowing.

### Why "No response requested." and "<synthetic>" specifically
These are the binary's own internal sentinels (`TGH` and `jG`). The binary synthesizes assistant messages with these values during its own resume-recovery flow. The model has presumably seen this pattern in Claude Code training data. We match the binary's convention so our marker is indistinguishable from one the binary would synthesize itself.

## Open paths for Option B (if revisited later)

From the second-round investigation (post-reviewer feedback), the SDK
options space has been mapped out:

1. **`canUseTool` does not fire reliably.** Confirmed with clean
   CLAUDE_CONFIG_DIR + every permissionMode + tools/allowedTools variants.
   The binary's auto-classifier short-circuits canUseTool for benign tools.

2. **`PreToolUse` hook DOES fire reliably.** With `hookSpecificOutput.
   permissionDecision: "deny"` the hook successfully blocks the tool. But:
   the subprocess pairs the hook's deny as a synthetic `tool_result`
   internally, so yielding the real `tool_result` afterward via the gen
   produces a duplicate `tool_use_id` (Anthropic API rejects). This is the
   blocker for the obvious Option B implementation.

3. **`PreToolUse` hook with `permissionDecision: "defer"`** — causes the
   model to retry the tool 3 times then give up. Undesirable.

4. **`hook_deferred_tool` attachment** (documented `dG8` escape): empirically
   does NOT fire in the SDK resume path. Cause unknown.

5. **SDK-runs-tools (Option A) with long-lived query**: still reachable. Big
   architectural change — pi-cas's assistant message would no longer include
   toolCall content blocks; pi-cas would emit them as informational stream
   events for UI but not as structured content. Pi's permission system would
   be bypassed (Claude Code's would apply). Custom pi tools still wouldn't
   be exposed (existing limitation).

6. **Custom MCP tools approach**: register pi's tools as in-process MCP
   tools (the v0.2 plan). MCP tool calls might route through different
   permission paths than built-in tools — worth probing.

7. **Binary-level changes / undocumented flags**: there might be an
   environment variable or flag that disables the auto-classifier. Worth
   checking with Anthropic if Option B is high priority.

## Pi-cas's pre-existing latent bug worth flagging
Pi-cas's "canUseTool: deny + iterator break-early" pattern races against the subprocess auto-allowing and running the tool. Production HTTP captures (`/tmp/pi-cas-http-picas.jsonl`) confirm the subprocess DOES auto-run tools (every API request body ends in user, never assistant(tool_use)). Pi ALSO runs the tool via its normal flow, so double-execution happens for non-idempotent tools (Bash side effects, file writes). Users haven't complained loudly so it's not catastrophic, but ideally pi-cas would prevent double execution. This wasn't fixed in the synth-asst commit and isn't introduced by it.

## Next sensible steps
1. **Spawn task-completion review subagents** (instructions/code/tests) — not yet done.
2. Decide whether to revisit Option B given the pivot. If yes, see "Open paths" above.
3. If shipping as-is: make sure the README's "canUseTool: deny so SDK never executes tools" claim is updated to reflect reality (subprocess DOES auto-execute many tool calls). Mentioning this in CHANGELOG too.
