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
