# Subagent investigation

Date: 2026-05-20.  SDK: `@anthropic-ai/claude-agent-sdk` (the version
currently pinned in this repo's `package.json` / `node_modules`).

## Status

**Phase A AND Phase B SHIPPED in the same task as this document.**  See
`writeups/progress_log.md` for the change log.

- `tools: { type: 'preset', preset: 'claude_code' }` is now the SDK
  option (replaces the prior `tools: [...SUPPORTED_CC_TOOL_NAMES]`
  restriction).  The model can use `Task`, `WebFetch`, `WebSearch`,
  `NotebookEdit`, `TodoWrite`, `ExitPlanMode`, MCP tools, etc.
- Bridge captures subagent inner conversation events
  (`parent_tool_use_id != null` typed messages, `system.task_*`)
  into a per-Task `SubagentTranscript` (see
  `src/subagent-transcript.ts`).  Pi's main segment is untouched.
- `forwardSubagentText: true` is set so subagent text/thinking blocks
  arrive as typed messages we can capture (not just the SDK's default
  tool_use/tool_result "heartbeat counter").
- When the parent Task tool_result arrives, the bridge attaches the
  collected transcript to the cache entry under
  `_piCasSubagentTranscript`.
- A custom Task stub (`src/task-stub.ts`) renders the nested
  transcript inline under the parent Task call, modeled on
  [pi-subagent](https://github.com/mariozechner/pi-subagent)'s
  renderer (text/thinking, tool calls via `formatToolCall`, final
  Markdown answer, usage stats).
- Catch-all stub registration is the safety net: any other tool name
  the SDK emits that we didn't pre-register gets a generic stub at
  runtime.

**Remaining future work:**

- Live in-flight progress (currently the transcript renders only
  after the subagent completes — pi's segment-aligned architecture
  holds the segment open until the parent tool_result arrives).
- Recursive nested-subagent expansion (an inner Task within a
  subagent is shown as a tool call but its own transcript isn't
  recursively expanded).

## TL;DR (Phase A + Phase B — shipped)

- Model has full CC tool preset.
- Subagent inner events are captured into per-Task transcripts and
  surfaced in pi via a custom Task stub renderer modeled on
  pi-subagent.
- `forwardSubagentText: true` so we get the subagent's text/thinking,
  not just tool calls.
- Catch-all stub safety net handles any other unanticipated tool
  names.
- Probe at `probe-subagent-events.mjs` to validate behavior against
  the real API (recommended before relying on subagents in production).

## SDK surface area

### How subagents are invoked

CC's Agent tool — exposed to the model under the name `"Task"` (sdk.d.ts:95,
3528, 3550) — accepts `{description, prompt, subagent_type?}` and spawns
a sub-conversation.  The subagent runs to completion (or until its own
`maxTurns` budget is hit) and returns a final response as the Task tool's
`tool_result`.

Two ways subagents become available:

1. **Built-in.**  CC ships built-in subagent definitions (e.g.
   `general-purpose`, `Explore`).  These are available whenever the Agent
   tool is.  `query.supportedAgents()` (sdk.d.ts:2139) returns the
   currently-configured list.

2. **Custom — `agents:` option** (sdk.d.ts:1187-1203, AgentDefinition at
   1038-1092).  Programmatic subagents passed at `query()` construction:
   ```ts
   agents: {
     'code-reviewer': {
       description: 'Reviews code for best practices',
       prompt: 'You are a code reviewer...',
       tools: ['Read', 'Grep', 'Glob'],
       model?: 'sonnet',          // or 'inherit'
       skills?: [...],
       permissionMode?: 'plan',
       background?: false,        // true = fire-and-forget
       memory?: 'user' | 'project' | 'local',
       effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max',
       maxTurns?: 10,
       initialPrompt?: '...',     // auto-submitted first user turn
     }
   }
   ```

### How the model triggers a subagent

The model emits a `tool_use` block named `"Task"` with arguments roughly:
```json
{
  "description": "search for usages of X",
  "prompt": "Find every place that imports …",
  "subagent_type": "Explore"
}
```

(The exact arg schema is owned by CC; we don't need to mirror it because
the SDK validates before pi-cas ever sees the call.)

### Events the SDK emits during a subagent run

Once the SDK accepts a Task tool_use, the subagent runs in its own
sub-conversation.  Relevant SDK events:

| Event | Subtype / shape | Notes |
|---|---|---|
| `system / task_started` (`SDKTaskStartedMessage`, sdk.d.ts:3543) | `{task_id, tool_use_id?, description, subagent_type?, task_type?, workflow_name?, prompt?, skip_transcript?}` | Marks subagent kickoff.  `task_type === 'local_workflow'` is the new Workflow feature, distinct from a regular Task. |
| `system / task_progress` (`SDKTaskProgressMessage`, 3521) | `{task_id, tool_use_id?, description, subagent_type?, usage, last_tool_name?, summary?}` | Periodic heartbeat.  `summary` populated only when `agentProgressSummaries: true` (sdk.d.ts:1587). |
| `system / task_updated` (3567) | `{task_id, patch: {status, description, end_time, total_paused_ms, error, is_backgrounded}}` | Status transitions. |
| `system / task_notification` (3503) | `{task_id, tool_use_id?, status: 'completed'\|'failed'\|'stopped', output_file, summary, usage?, skip_transcript?}` | Subagent finished.  Equivalent to Ctrl+B "task settled" notification.  Backgrounded tasks emit this when they complete. |
| `tool_progress` (3586) | `{tool_use_id, tool_name, parent_tool_use_id, elapsed_time_seconds, task_id?}` | Periodic per-tool elapsed-time pulse for in-flight tools (including inside subagents — `parent_tool_use_id != null`). |
| `assistant` (2490) and `user` (3605) | Standard messages WITH `parent_tool_use_id != null` and `subagent_type` / `task_description` set | The subagent's own conversation.  Only emitted if `forwardSubagentText: true` (default false). |
| Standard `tool_use` / `tool_result` events with `parent_tool_use_id != null` | Always emitted (sdk.d.ts:1424 comment: "By default, only tool_use/tool_result blocks from subagents are emitted") | Used to drive a "heartbeat counter" in default mode. |
| `user(tool_result)` for the parent `Task` block | The subagent's FINAL output, packaged as a tool_result, with `tool_use_id` matching the parent Task tool_use | This is what the model sees as the subagent's "answer". |

### Hooks

Two relevant hook event types (sdk.d.ts:5475-5498):
- `SubagentStart`: fires when a subagent kicks off.  Can return
  `additionalContext` to inject into the subagent's system prompt.
- `SubagentStop`: fires when a subagent finishes.

`BaseHookInput.agent_id` / `agent_type` (sdk.d.ts:128-135) is present on
any hook invocation that fires inside a subagent.

### The `tools:` option vs the Agent tool

Critical interaction with the catch-all stub work (Phase 1):

- The SDK's `tools` option (sdk.d.ts:1264) controls which CC built-in
  tools are exposed to the **main** model.  Subagents have their own
  `tools` setting inside each `AgentDefinition`.
- If we want the main model to spawn subagents, **`Task` must be in the
  main `tools` list** (or we switch to `{type: 'preset', preset:
  'claude_code'}`).
- Each subagent can have its own narrowed toolset (e.g. read-only:
  `['Read', 'Grep', 'Glob']`).

## What pi sees today (Phase A shipped)

Configuration:
```ts
tools: { type: 'preset', preset: 'claude_code' }
```
The model can use the full CC tool preset (Bash/Read/Write/Edit/Grep/Glob
+ Task/WebFetch/WebSearch/NotebookEdit/TodoWrite/ExitPlanMode/MCP).

### What pi sees on a Task call (Phase A — shipped)

Sequence on a turn where the model decides to delegate:

1. Main model emits assistant message with `tool_use{name:"Task", id:T1}`.
   Bridge sees a tool_use name not in `SUPPORTED_CC_TOOL_NAMES`, fires
   `onUnknownToolName("Task")`, provider registers a catch-all stub for
   "Task" with pi mid-segment.
2. Bridge pushes the assistant segment to pi, including the Task
   tool_call.  Pi's UI shows "Task" tool call.
3. SDK runs the subagent internally.  During the run:
   - `task_started`, `task_progress`, `task_updated`,
     `task_notification`, `tool_progress` system messages stream in →
     **explicitly dropped** in `event-bridge.ts handle()`.
   - Typed `assistant` / `user` events with `parent_tool_use_id != null`
     stream in (carrying the subagent's tool_uses/tool_results) →
     **explicitly dropped** before they hit any segment-tracking code.
   - Defensive: if SSE partials for subagent tool_uses leaked in
     (currently SDK doesn't, but the bridge handles it via
     `cleanupLeakedSubagentToolUses` when the typed assistant arrives).
4. Subagent completes → SDK emits a `user(tool_result)` for tool_use id
   `T1` (the parent Task block, `parent_tool_use_id === null`).  Bridge
   ingests this as the final tool_result for the Task call.  Segment
   closes; pi's Task stub retrieves the cached result via the cache;
   user sees "Task → {summary}".
5. Main model continues with the next assistant message based on the
   Task result.

### Bridge changes for Phase A (SHIPPED)

The following design considerations were resolved in the shipped
implementation (see `src/event-bridge.ts handle()`).  They're preserved
here for historical context.

1. **Filter `parent_tool_use_id != null` events** in `event-bridge.ts`:
   - In `handleSseEvent` for `content_block_start/delta/stop`: if the
     `assistant` message that began this content stream had
     `parent_tool_use_id != null`, ignore the content blocks.  (We
     currently don't track this on the stream-event side because we
     don't see it — the SSE event doesn't carry message metadata
     directly.  We see it on the typed `assistant` message that arrives
     after the partial stream.)

   This is tricky.  `stream_event` partials and the typed `assistant`
   event interact: we'd need to defer emitting until we know whether
   the message has `parent_tool_use_id`.

   **Simpler alternative:** filter at the typed-message level
   (`msg.type === "assistant"` and `msg.type === "user"` handlers): if
   `msg.parent_tool_use_id != null`, skip entirely.  Combined with
   continuing to ignore the SSE partials for parent-tool-use messages...

   Hmm — but how do we ignore the SSE partials if we don't know in
   advance?  Two options:
   - (a) **Don't set `includePartialMessages: true` for parent-tool-use
     messages.**  Not configurable per-message in the SDK.
   - (b) **Tag the message_start event with `parent_tool_use_id`.**
     Looking at SDK SSE events, `message_start` carries the BetaMessage
     object — which may include `parent_tool_use_id` on the message
     itself.  Need to verify with a probe.
   - (c) **Buffer SSE partials; gate on the typed `assistant` event**
     deciding to keep or drop.  Significant change to the bridge.

   **Shipped resolution:** option (b) filter at typed-message level,
   plus a defensive cleanup (`cleanupLeakedSubagentToolUses`) that
   removes leaked subagent tool_uses from `pendingToolUseIds` /
   `segmentToolUseIds` / `output.content` when the typed `assistant`
   event arrives.  If the SDK never leaks subagent partials (the
   expected behavior with `forwardSubagentText: false`), the cleanup
   function is a no-op.

2. **Ignore `system/task_*` messages** in `handle()`.  **Shipped:**
   explicit early-return + debug log for `task_started`, `task_progress`,
   `task_updated`, `task_notification`.

3. **`Task` lives in the catch-all path.**  We chose not to add `Task`
   to `SUPPORTED_CC_TOOL_NAMES` — keeping that constant focused on the
   six core file/process tools whose schemas/labels deserve hand-tuned
   stubs.  `Task` (and `WebFetch` / `WebSearch` / `NotebookEdit` / etc.)
   gets a generic catch-all stub.  Tradeoff: generic label/description
   in pi's UI.  Acceptable for v1; can promote any frequently-used tool
   to a named stub later.

4. **System-prompt update.** **Shipped** in `src/system-prompt.ts`:
   lists the full toolset and includes a subagent UX caveat ("the host
   UI shows the parent Task call and its final result, but it does NOT
   yet show the subagent's internal reasoning or tool calls.  Prefer
   subagents for self-contained sub-tasks where a final summary is
   sufficient.").

### Provider changes for Phase A (SHIPPED)

- **`tools` switched** from `[...SUPPORTED_CC_TOOL_NAMES]` to
  `{ type: 'preset', preset: 'claude_code' }` in `src/provider.ts`
  `ensureSession`.
- **`agents:`** option NOT used — relying on built-in subagent
  definitions.  Custom subagent definitions deferred to Phase A.1 if
  there's demand.

### Pi UX (Phase A)

Pi-cas's Task stub returns the SDK-cached final tool_result.  Pi shows
the standard tool-call → tool-result UI.  The user sees:
```
[Task] description="Find foo refs", prompt="..."
       → "I found 12 references in 3 files: ..."
```
Not visible: the subagent's reasoning, its individual tool calls, its
intermediate state.  For most use cases (delegated sub-task with a
summary answer) this is acceptable.

## What pi could see in Phase B (full nested transcript)

If we set `forwardSubagentText: true` (sdk.d.ts:1422-1428), the SDK
emits the subagent's assistant text + thinking blocks as normal
`assistant` events with `parent_tool_use_id`, `subagent_type`,
`task_description` set.

Options for surfacing these in pi:

1. **Inline collapsed.**  Render parent-tool-use messages indented under
   the parent Task tool_call in pi's transcript.  Requires the bridge
   to keep emitting them (rather than filtering) and pi's renderer to
   know how to nest.  Needs pi UI support for nested message rendering.

2. **Side panel via custom pi message type.**  Pi-cas defines a custom
   message type (`pi.sendMessage({customType: "pi-cas:subagent-event",
   ...})`) and renders the subagent transcript in a separate UI surface
   (e.g. a tool detail expander).  No core pi changes needed.

3. **Heartbeat counter (default SDK behavior).**  Don't forward text;
   keep `forwardSubagentText: false`.  The default emission of just
   tool_use/tool_result inside subagents gives us a "subagent did N
   tools" counter.  We can render a progress indicator with the count
   and the `task_progress` summary (when
   `agentProgressSummaries: true`).

Phase B is well-scoped UX work that depends on what pi's renderer can
do and what feels right in the UI.  Recommend revisiting after Phase A
ships and we have real subagent traffic to inform the design.

## What pi would lose / get wrong WITHOUT the bridge filtering (counterfactual)

For posterity, here's what would have broken if we'd added `Task` to
`tools` without the parent_tool_use_id filtering:

- **Subagent inner tool_uses pollute the main segment.**  The bridge
  would treat each inner tool_use as a normal toolCall in the current
  assistant message.  Pi would try to execute these via the catch-all
  stubs.  The cache lookup would still work (the SDK has emitted
  matching tool_results), but pi's UI would render the inner tool
  calls as if they were the main model's own — confusing.
- **`pendingToolUseIds` would include nested ids.**  Segment closure
  waits for them, which is okay because the tool_results arrive too.
  No deadlock; just noise.
- **Phantom-detection on next streamSimple.**  After segment close,
  `recentlyEmittedToolUseIds` would include the nested ids.  When pi's
  loop runs the stubs for ALL the emitted tool_calls (including
  nested), it'd send phantom tool_results back to pi-cas.  The
  classifier would correctly flag them as phantom (matching ids), so
  the SDK never receives them.  Outcome: no crash, but the same noise.
- **No model-quality regression.**  The model still sees its own
  Task tool_result as the answer to the Task call.  The bridge noise
  is a UX/UI bug, not a correctness bug for the conversation.

So Phase A is "safe-ish" to ship with the bridge change.  Without the
bridge change, it's "works but ugly".

## Concrete probe plan (post-ship validation recommended)

Run `probe-subagent-events.mjs` against the real API to validate the
shipped Phase A behavior:

1. Sets `tools: [...SUPPORTED_CC_TOOL_NAMES, "Task"]` and
   `includePartialMessages: true`.
2. Sends a user prompt that nudges the model to delegate, e.g.
   "Use the Explore subagent to look up all files importing typebox."
3. Captures every SDK event with full metadata (`type`, `subtype`,
   `parent_tool_use_id`, `subagent_type`, `task_description`).
4. Verifies:
   - Whether `message_start` SSE events for parent-tool-use messages
     carry `parent_tool_use_id` on the BetaMessage object — answers
     "can we filter at the stream level?"
   - Order of events: do `task_started` precede the first nested
     `assistant` event?  Does `task_notification` arrive before or
     after the parent `Task` tool_result?
   - Whether `forwardSubagentText: false` (default) really omits the
     subagent's `assistant` text events or just suppresses the text
     content blocks within them.

Stub: `probe-subagent-events.mjs` — copy `probe-stub-tools.mjs` as a
starting point, change the prompt, log every message verbatim with
`util.inspect` depth: 5.

Run: see `writeups/continuation_context.md` "How to rebuild and re-run
probes" — same recipe; export `PI_CAS_BUILD=$PWD/dist-probe` and an
`ANTHROPIC_API_KEY`.

## Open questions

1. **`message_start` SSE carrying `parent_tool_use_id`.**  Probe-only
   resolvable.  Determines whether bridge filtering is cheap (filter
   at SSE level) or expensive (buffer + gate on typed message).

2. **Behavior of `tools:` restriction inside subagents.**  When the
   main thread has `tools: ['Bash', 'Read', ..., 'Task']`, does a
   subagent (which has its own `tools` inside `AgentDefinition`)
   inherit the restriction or get the full `claude_code` preset?
   Looking at AgentDefinition.tools (sdk.d.ts:44): "If omitted,
   inherits all tools from parent."  Ambiguous: "all tools" =
   parent's restricted set, or all CC tools?  Probe-only resolvable.

3. **Pi entry-id ↔ SDK message-uuid map.**  Tangentially relevant:
   subagent forwarding would benefit from this map (to scope a
   subagent panel to "the Task call from entry X").  Same bookkeeping
   gap as the fork-with-`upToMessageId` deferral in Phase 2.

4. **Background subagents (`AgentDefinition.background: true`).**
   These return immediately to the main thread and emit
   `task_notification` later.  Pi's UI doesn't have a notion of
   asynchronous background tasks today (I think).  Surfacing them
   probably requires Phase B + custom-message support.

5. **`skip_transcript`.**  `task_started`, `task_progress`,
   `task_notification` can carry `skip_transcript: true` for
   ambient/housekeeping tasks (sdk.d.ts:3561).  These should be
   filtered out of any future panel UI.

## Phase B (future) — nested-transcript rendering

If/when there's demand to show users what the subagent is doing
(reasoning, tool calls, progress):

1. Set `forwardSubagentText: true` in SDK options.
2. Change the bridge filter to ROUTE parent_tool_use_id-tagged events
   to a side channel instead of dropping them.
3. Pick a pi UX:
   - **Inline collapsed** under the parent Task call.  Requires pi
     renderer support for nested message rendering.
   - **Side panel via custom pi message type.**  Pi-cas defines
     `pi.sendMessage({customType: "pi-cas:subagent-event", ...})` and
     renders subagent transcript in a separate UI surface.  No core pi
     changes needed.
   - **Heartbeat counter only.**  Render "Task running: N tool calls,
     last: Bash" without surfacing content.  Easiest; least
     informative.

This is well-scoped follow-up work that depends on pi UI capabilities
and product/UX preferences.

## Recommendation (post-ship)

- Run `probe-subagent-events.mjs` against the real Anthropic API
  before relying on subagents in production usage.  Verify:
  - No SSE partials arrive for subagent messages (validates the no-op
    of `cleanupLeakedSubagentToolUses` in practice).
  - The parent Task tool_result is the only `parent_tool_use_id ===
    null` tool_result that arrives during a subagent run.
  - Event ordering matches our assumptions (`task_started` precedes
    inner events; `task_notification` arrives before or alongside the
    parent `tool_result`).
- Consider adding probes for `WebFetch` / `NotebookEdit` / etc. as
  spot-checks on the catch-all path for non-subagent tools.

## Filing/tracking

- `writeups/write_up.md` "Open paths" should add: "Phase B nested
  subagent rendering" with a pointer to this document.
- `writeups/continuation_context.md` "Deferred hardening": Task-tool
  crash entry was already removed in the catch-all commit; subagent
  Phase B is the remaining future work.
- `README.md` "What you get" and "Known caveats" mention the
  Phase A behavior and point here for Phase B.
