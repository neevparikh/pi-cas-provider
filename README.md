# pi-cas-provider

A [pi](https://github.com/earendil-works/pi-coding-agent) extension that registers
a Claude provider routing requests through the
[`@anthropic-ai/claude-agent-sdk`](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk)
instead of calling the Anthropic Messages API directly.

The motivating use case is **[Claude Code fast mode](https://code.claude.com/docs/en/fast-mode)**
on Opus 4.6 / 4.7 — a premium-rate, lower-latency inference path that is only reachable
through Claude Code's settings layer, not the raw Messages API.

> **Anthropic Terms of Service — billing mode matters.** Claude Code's `/login`
> can land you in one of two auth states. Only one is appropriate for this provider:
>
> | Auth state | Billing | OK for this provider? |
> |---|---|---|
> | `ANTHROPIC_API_KEY` env var (Console key) | Anthropic Console / API rates | **Yes** |
> | `claude /login` → Anthropic Console (managed key) | Anthropic Console / API rates | **Yes** |
> | `claude /login` → Claude.ai (Pro / Max / Team subscription) | Your subscription | **No** — those credentials are TOS-scoped to Claude Code as a product |
>
> `/cas-auth` classifies your current state explicitly. The provider does not refuse
> to run on subscription auth (it can't — the actual API call happens inside the
> `claude` subprocess), but it warns loudly. To switch off subscription auth, run
> `claude /login` again and pick the **Anthropic Console** option, or set
> `ANTHROPIC_API_KEY` / `PI_CAS_API_KEY` in pi's env.

## What you get

- **Real Claude Code agent semantics.** Tools (Read/Write/Edit/Bash/Grep/Glob), the
  Claude Code system prompt preset behavior, sessions and conversation history all
  flow through the Agent SDK rather than being approximated.
- **Fast mode opt-in.** A slash command (`/cas-fast on`) or env var
  (`PI_CAS_FAST_MODE=1`) flips fast mode for Opus turns. The provider warns once per
  session if you request fast mode and the API returns `fast_mode_state: off` (e.g.,
  if your org doesn't have extra usage enabled).
- **SDK-owned history.** The SDK subprocess maintains its own clean JSONL
  transcript across the session. Pi-cas extracts new user input from pi's
  message list per turn and enqueues into the long-lived prompt iterable;
  the SDK handles everything else (model calls, tool execution, history
  replay across multi-step turns).
- **SDK-native tool execution.** The bundled `claude` subprocess runs all
  built-in tools (Read/Write/Edit/Bash/Grep/Glob/...) directly via
  `permissionMode: "bypassPermissions"`. Pi-cas forwards `tool_use` /
  `tool_result` stream events to pi for display but does NOT dispatch tools
  itself. This eliminates the auto-classifier double-execution race that
  plagued earlier versions, and structurally avoids the "Picking up where I
  left off" resume-normalizer bug.
- **Long-lived `query()` per pi session.** One SDK subprocess lives for the
  whole pi session, with the prompt as an `AsyncIterable<SDKUserMessage>`
  the streamSimple loop enqueues into per turn. No `--resume`, no on-disk
  JSONL replay, no resume normalizer involvement.
- **Inherits Claude Code auth.** No separate login flow; whatever `claude auth status`
  reports is what this provider uses.

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

In okta-relay mode, the proxy follows the relay's URL automatically (the
upstream is swapped per-turn via `setUpstreamBaseUrl`). When the relay
changes, a `upstream_changed` entry is emitted.

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
before each turn:

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

## UI: fast-mode badge

When fast mode is requested, pi-cas displays a `⚡` glyph in pi's footer status
bar via `ctx.ui.setStatus("pi-cas-fast", …)`. The status entry is keyed, so it
stacks safely with any other extension's status text — no single-owner
conflict like `setHeader`/`setFooter`.

The glyph color encodes ground truth:

| Color | Meaning |
|---|---|
| bright (`warning`) | API engaged fast mode on the last turn — billing premium |
| muted | Requested but no turn has completed yet |
| dim | Requested but the API returned `fast_mode_state: off` — not engaged, no premium charge |
| red (`error`) | Cooldown — fast-mode pool depleted |
| (no glyph) | Fast mode is off |

## Event bus: `pi-cas:fast-mode`

The provider also broadcasts its fast-mode state on pi's inter-extension event
bus so other extensions can render their own badge wherever they own real
estate (footer, header, editor border, terminal title, etc.) without touching
pi-cas internals.

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

Fast mode is **~30x more expensive than standard Opus** (~$30 input / $150 output per
MTok, vs. standard Opus ~$15 / $75). Some sharp edges:

- The provider warns once per session if `fastMode` was requested but the API
  returned `fast_mode_state: off` (org lacks extra-usage entitlement, or model
  doesn't support fast mode).
- Switching `/cas-fast on` mid-conversation re-bills the **entire prior context**
  at fast-mode rates. Toggle at session start when possible.
- Only `claude-opus-4-6` and `claude-opus-4-7` support fast mode. On other models
  the setting is silently ignored.

## How it works

```
pi session lifetime
─────────────────────────────────────────────────────────────
session_start          (no work — lazy spawn)
                  │
                  ▼
1st streamSimple       spawn query() — long-lived
                          ├─ prompt: AsyncIterable<SDKUserMessage>
                          ├─ permissionMode: bypassPermissions (default)
                          └─ subprocess holds session state in-memory + JSONL
                  │
                  ▼  (enqueue user message, consume events until `result`)
2nd streamSimple       reuse same query()
                          ├─ detect model change → query.setModel()
                          ├─ detect mode change  → query.setPermissionMode()
                          └─ enqueue user message into same AsyncIterable
                  │
                  ▼
3rd, 4th, ...          (same)
                  │
                  ▼
session_shutdown       teardown: gen.return() + interrupt()
                       persist sdk_session_id (for next pi launch to resume)
```

- One long-lived SDK subprocess per pi session. No `--resume`, no on-disk
  JSONL replay between turns (the SDK still writes a JSONL transcript for
  its own bookkeeping, but pi-cas never round-trips through it during the
  session's lifetime).
- The SDK runs every tool natively (Bash, Read, Write, Edit, Grep, Glob, ...).
  Pi-cas forwards `tool_use` and `tool_result` events to pi for display via
  the streaming protocol; pi does NOT dispatch tools.
- Per-turn user input is extracted from `context.messages.slice(lastSentCount)`,
  reduced to user-role content blocks, and yielded into the long-lived prompt
  iterable. Tool results from pi are ignored (the SDK already saw them
  internally).
- The event-bridge resets its content-block index tracking on every Anthropic
  `message_start` event — necessary because one streamSimple call now spans
  multiple assistant messages when the model uses tools (text+tool_use →
  tool ran → final text are each separate Anthropic messages).
- The persistent iterator pattern is critical: we capture
  `query[Symbol.asyncIterator]()` ONCE at session creation and reuse it
  across every turn. Using `for await ... break` would close the generator
  after the first turn (`iter.return()` is called on early loop exit),
  preventing subsequent turns from receiving events.

## Status & known issues

### Tested

- E2E probe (5 scenarios) against the real `claude` binary + Anthropic API:
  first turn, tool turn, no-op turn, follow-up after tool, post-shutdown
  lazy respawn. All pass.
- Long-lived `query()` survives back-to-back turns including tool use; no
  resume injection because no `--resume` is used during steady-state.
- SDK control APIs (`setModel`, `setPermissionMode`, `interrupt`) work
  mid-session.
- Auth inheritance via `ANTHROPIC_API_KEY` (Anthropic Console).

### Known caveats

- **Pi permission UI is bypassed.** With the default
  `permissionMode: "bypassPermissions"`, the SDK runs every tool without
  prompting. Pi's own approval flow / tool-hook extensions are NOT
  consulted. Switch to `default` mode via `/cas-perm default` if you want
  the SDK's classifier-+-ask path, but be aware that pi-cas currently does
  NOT route the resulting `can_use_tool` control requests to a pi UI, so
  unsafe tool calls will hang. Real pi-UI integration is deferred.
- **Custom pi tools are not exposed to Claude.** The model only sees Claude
  Code's built-in tools. Tools registered via `pi.registerTool` or
  pi-extension MCP servers are invisible. Adding them back requires the
  pi-tools-as-MCP-bridge design (Design 1 in writeups), deferred.
- **Pi tool hooks are not translated.** No `beforeToolCall` /
  `afterToolCall` pi hooks reach the SDK. Could be added later as SDK
  `PreToolUse` hooks; not implemented in v1.
- **Cancel latency.** `query.interrupt()` does not propagate into in-flight
  tool handlers; the current tool must complete before the model's turn
  stops. For long-running built-in tools (e.g. WebFetch) this can delay
  user-initiated cancel by tens of seconds.
- **Fork/compact loses model history.** When pi forks or compacts the
  session, pi-cas tears down the long-lived SDK subprocess and the next
  streamSimple spawns fresh with no history. The SDK's `forkSession +
  resumeSessionAt` support could preserve history; deferred to v2.
- **Pollution of `~/.claude/projects/`.** The SDK writes its own JSONL
  transcript per session under Claude Code's default project dir. Set
  `PI_CAS_CLAUDE_CONFIG_DIR` to isolate.
- **Compaction-summary "Picking back up…" model artifact.** Separate bug
  (different code path, pre-existing). Not addressed by this refactor and
  may or may not still occur with SDK-owned history; needs verification.
- **Thinking blocks from prior assistant turns are dropped** from injected
  history. Anthropic's API requires valid signatures on persisted thinking
  blocks. Each turn produces fresh thinking; this is not user-visible.
- **Fast-mode mid-conversation toggle is expensive** (see caveats above).

## Development

```bash
npm install
npm test            # 44 unit tests (persistence + relay + http-log + thinking)
npm run typecheck   # tsc --noEmit
```

For end-to-end validation against the real `claude` binary + Anthropic API
(builds the project to a local dist dir and drives `streamViaSDK` through 6
scenarios including tool turns, no-ops, and lifecycle teardown):

```bash
rm -rf dist-probe && npx tsc --noEmit false --outDir dist-probe \
  --module ESNext --moduleResolution node --target ES2022 \
  --esModuleInterop --skipLibCheck src/*.ts
ANTHROPIC_API_KEY=$(security find-generic-password -s "Claude Code" -w) \
PI_CAS_BUILD=$PWD/dist-probe \
  node probe-refactor-e2e.mjs
```

## Acknowledgements

The overall shape (custom Claude provider for pi) is inspired by
[rchern/pi-claude-cli](https://github.com/rchern/pi-claude-cli), which routes through
the `claude` CLI as a subprocess instead of through the SDK.

## License

MIT
