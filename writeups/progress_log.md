## Probe results — Option B requires deeper rethinking $(TZ='America/Los_Angeles' date '+%m/%d/%Y %H:%M') - commit c650d22

### What was done
- Wrote probe `/tmp/pi-cas-resume-probe/probe-warm-multi-turn.mjs` to validate the long-lived `query()` + AsyncIterable<SDKUserMessage> + `canUseTool: deny+interrupt` pattern.
- Ran probe with multiple configurations.

### Key empirical findings (unexpected)

1. **`canUseTool: deny+interrupt` does NOT reliably fire**. With pi-cas's exact production config (`allowedTools: [Read,Write,Edit,Bash,Grep,Glob]`), the binary auto-allows tool calls in 3ms — too fast for an IPC roundtrip to the canUseTool callback. The SDK debug log confirms `permissionDecisionMs=3` for `printf 'foo'` even with `settingSources: []`, `permissionMode: "default"`, and inline `settings: {permissions:{allow:[]}}`.

2. **`allowedTools` is an AUTO-ALLOW list, not a tool-availability list**. Setting `allowedTools: [Bash]` means "Bash is auto-allowed without permission prompt." To make Bash AVAILABLE but require permission, use `tools: [Bash]` + `allowedTools: []`. Even with this, the binary's internal auto-classifier still auto-allowed benign Bash commands.

3. **Pi-cas's production HTTP captures confirm the subprocess auto-runs tools**: every API request body ends in a `user` message (text or tool_result), never in `assistant(tool_use)`. The subprocess always sends a follow-up request with the auto-generated tool_result after a tool_use. Pi-cas's iterator-break is racing against the subprocess auto-run AND apparently losing (or pi tolerates the double-execution because most tools are idempotent enough).

4. **User's `~/.claude/settings.json` allow rules silently leak into the SDK subprocess** even with `settingSources: []`. The bundled binary's auto-allow logic appears to short-circuit independent of explicit settings. This is a real (small) pi-cas issue today.

### Implication for Option B as originally designed
The "long-lived query + canUseTool: deny+interrupt" pattern doesn't work cleanly:
- canUseTool doesn't reliably fire → subprocess auto-runs tools
- If we then yield a pi-supplied tool_result via the gen for an already-paired tool_use, the subprocess gets a duplicate → API conflict
- Without yielding tool_results, pi-cas can't keep the SDK's history in sync with pi's history

### Pivot decision
Reverting to the **synth-asst marker** fix that was empirically validated earlier in the design discussion (req-08-style probe results). It:
- Suppresses both injection sites in the resume normalizer (`Xg5 + TGH splice`)
- Empirically does NOT degrade model output (verified across multiple prompt variants including empty)
- Is a ~30-line `src/transcript.ts` change with tests
- Avoids the architectural complexity of long-lived subprocess + permission disambiguation

Option B remains compelling but requires either:
- A way to force `canUseTool` to fire for ALL tools (need binary changes or undocumented option)
- An architectural pivot to "SDK runs tools, pi-cas hides toolCalls from pi" which changes the pi-cas → pi contract

Both are bigger refactors than the synth-asst fix warrants right now.

### Details
- Probe code: `/tmp/pi-cas-resume-probe/probe-warm-multi-turn.mjs` (kept for future reference)
- Permission-quirk probe: `/tmp/pi-cas-resume-probe/probe-permission.mjs` (kept)
