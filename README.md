# pi-cas-provider

A [pi](https://github.com/earendil-works/pi-coding-agent) extension that registers
a Claude provider routing requests through the
[`@anthropic-ai/claude-agent-sdk`](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk)
instead of calling the Anthropic Messages API directly.

The motivating use case is **[Claude Code fast mode](https://code.claude.com/docs/en/fast-mode)**
on Opus 4.6 / 4.7 — a premium-rate, lower-latency inference path that is only reachable
through Claude Code's settings layer, not the raw Messages API.

> **Anthropic Terms of Service — billing mode matters.** Claude Code's auth can land
> you in one of three states; the first two bill at Console / API rates and are
> appropriate for this provider, the third is not:
>
> | Auth state | Billing | OK for this provider? |
> |---|---|---|
> | `ANTHROPIC_API_KEY` env var (Console key) | Anthropic Console / API rates | **Yes** |
> | `claude /login` → Anthropic Console (managed key) | Anthropic Console / API rates | **Yes** |
> | `claude /login` → Claude.ai (Pro / Max / Team subscription) | Your subscription | **No** — those credentials are TOS-scoped to Claude Code as a product |
>
> A fourth path is **okta-relay mode** (`/cas-okta on`): pi-cas asks another
> extension for OAuth-issued credentials before each turn and bypasses local
> Claude Code auth entirely.  See the okta-relay section below; the TOS warning
> doesn't apply when the relay's upstream account is API-billed.
>
> `/cas-auth` classifies your current state explicitly. The provider does not refuse
> to run on subscription auth (it can't — the actual API call happens inside the
> `claude` subprocess), but it warns loudly. To switch off subscription auth, run
> `claude /login` again and pick the **Anthropic Console** option, or set
> `ANTHROPIC_API_KEY` / `PI_CAS_API_KEY` in pi's env.

## What you get

- **Six Claude Code built-in tools.** Bash, Read, Write, Edit, Grep, Glob.
  The SDK runs them natively inside the bundled `claude` subprocess; pi-cas
  registers stub pi tools matching the CC names so pi's agent loop can
  display each tool call and its result, but the actual execution happens
  inside the SDK.  Other CC tools (WebFetch, Agent, NotebookEdit, skill
  activations, etc.) are NOT exposed to the model in this provider.
- **Fast mode opt-in.** A slash command (`/cas-fast on`) or env var
  (`PI_CAS_FAST_MODE=1`) flips fast mode for Opus turns. Fast mode is only
  picked up at SDK-session spawn time, so toggling it mid-session takes
  effect on the next pi session (or when the SDK session is recreated
  e.g. via fork/compact).  The provider warns once per session if you
  request fast mode and the API returns `fast_mode_state: off`.
- **Long-lived `query()` per pi session.** One SDK subprocess lives for
  the whole pi session, with the prompt as an `AsyncIterable<SDKUserMessage>`
  the streamSimple loop enqueues into per turn.  Within a pi process,
  pi-cas does not invoke `--resume`; turn-to-turn history is held in the
  SDK's in-memory state.  Across pi processes, the FIRST query DOES use
  `--resume <id>` to reattach to a persisted SDK session.
- **Stream-aligned segmentation.** Pi sees ONE assistant message per pi
  `streamSimple` call (matching the natural Anthropic message boundary).
  Pi's loop runs stubs to retrieve cached SDK results, then loops
  streamSimple to consume the SDK's continuation message.  See
  `writeups/write_up.md` for the full architecture.
- **Inherits Claude Code auth.** No separate login flow; whatever
  `claude auth status` reports is what this provider uses — unless
  okta-relay mode is on, in which case credentials come from another
  extension on the bus.

## Install

From the GitHub repo:

```bash
pi install git:github.com/neevparikh/pi-cas-provider
```

Or from a local checkout:

```bash
git clone https://github.com/neevparikh/pi-cas-provider.git ~/repos/pi-cas-provider
pi install ~/repos/pi-cas-provider
```

Then in pi, pick a Claude model via `/model` — they appear under the **pi-cas**
provider. If pi's `enabledModels` filter is set, add the specific model you want,
e.g. `pi-cas/claude-opus-4-7`.

### Selecting Opus 4.7 with fast mode

```bash
# one-shot:
PI_CAS_FAST_MODE=1 pi --provider pi-cas --model claude-opus-4-7

# or, inside pi:
/model        # pick pi-cas/claude-opus-4-7
/cas-fast on  # flip fast mode
```

## Requirements

- pi (`@earendil-works/pi-coding-agent`) ≥ 0.70.0
- The `claude` CLI installed and authenticated with **either** a raw
  `ANTHROPIC_API_KEY` **or** `claude /login` → Anthropic Console (managed key).
  Subscription OAuth (Pro/Max) is *not* supported — see the TOS note above.
- An Anthropic org with **extra usage enabled** if you want fast mode
  ([requirements](https://code.claude.com/docs/en/fast-mode#requirements))

## Configuration

All optional. Set as environment variables before launching pi.

| Variable | Effect |
|---|---|
| `PI_CAS_FAST_MODE=1` | Start with fast mode ON (Opus 4.6/4.7 only). Default off. |
| `PI_CAS_CLAUDE_CONFIG_DIR=<path>` | Override the subprocess `CLAUDE_CONFIG_DIR`. Auth + sessions live here instead of `~/.claude`. Useful for isolating pi's Claude Code state from your normal CLI usage. |
| `PI_CAS_API_KEY=sk-ant-...` | Override `ANTHROPIC_API_KEY` for this provider only (e.g., a separate API key from your default). |
| `PI_CAS_BASE_URL=https://...` | Override `ANTHROPIC_BASE_URL` for this provider only. Useful for routing pi-cas through a proxy or alternate endpoint without affecting other Anthropic-using tools. |
| `PI_CAS_HTTP_LOG=/path/to/file.jsonl` | Start a local logging proxy that captures every HTTP request the bundled `claude` subprocess sends, with sensitive headers redacted. Appends JSONL to the given path. See "Debugging requests" below. |
| `PI_CAS_HTTP_LOG_RESPONSES=1` | Also log response bodies (SSE streams), capped at 1 MiB each. Default off because SSE volumes can be large. |
| `PI_CAS_DEBUG=1` | Log per-request details (model, history sizes, fast-mode state, cost) to stderr. |
| `PI_CAS_PERMISSION_MODE=<mode>` | Override the SDK permission mode for the subprocess. Valid: `bypassPermissions` (default), `default`, `acceptEdits`, `plan`. See `/cas-perm` for details. |
| `CLAUDE_CODE_ENABLE_OPUS_4_7_FAST_MODE=1` | Set automatically by this provider when fast mode is on and the selected model is `claude-opus-4-7`. |

## Debugging: capturing the exact requests

When `PI_CAS_HTTP_LOG` is set, pi-cas spins up a tiny HTTP-in / HTTPS-out
logging proxy at startup, points the bundled `claude` subprocess at it, and
appends a JSONL entry per request to the file. Useful for debugging what
pi-cas + the SDK actually send to Anthropic (or to the okta relay).

```sh
PI_CAS_HTTP_LOG=/tmp/pi-cas-http.jsonl \
PI_CAS_HTTP_LOG_RESPONSES=1 \
  pi --provider pi-cas --model claude-opus-4-7
```

The log records, per request:

- timestamp, request id
- method, full upstream URL
- request headers (with `x-api-key`, `authorization`, `anthropic-api-key`,
  `proxy-authorization` redacted — their lengths are preserved for debugging)
- request body (parsed as JSON if `content-type` says so, otherwise raw)
- response status + headers
- response body (when `PI_CAS_HTTP_LOG_RESPONSES=1`; SSE captured up to 1 MiB)

In okta-relay mode, the HTTP-log proxy's upstream is set at SDK-session
spawn time to whatever the relay returned.  If the relay reports a
different baseUrl on a subsequent spawn, a `upstream_changed` entry is
emitted.

Quick analysis with `jq`:

```sh
# Just the request bodies, latest first
jq -r 'select(.type=="request") | .body' < /tmp/pi-cas-http.jsonl | tail -1

# Watch for slow requests
jq -r 'select(.type=="response_end") | "\(.elapsedMs)ms \(.id)"' < /tmp/pi-cas-http.jsonl | sort -n | tail

# Any non-2xx responses
jq -r 'select(.type=="response_start" and .status >= 400)' < /tmp/pi-cas-http.jsonl
```

## Slash commands

| Command | Purpose |
|---|---|
| `/cas-auth` | Show auth status, identity, and fast-mode entitlement. |
| `/cas-fast on` / `off` / `status` | Toggle or inspect fast mode (persisted). |
| `/cas-okta on [provider]` / `off` / `status` | Route the subprocess through an Okta-OAuth relay extension (persisted). See below. |
| `/cas-perm <mode>` / `status` | Set or inspect SDK permission mode (`bypassPermissions`, `default`, `acceptEdits`, `plan`). Persisted; applied live to active sessions. |
| `/cas-perm <mode>` / `status` | Set or inspect SDK permission mode (`bypassPermissions`, `default`, `acceptEdits`, `plan`). Persisted; applied live to active sessions. |
| `/cas-status` | Show provider configuration and active SDK session count. |

## Okta-OAuth relay mode

pi-cas can route the bundled `claude` subprocess through a separate
OAuth-managed relay endpoint instead of using your local Claude Code auth.
This is useful when:

- Your org runs a corporate proxy / middleman in front of `api.anthropic.com`
  that gates Anthropic access behind Okta (or any OIDC) login.
- You want to bypass the Console-managed-key refresh hazard (the
  `Not logged in · Please run /login` failure mode in long pi sessions).
- You want pi-cas billing to flow through the relay's upstream account
  rather than your local Claude Code Console org.

### How it works

When `/cas-okta on` is set, pi-cas asks pi's event bus for a relay endpoint
the FIRST time it spawns an SDK session per pi process (the relay's
credentials are baked into the subprocess env at spawn time):

```
pi-cas emits  →  pi-cas:relay-request   { requestId, preferredProvider? }
responder      ←  pi-cas:relay-response  { requestId, ok, provider, baseUrl, accessToken }
```

The responder is expected to refresh its OAuth token before answering, so
the `accessToken` is good-to-use immediately. pi-cas then sets in the
subprocess env:

- `ANTHROPIC_API_KEY = <accessToken>`     — sent as `x-api-key`
- `ANTHROPIC_BASE_URL = <baseUrl>`
- (unsets `ANTHROPIC_AUTH_TOKEN` / `CLAUDE_CODE_OAUTH_TOKEN` to avoid a
  conflicting `Authorization: Bearer` header)

The contract is provider-neutral. Any extension can implement it.
Current known responders:

- [`pi-hawk-provider`](https://github.com/neevparikh/pi-hawk-provider) — routes
  through METR's middleman with Okta-issued tokens; identifies itself as
  `hawk` on the bus.

### Pinning a responder

If multiple responders might answer, pin one:

```
/cas-okta on hawk     # only the responder identifying as "hawk" wins
/cas-okta on          # first responder wins
/cas-okta off         # back to local Claude Code auth
/cas-okta status      # show current state
```

The pin is persisted to `~/.pi/agent/pi-cas.json` alongside the fast-mode
preference.

### In okta mode

- `/cas-auth` reports the relay state instead of classifying local auth
  (api_key / Console OAuth / subscription). The local `extra usage` flag
  in `~/.claude.json` is irrelevant; fast-mode entitlement lives on the
  relay's upstream org.
- Failures (no responder loaded, responder failed to refresh, etc.)
  produce a clear error on the turn rather than a confusing 401 from
  the subprocess.
- The TOS warning about Pro/Max subscription auth doesn't apply —
  subscription credentials never reach the subprocess in okta mode.

### Implementing a responder

Minimal responder, in any pi extension:

```ts
pi.events.on("pi-cas:relay-request", (raw) => {
  const req = raw as { requestId: string; preferredProvider?: string };
  if (req.preferredProvider && req.preferredProvider !== "my-provider") return;
  void (async () => {
    try {
      const accessToken = await getFreshAccessToken();
      pi.events.emit("pi-cas:relay-response", {
        requestId: req.requestId,
        ok: true,
        provider: "my-provider",
        baseUrl: "https://my-relay.example.com/anthropic",
        accessToken,
      });
    } catch (err) {
      pi.events.emit("pi-cas:relay-response", {
        requestId: req.requestId,
        ok: false,
        provider: "my-provider",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  })();
});
```

## Event bus: `pi-cas:fast-mode`

Pi-cas broadcasts its fast-mode state on pi's inter-extension event bus.
The event bus is the ONLY badge mechanism in the current release — pi-cas
does not draw a footer status entry itself.  Subscribers (e.g. `pi-vim`)
render the badge wherever they own real estate.  If nobody subscribes,
no glyph appears — that's intentional.

**Channel:** `pi-cas:fast-mode`

**Payload:**

```ts
interface FastModeEvent {
  /** What pi-cas will request on the next turn. */
  intent: boolean;
  /** What the API actually engaged on the most recent turn, if known. */
  actual?: "on" | "off" | "cooldown";
  /** Model id from the most recent turn (if any). */
  model?: string;
}
```

**Emission points:**
- Startup (intent only)
- `/cas-fast on|off` toggle (intent + last-known actual)
- After every turn (intent + freshly-reported actual + model)

**Example subscriber** (no hard dependency on pi-cas-provider — if it's not
loaded, the event simply never fires and your badge stays inert):

```ts
pi.events.on("pi-cas:fast-mode", (data) => {
  const { intent, actual } = data as { intent: boolean; actual?: "on" | "off" | "cooldown" };
  // …render your badge however you like…
});
```

[pi-vim](https://github.com/neevparikh/pi-vim) ships a built-in subscriber that
paints the same ⚡ glyph next to its mode label.

## Auth

The provider does not implement login. It inherits from `claude`'s own auth
resolution, in priority order:

1. `ANTHROPIC_API_KEY` env var (recommended for this provider)
2. `apiKeyHelper` script in `<CLAUDE_CONFIG_DIR>/settings.json`
3. OAuth credentials in `<CLAUDE_CONFIG_DIR>/.credentials.json` — **avoid for TOS reasons**
4. Third-party providers (Bedrock / Vertex / Foundry) via their own creds

To switch accounts: configure the new auth source, then `/reload` inside pi.
To verify what the provider is using, run `/cas-auth`.

## Fast mode caveats

Fast mode is **roughly 2x more expensive than standard Opus** (~$30 input /
$150 output per MTok, vs. standard Opus ~$15 / $75). Some sharp edges:

- The provider warns once per session if `fastMode` was requested but the API
  returned `fast_mode_state: off` (org lacks extra-usage entitlement, or model
  doesn't support fast mode).
- `/cas-fast on` only takes effect when the SDK session is (re)spawned
  (next pi process launch, or after fork/compact tears down the long-lived
  query).  Toggling mid-conversation in an existing pi process does NOT
  apply to the current SDK session; the next turn will still use whatever
  mode the session was spawned with.
- Switching `/cas-fast on` and starting a new session re-bills the full
  resumed history at fast-mode rates.  Toggle at session start when possible.
- Only `claude-opus-4-6` and `claude-opus-4-7` support fast mode. On other models
  the setting is silently ignored.

## How it works

For the full design see `writeups/write_up.md`.  The high-level shape:

```
pi session lifetime
─────────────────────────────────────────────────────────────
session_start          (no work — lazy spawn)
                  │
                  ▼
1st streamSimple       spawn query() — long-lived
                          ├─ prompt: AsyncIterable<SDKUserMessage>
                          ├─ tools: [Bash, Read, Write, Edit, Grep, Glob]
                          ├─ permissionMode: bypassPermissions (default)
                          └─ resume: <id> IF prior pi run persisted one
                  │
                  ▼  (enqueue real user msg OR detect phantom toolResults)
consume SDK events     bridge segments one pi assistant message per SDK
                       assistant message_stop; waits for paired tool_results
                       before pushing done(toolUse|stop|length).
                  │
                  ▼  (pi runs stub tools → cached SDK results)
2nd streamSimple       same query() — phantom toolResults detected, no
                       enqueue; provider just consumes the next assistant
                       segment from the same iterator.
                  │
                  ▼
N-th streamSimple      detect model change → query.setModel()
                       detect mode change  → query.setPermissionMode()
                  │
                  ▼
session_shutdown       teardown: wake prompt-iterator gen + interrupt()
                       persist sdk_session_id (for next pi launch to resume)
```

Key points:

- One long-lived SDK subprocess per pi session.
- Tool execution happens INSIDE the SDK.  Pi-cas registers six stub pi
  tools (`Bash`/`Read`/`Write`/`Edit`/`Grep`/`Glob`) whose `execute()`
  retrieves SDK-cached results from a per-session result cache instead
  of running anything.  Pi's UI sees normal tool calls + results.
- One pi `streamSimple` produces one pi assistant message, matching one
  Anthropic assistant message from the SDK.  Multi-turn-with-tools work
  is split across multiple streamSimple calls driven by pi's loop.
- When pi runs a stub tool and produces a `toolResult`, the next
  `streamSimple` recognizes it as a phantom (the SDK already saw the
  real tool_result internally) and does NOT enqueue it to the SDK — it
  just consumes the next SDK assistant message from the persistent
  iterator.
- The persistent iterator pattern is critical: we capture
  `query[Symbol.asyncIterator]()` ONCE at session creation and reuse it
  across every turn.  Using `for await ... break` would close the
  generator after the first turn (`iter.return()` is called on early
  loop exit), preventing subsequent turns from receiving events.

## Status & known issues

### Tested

- 94 unit tests covering tool-result cache, stub tools, event-bridge
  segmentation lifecycle, classification + phantom detection, persistence,
  relay, http-log proxy, and thinking-config helpers.
- Two end-to-end probes against the real `claude` binary + Anthropic API:
  - `probe-stub-tools-full.mjs`: drives the full multi-segment flow
    (tool turn → stub execution → continuation → follow-up question).
  - `probe-stub-tools.mjs` / `probe-stub-tools-edge.mjs`: low-level SDK
    event-timing probes (one tool, parallel tools, error tool_result).
- Long-lived `query()` survives back-to-back turns including tool use;
  no resume injection within a pi process.
- Cross-process resume reattaches to a persisted SDK session id and only
  sends the trailing user message (no double-replay).
- SDK control APIs (`setModel`, `setPermissionMode`, `interrupt`) work
  mid-session.
- Auth inheritance via `ANTHROPIC_API_KEY` (Anthropic Console).

### Known caveats

- **Restricted tool surface.** Only the six CC built-in tools listed above
  are exposed to the model.  No `WebFetch`, `WebSearch`, `Agent`,
  `NotebookEdit`, skills, etc.  If a future CC release introduces new
  default tools, the model loses access to them until pi-cas's
  `SUPPORTED_CC_TOOL_NAMES` is updated.
- **Pi permission UI is bypassed.** With the default
  `permissionMode: "bypassPermissions"`, the SDK runs every tool without
  prompting.  Pi's own approval flow / tool-hook extensions are NOT
  consulted.  Switching to `default` mode via `/cas-perm default` does
  NOT yet forward `can_use_tool` control requests to pi's UI — unsafe
  tool calls would hang.  Real pi-UI integration is deferred.
- **Custom pi tools are not exposed to Claude.** Tools registered via
  `pi.registerTool` by other extensions or pi-extension MCP servers are
  invisible to the model.  Adding them back requires a pi-tools-as-MCP
  bridge; deferred.
- **Pi tool hooks see stubs, not the SDK.** Pi extension `tool_call` /
  `tool_result` hooks see the stub execution, but the actual tool has
  already run inside the SDK by then.  Hooks intended to MODIFY or BLOCK
  tool arguments don't influence the SDK's execution.  The post-execution
  `tool_result` hook IS consulted and can adjust pi's view of the result
  (e.g. isError override).
- **Live session config changes.** `/cas-fast`, `/cas-okta`, and
  `PI_CAS_API_KEY` / `PI_CAS_BASE_URL` env overrides only take effect
  when the SDK session is (re)spawned — not on already-live sessions.
  `/cas-perm` IS applied live via `query.setPermissionMode()`.
- **Cancel latency.** `query.interrupt()` does not propagate into
  in-flight tool handlers; the current tool must complete before the
  model's turn stops.
- **Fork/compact loses model history.** When pi forks or compacts the
  session, pi-cas tears down the long-lived SDK subprocess and the next
  streamSimple spawns fresh with no history.  The SDK's `forkSession +
  resumeSessionAt` could preserve history; deferred to v2.
- **Pollution of `~/.claude/projects/`.** The SDK writes its own JSONL
  transcript per session under Claude Code's default project dir.  Set
  `PI_CAS_CLAUDE_CONFIG_DIR` to isolate.
- **Provider-switch context loss.** If pi has prior conversation from a
  different provider and you switch to pi-cas mid-session, only the
  trailing user message reaches the SDK (the prior context is lost from
  the SDK's view).
- **Fast-mode mid-conversation toggle is expensive** (see Fast mode
  caveats section above).

## Development

```bash
npm install
npm test            # 94 unit tests
npm run typecheck   # tsc --noEmit
```

For end-to-end validation against the real `claude` binary + Anthropic API
(drives the full multi-segment stub-tool flow):

```bash
rm -rf dist-probe && npx tsc --noEmit false --outDir dist-probe \
  --module ESNext --moduleResolution node --target ES2022 \
  --esModuleInterop --skipLibCheck src/*.ts
export ANTHROPIC_API_KEY=$(security find-generic-password -s "Claude Code" -w)
export PI_CAS_BUILD=$PWD/dist-probe
export PI_CAS_STATE_PATH=/tmp/pi-cas-clean-state.json && rm -f $PI_CAS_STATE_PATH
node probe-stub-tools-full.mjs    # full multi-segment e2e
node probe-stub-tools.mjs         # one-tool SDK timing
node probe-stub-tools-edge.mjs    # parallel tools + error result
```

See `writeups/write_up.md` for the architecture overview and design
decisions, `writeups/progress_log.md` for chronological development
history, and `writeups/continuation_context.md` for handoff context.

## Acknowledgements

The overall shape (custom Claude provider for pi) is inspired by
[rchern/pi-claude-cli](https://github.com/rchern/pi-claude-cli), which routes through
the `claude` CLI as a subprocess instead of through the SDK.

## License

MIT
