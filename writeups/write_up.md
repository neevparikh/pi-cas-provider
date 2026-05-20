# pi-cas-provider — current design

## Project goal

Pi extension that lets pi use Anthropic Claude as a model provider via the
`@anthropic-ai/claude-agent-sdk` (bundled `claude` subprocess).  Adds support
for Claude Code auth, fast mode, Okta-OAuth relay, and per-turn HTTP logging.

## Status

**Stable.**  Stream-aligned-segmentation + stub-tools architecture is the
current shipping design (commit `b42040e`+).  All unit tests pass (77),
both e2e probes pass against the real Anthropic API.

## Architecture

Two layered design decisions, each addressing a distinct problem:

### Layer 1 — Long-lived `query()` per pi session

(Inherited from the earlier Option A refactor — see "Failed approaches"
section for what this replaced.)

- **One** `@anthropic-ai/claude-agent-sdk` `query()` per pi session,
  lazily spawned on first `streamSimple`.
- Prompt is an `AsyncIterable<SDKUserMessage>` that stays open for the
  whole session; each new turn enqueues one user message.
- The SDK runs every tool natively (`permissionMode: "bypassPermissions"`
  by default; configurable via `/cas-perm`).  Pi-cas never invokes
  `--resume`, so the bundled `claude` binary's resume normalizer (the
  source of the original "Picking up where I left off…" bug) is never
  engaged.

### Layer 2 — Stream-aligned segmentation + stub tools

(The current refactor — solves the Option A regression.)

**Problem.**  The SDK's `query()` runs a multi-message turn internally:
assistant (text+tool_use) → SDK runs tool → assistant (more text/tools) →
... → assistant (end_turn).  Option A naively accumulated all of these
into a single pi `done`, but pi's agent loop
(`pi-agent-core/agent-loop.js:113-117`) unconditionally executes every
`toolCall` block in an assistant message.  Pi's tool registry has lowercase
names (`bash`, `read`, …); the SDK emits Claude Code's PascalCase names
(`Bash`, `Read`, …).  Result: `Tool Bash not found` errors on every tool
turn.

**Solution.**  Break per SDK assistant message, not per turn.

- The event bridge (`src/event-bridge.ts`) keeps a per-session state
  machine that closes ONE pi `done` per SDK `message_stop` (+ all paired
  `tool_result` SDKUserMessage events).
- For each CC built-in tool exposed to the model
  (`SUPPORTED_CC_TOOL_NAMES = [Bash, Read, Write, Edit, Grep, Glob]`),
  pi-cas registers a *stub* pi tool of the same name
  (`src/stub-tools.ts`).  When pi's agent loop "executes" the stub, it
  just retrieves the SDK's already-cached result from
  `src/tool-result-cache.ts` — instant, no side effects, no double
  execution.
- When pi calls `streamSimple` back with the resulting `toolResult`s
  (which originate from our stubs, not real pi-side execution), the
  provider's `classifyNewContent` detects them as "phantom" (every
  `toolCallId` matches an id we just emitted) and DOES NOT enqueue them
  to the SDK — it just consumes the next SDK assistant message from the
  persistent iterator.
- An `is_error` flag from the SDK's tool_result propagates to pi's
  `ToolResultMessage.isError` via a registered `tool_result` extension
  event handler (since `AgentTool.execute()` has no `isError` return
  field — pi infers isError from whether execute throws).

**Empirical foundation.**  Validated by two SDK timing probes
(`probe-stub-tools.mjs`, `probe-stub-tools-edge.mjs`) which confirmed:
- `user(tool_result)` events arrive AFTER `content_block_stop` of their
  `tool_use` and BEFORE the next `message_start`.
- Parallel tool calls produce parallel tool_results, all arriving in the
  same gap before the next assistant message.
- Errors come through as `is_error: true` with text content; no crashes,
  no retries.
- `SDKUserMessage.tool_use_result` carries `{stdout, stderr, interrupted,
  isImage, noOutputExpected}` for Bash successes and an error string for
  failures.  We pass this through to pi's `ToolResultMessage.details`.

**Per-segment flow:**
1. Resolve PiSession (lazy spawn).
2. Detect mid-session `model` / `permissionMode` changes; apply.
3. `classifyNewContent` decides: `real` (enqueue), `phantom` (skip
   enqueue, just consume next segment), or `empty` (push empty done).
4. Bridge attaches the new pi stream.
5. Consume SDK events until segment ready OR turn done.
6. Bridge pushes `done(toolUse|stop|length)` and ends the pi stream.
7. If segment ended on `end_turn` / `max_tokens`, drain the SDK's
   `result` event off the iterator and call `bridge.resetTurn()` to
   rearm for the next turn.

## Non-obvious design decisions

- **Why we don't strip toolCalls before `done`.**  We considered it (it's
  the simplest fix) but pi loses tool-call rendering entirely — the user
  doesn't see what the agent did.  Stub tools restore native rendering.

- **Why we don't use `canUseTool: deny+interrupt`.**  See "Failed
  approaches" below.  Brief version: the SDK records every denial as a
  synthetic `is_error` tool_result in its session JSONL.  On the next API
  call the model would see BOTH that synthetic denial AND our real
  injection of the same `tool_use_id` — API rejects, model confused.

- **Why `tools: [Bash, Read, Write, Edit, Grep, Glob]` and not full CC
  preset.**  The model can only emit tools we have stubs for.  By
  restricting the SDK's `tools` to exactly our supported set, we ensure
  pi's agent loop never encounters an unstubbed tool name (which would
  fail with `Tool <name> not found`).  Adding more CC tools requires
  adding both a stub and listing the name in `SUPPORTED_CC_TOOL_NAMES`.

- **Stubs use loose TypeBox schemas (`additionalProperties: true`).**
  The SDK already validates args against the real CC schemas; the stub
  re-validating would only add friction (and lockstep maintenance burden
  if CC's schemas drift).  Pi's `prepareArguments` accepts anything.

- **Cache is one-shot (`take()` removes the entry).**  Pi's agent loop
  executes each tool call exactly once.  One-shot semantics avoid
  unbounded memory growth in long-running sessions.

- **Why `_piCasIsError` in `details` instead of throwing.**  Pi's
  `AgentTool.execute` contract says "throw on failure".  But throwing
  uses `error.message` as the content, losing the SDK's structured
  details (stdout/stderr/etc).  We register a `tool_result` event
  handler that reads the `_piCasIsError` flag from details and overrides
  `isError` post-execution.  Content + details are preserved.

- **Phantom detection key = `toolCallId`.**  Top-level
  `ToolResultMessage` blocks carry `toolCallId`; embedded tool_result
  blocks carry `toolCallId` or `tool_use_id`.  We accept both shapes for
  forward compatibility with future pi versions.

- **`bridge.resetTurn()` between turns.**  The `turnDone` flag and the
  state set by `result`-event handling persist across `closeSegment`
  intentionally — so the provider can drain `result` before returning.
  After drain, `resetTurn()` clears these so the next turn doesn't see
  stale `turnDone=true`.

## Module map

```
src/
  provider.ts             — top-level streamViaSDK; PiSession lifecycle;
                            phantom detection (classifyNewContent);
                            multi-segment consume loop.
  event-bridge.ts         — stream-aligned bridge.  attachStream / handle /
                            isSegmentReady / closeSegment / resetTurn.
                            Tracks pendingToolUseIds; gates segment-close
                            on pairing.
  stub-tools.ts           — six CC ToolDefinitions registered with pi.
                            execute() looks up cached result.
  tool-result-cache.ts    — module-singleton Map<tool_use_id, CachedToolResult>.
  system-prompt.ts        — provider-managed system-prompt block telling
                            the model to use CC tool names (since pi's
                            prompt may reference pi's lowercase names).
  config.ts, persistence.ts, settings.ts, effort.ts, thinking.ts,
  auth.ts, badge.ts, relay.ts, http-log-proxy.ts
                          — supporting modules, mostly unchanged from
                            Option A.

probe-stub-tools.mjs       — SDK event timing probe (basic case).
probe-stub-tools-edge.mjs  — parallel tools + error tool_result probe.
probe-stub-tools-full.mjs  — full multi-segment e2e: drives the stub-tool
                             execution path and asserts segment-by-segment
                             behavior.
probe-refactor-e2e.mjs     — broader provider-surface validation (gitignored;
                             local probe).

tests/                     — vitest suites for each module:
                             tool-result-cache, stub-tools, event-bridge,
                             classify-new-content, persistence, relay,
                             http-log-proxy, thinking.
```

## Known limitations

1. **No pi UI for tool permission prompts.**  `permissionMode:
   bypassPermissions` skips all permission checks.  `default` would route
   through the SDK's auto-classifier/prompt mechanism but pi-cas doesn't
   forward `can_use_tool` requests to pi's UI — unsafe tools could hang.
2. **No pi custom tools / extension MCP servers.**  Only the six CC tools
   in `SUPPORTED_CC_TOOL_NAMES` are exposed to the model.  Pi extensions
   that register their own tools aren't visible to the SDK and so the
   model can't call them.  Would require an MCP bridge.
3. **No pi tool-hook translation.**  Pi extension tool_call hooks see
   the stub call; the cached result has already been produced.  In
   practice this means hooks intended to MODIFY or BLOCK tool arguments
   don't influence the SDK's actual execution.  The current `tool_result`
   handler is post-execution and side-effect-free, which is fine.
4. **Cancel latency.**  `query.interrupt()` waits for the SDK's current
   tool handler to complete.
5. **Fork/compact loses model history.**  Tear-down-and-respawn for v1.
   SDK's `forkSession + resumeSessionAt` could preserve history; deferred.
6. **Unknown SDK tool emits would crash pi.**  We rely on
   `tools: [...SUPPORTED_CC_TOOL_NAMES]` in SDK opts to constrain the
   model.  If the SDK ever emits a tool not in that list (e.g. via skill
   activation), pi fails with `Tool <name> not found`.  Adding a
   defensive catch-all stub in event-bridge could mitigate.

## Failed approaches (preserved for context)

### 1. Pre-Option-A: per-turn `query()` + transcript synthesis

Spawned a fresh `query()` per turn with `--resume`, fed a synthesized
JSONL transcript via `SessionStore.load()`.  The bundled binary's resume
normalizer (`gG8 → iO6 → Xg5`) repeatedly injected synthetic
`"Continue from where you left off."` / `"No response requested."`
messages, producing "Picking up where I left off…" model output.

Worked after the synth-asst-marker fix (commit `9e784f2`, `9433cc3`,
`1ebc00f`) but was fragile — depended on the exact internal sentinels
of a minified CC binary that could shift on any update.  Replaced by
Option A.

### 2. Option A: long-lived query() + SDK runs tools + pi just displays

The first long-lived-query architecture (commit `a59ed68`).  Assumed pi
would just *display* tool calls without executing them.  This was the
wrong assumption — pi's agent loop unconditionally executes any toolCall
in an assistant message.  Discovered when pi started raising `Tool Bash
not found`.  Replaced by the current stream-aligned-segmentation +
stub-tools design.

### 3. `canUseTool: deny+interrupt` to stop SDK tool execution

Explored as a way to keep Option A's long-lived query but have pi
actually run the tools.  The SDK records every canUseTool denial as a
synthetic `is_error` tool_result in its session JSONL (sdk.d.ts:3242).
On subsequent API calls, the request would include both that synthetic
denial AND any tool_result we inject — same `tool_use_id` duplicated,
which Anthropic API rejects, and the model is confused either way.
Documented as not viable in the Conversation, not implemented.

### 4. `PreToolUse` hook denial

Earlier probe (pre-Option-A, see progress_log.md) showed the PreToolUse
hook fires reliably (unlike canUseTool), but its denial mechanism has
the same duplicate `tool_use_id` problem on the next API call.

## Open paths

1. **Pi permission UI.**  Add a `can_use_tool` control_request handler
   that forwards to pi's notification/confirm UI; make `default`
   permissionMode usable.
2. **Pi custom tools via MCP.**  Mirror pi's registered tools into an
   in-process MCP server so the model can call them.  Would let pi
   extensions add their own model-visible tools.
3. **Fork-with-history.**  Wire SDK's `forkSession + resumeSessionAt`
   into the `session_before_fork` handler.  Already validated at the SDK
   level by the earlier `probe-sdk-runs-fork.mjs`.
4. **Defensive catch-all stub.**  Register a fallback `*` tool (if pi
   supports it) so unknown CC tool names degrade gracefully instead of
   crashing pi.
5. **Tool argument modification via pre-execution hooks.**  Currently
   pi's `tool_call` extension event has no effect on the SDK's actual
   execution.  Wiring this would require canUseTool + JSON-edit
   semantics — not free.
