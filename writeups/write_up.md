# pi-cas-provider — "Picking up where I left off" fix

## Project goal

Fix the "Picking up where I left off" / `(no content)` / `"Continue from where you left off."` injection bug in pi-cas-provider.

Root cause (established earlier in the design discussion):
1. pi-cas spawns one `claude` subprocess per pi turn with `--resume <session-id>` and uses `canUseTool: deny + interrupt` to defer tool execution to pi.
2. The bundled `claude` binary's resume normalizer (`gG8 → iO6 → DM_ → JM_ → Xg5`) is tuned for `claude --resume` after ctrl-c-mid-tool. When it sees an unpaired `tool_use` (which is the normal shape of pi-cas's on-disk transcript, because the matching `tool_result` arrives via the *next* subprocess via promptGen), `iO6` orphan-prunes the assistant turn, then `Xg5` flags the resulting buffer as `interrupted_turn`, then two synthetic messages get spliced in: `user("Continue from where you left off.")` and `assistant("No response requested.")`.
3. Those synthetic injections poison the model's view of the conversation, producing "Picking up where I left off…" model output and downstream `(no content)` feedback loops.

## Fix shipped: synth-asst marker

Append a synthetic `assistant(model:"<synthetic>", content:[{type:"text", text:"No response requested."}])` entry at the end of every historic transcript JSONL pi-cas hands to `SessionStore.load()`. This makes the buffer end in `assistant` rather than `user(tool_result)`, so:

- `Xg5`'s `findLastIndex(non-system, non-progress)` lands on an assistant → returns `{kind:"none"}` → no `"Continue from where…"` splice
- The unconditional `"No response requested."` splice's `if ($[Y].type === "user")` check fails → no `TGH` splice either
- `iO6`'s orphan-prune is sidestepped because we ALSO move trailing tool_results into the historic JSONL (paired with the last assistant's tool_use), so no tool_use ever appears unpaired on disk.

The exact strings `"<synthetic>"` and `"No response requested."` match the binary's own internal `jG`/`TGH` constants — so the model has presumably seen this pattern in Claude Code training data (it's what the binary itself synthesizes during ctrl-c recovery).

### Why this fix and not Option B (long-lived `query()`)

Option B (keep one `claude` subprocess alive per pi session via a long-lived AsyncIterable<SDKUserMessage> prompt) would structurally eliminate the bug. The SDK docs confirm this pattern is supported. **However, empirical probing during this work revealed two blockers:**

1. **`canUseTool: deny + interrupt` does NOT reliably fire** for benign tool calls. The bundled binary's permission-resolution short-circuits to auto-allow in ~3ms — too fast for an IPC roundtrip to the canUseTool callback. Even with `settingSources: []`, `permissionMode: "default"`, and inline `settings: {permissions:{allow:[]}}`, simple Bash commands like `printf 'foo'` are auto-allowed. The binary's internal auto-classifier bypasses canUseTool for "obviously safe" tools.

2. **Pi-cas's current production already has this property.** API request bodies in `/tmp/pi-cas-http-picas.jsonl` confirm: every request ends in `user` (text or tool_result), never `assistant(tool_use)`. The subprocess auto-runs tools and sends a follow-up request with the tool_result. Pi-cas's "break-early on tool_use" is racing the subprocess's auto-run and apparently losing — pi runs tools too, so users get double-execution that idempotent tools (Read, most Bash) tolerate silently.

This means the Option B design "long-lived query + canUseTool: deny → pi runs tools" is structurally broken at the SDK boundary. To make it work we'd need either:
- A way to disable the binary's auto-allow short-circuit (no documented option; would require binary changes or undocumented config)
- An architectural pivot to "SDK runs tools, pi hides the toolCalls from its loop" — changes pi-cas's pi-facing contract significantly (custom message rendering for tool calls, pi history shape changes, custom permission UI, etc.)

Both are larger refactors than the bug warrants. The synth-asst marker fix is surgical and verified to work without degrading model output (probe results below).

## Empirical validation of the synth-asst marker

Earlier in the design discussion, probes against the real `claude` binary + the real Anthropic API confirmed:

Transcript shape (4 entries on disk):
```
[0] user      — "Run echo hello, then tell me what it printed."
[1] assistant — text + tool_use(Bash)
[2] user      — tool_result("hello\n")                    ← paired with [1]
[3] assistant — { model:"<synthetic>", text:"No response requested." }
```

API request bodies for 6 different `promptGen` yield variants — all produced 5-message clean API requests with NO synthetic injections, and the model produced meaningful contextual responses (even for empty-string yield).

Compared to control (no synth-asst at end): produces 3-5 message corrupted requests with the synthetic `"Continue from where you left off."` and `"No response requested."` injections, and model output begins "Picking up where I left off…".

## Architecture (after fix)

```
streamSimple call from pi
  ↓
piToTranscript(context.messages, opts)
  ↓                                   ┌──────────────────────────────────┐
  ├─→ historic JSONL entries:         │  - All pi messages strictly      │
  │      [user1, asst1, …,            │    before the last user-side run │
  │       user_tool_result1,          │  - PLUS trailing tool_results    │
  │       …,                          │    that pair with the last       │
  │       SYNTH_ASSISTANT_MARKER]     │    historic assistant's tool_use │
  │                                   │  - PLUS one synth_asst marker    │
  │                                   └──────────────────────────────────┘
  └─→ newUserContent:
         User-side blocks (text from pi, OR tool_results that DON'T
         pair with any historic assistant tool_use — usually empty
         for tool-result-only continuation turns).

SessionStore.load(key) returns the historic entries.
SDK materializes them to a temp jsonl.
Subprocess loads, runs normalizer: orphan-prune skipped (all tool_uses
paired), Xg5 sees synth_asst as last → no injection.
```

## Key non-obvious choices

### Why split historic vs new prompt differently from before

The original `piToTranscript` split was: "everything up to last assistant in historic; everything after in new prompt." The new split: "everything up to last assistant PLUS trailing tool_results that pair with the last assistant's tool_use in historic; everything else (typically empty for tool-result-only turns) in new prompt."

This ensures every assistant tool_use on disk has its matching tool_result on disk → `iO6` doesn't orphan-prune the assistant turn.

### Why "No response requested." specifically as the synth marker text

That exact string is the binary's own `TGH` constant. The binary synthesizes this text when it spliced its own placeholder assistant turn during interrupted-CLI recovery. By using the same wording, we're mimicking the binary's own output — the model has presumably seen this pattern in training data.

### Why `model: "<synthetic>"` specifically

That's the binary's `jG` constant. Various filters in the binary (e.g. `A7K`, `sR8`) treat assistant messages with `model === "<synthetic>"` differently — they don't count toward usage tracking, they get filtered from certain views, etc. By matching this convention, our marker plays nicely with the binary's existing logic.

### Why we don't need to defang pi's compaction prefix

The earlier reverted commit `6e80c9e` defanged pi's `COMPACTION_SUMMARY_PREFIX`. That's a different bug — model says "Picking back up…" even on text-only conversations when compaction was used, because the compaction summary prefix is byte-identical to Claude Code's own compaction prefix and Opus recognizes it as a resume signal. The synth-asst marker doesn't address that compaction case — it would still need a separate fix if it becomes a priority. For now it's lower priority than the tool-use orphan injection.

## Current status

- **Investigation**: Complete (this writeup + progress_log.md).
- **Probe**: `/tmp/pi-cas-resume-probe/probe-warm-multi-turn.mjs` validates the long-lived-query lifecycle but exposes the canUseTool auto-allow issue that blocks Option B.
- **Fix implementation**: In progress (next step).
- **Tests**: Not yet updated for the new transcript shape.
- **Type check + lint**: Pending fix.

## Failed approaches and dead ends

- **`hook_deferred_tool` attachment**: documented escape via `dG8`. Empirically does NOT fire in SDK resume path. Cause unknown without deeper binary debugging.
- **Long-lived `query()` + `canUseTool: deny+interrupt`**: SDK supports this pattern but the binary auto-allows benign tools without consulting canUseTool, defeating the design.
- **`settingSources: []` + inline empty settings**: doesn't fully suppress the binary's auto-allow path.
- **`tools: [Bash]` + `allowedTools: []`**: makes Bash available without auto-allowing, but the binary's internal auto-classifier still fires for benign commands.
- **`permissionMode: "default"`**: doesn't disable the auto-classifier.
- **Defang compaction prefix**: a different fix for a different bug, reverted earlier; not addressed here.
