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
- **Pi-native history.** Pi's conversation history is materialized as a real Claude
  Code transcript JSONL via the SDK's alpha `SessionStore` API — no flattened
  `USER:` / `ASSISTANT:` text history hack, real `tool_use` / `tool_result` pairings.
- **Pi-native tool execution (best-effort).** The SDK is configured with
  `canUseTool: deny + interrupt` and pi-cas breaks the SDK iterator on the
  first `tool_use` so pi runs the tool, just as with any other provider. (See
  "Known caveats" — the bundled binary's internal auto-classifier silently
  short-circuits canUseTool for tools it deems benign, so pi-cas relies on the
  iterator break-early. Most tools pi cares about are idempotent enough that
  this fragility hasn't been a problem in practice.)
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
pi → streamSimple(model, context, options)
                  │
                  ▼
        ┌────────────────────────────────────────────┐
        │  pi-cas-provider                           │
        │                                            │
        │  1. split history → transcript + new turn  │
        │  2. SessionStore.load() injects transcript │
        │  3. canUseTool: deny + interrupt           │
        │  4. shim translates Claude Code tool       │
        │     names and arg shapes both directions   │
        │  5. fast mode via extraArgs.settings       │
        │                                            │
        └────────────────────────────────────────────┘
                  │
                  ▼
        @anthropic-ai/claude-agent-sdk (query)
                  │
                  ▼
        bundled `claude` subprocess → Anthropic API
```

- Pi's conversation history is materialized as a real Claude Code transcript JSONL
  via the SDK's alpha `SessionStore` API — no flattening into `USER:` / `ASSISTANT:`
  labelled text.
- Tool exposure piggybacks on Claude Code's built-in tools (Read/Write/Edit/Bash/Grep/
  Glob). A bidirectional shim handles name and argument differences (e.g., `file_path` →
  `path`, `timeout` ms → s, `Edit`'s single `old_string` → pi's `edits` array). Tool-
  behavior deltas that can't be losslessly translated are documented in a
  provider-managed `<pi-environment-override>` block appended to pi's system prompt
  before each request.
- `canUseTool: deny + interrupt` is the *intended* mechanism for keeping the SDK
  from executing tools, but the binary's auto-classifier silently bypasses it
  for benign tools (empirically verified across permissionMode variants and
  with clean `CLAUDE_CONFIG_DIR`). Pi-cas instead relies on the iterator-break
  loop on `message_stop` after the first `tool_use` to terminate the subprocess
  before it auto-runs (a race that the subprocess sometimes wins for fast
  tools — see "Known caveats").
- `src/transcript.ts` appends a synthetic assistant marker
  (`model:"<synthetic>"`, text `"No response requested."`) at the end of every
  non-empty historic transcript. This suppresses the bundled binary's resume
  normalizer (orphan-prune + interrupted-turn detection) which would otherwise
  splice in `"Continue from where you left off."` user + `"No response
  requested."` assistant messages, producing the "Picking up where I left off"
  output the model used to open with. See `writeups/write_up.md` for the full
  design and empirical validation.

## Status & known issues

### Tested

- **Opus 4.7 + fast mode + tool use: 100/100** runs (parallel batches of 10,
  114s wall time).
- Chat (no tools), all models: reliable.
- Auth inheritance via `ANTHROPIC_API_KEY` (Anthropic Console).

### Known caveats

- **Sonnet flakiness on tool-using turns (~60-80% success).** Pi's system prompt
  teaches the model to call tools by pi's names (`read`, `bash`, etc.) but the SDK
  exposes them under Claude Code's names (`Read`, `Bash`, etc.). A
  `<pi-environment-override>` block at the end of the system prompt resolves this
  for Opus, but Sonnet sometimes still gives generic "is there something I can help
  with?" responses on the post-tool-result turn. Workaround: use Opus for tool-using
  tasks. Proper fix planned for v0.2 — expose pi's tools by pi's own names via an
  in-process MCP server, eliminating the name conflict.
- **Subprocess sometimes auto-runs tools alongside pi.** The bundled binary's
  internal auto-classifier silently bypasses `canUseTool` for tools it deems
  benign (`echo hello`, `printf`, simple `Read` calls, etc.). Pi-cas's
  iterator-break races to terminate the subprocess before it completes the
  auto-run, but the subprocess does sometimes win and ends up running the tool
  itself — then pi also runs it via its normal flow. For idempotent tools the
  double-execution is invisible; for non-idempotent tools (file writes, network
  calls with side effects) it can be a real issue. Proper fix is part of the
  v0.2 MCP refactor.
- **`~/.claude/settings.json` allow rules leak through `settingSources: []`.**
  If the user has Claude Code permission rules in their global settings, the
  subprocess auto-allows matching tool calls without consulting pi-cas's
  canUseTool. Set `PI_CAS_CLAUDE_CONFIG_DIR` to a clean directory to isolate.
- **`sessionStore` is an alpha SDK API.** Future SDK versions may change the on-disk
  transcript JSONL shape. The empirically validated shape is captured in
  `src/transcript.ts`. Pinned to `@anthropic-ai/claude-agent-sdk@^0.3.143`.
- **Pollution of `~/.claude/projects/`.** Each pi-cas session writes a transcript
  file under Claude Code's default project dir. Set `PI_CAS_CLAUDE_CONFIG_DIR` to
  isolate.
- **Custom pi tools** (those registered via `pi.registerTool`) **are not exposed to
  Claude.** Only the six built-ins (`read` / `write` / `edit` / `bash` / `grep` /
  `find`) are translated. Will be added in v0.2 along with the MCP refactor.
- **Thinking blocks from prior assistant turns are dropped** from injected history.
  Anthropic's API requires valid signatures on persisted thinking blocks, which pi
  doesn't always preserve. Each turn produces fresh thinking; this is not user-visible.
- **Fast-mode mid-conversation toggle is expensive** (see caveats above).

## Development

```bash
npm install
npm test            # 73 unit tests (transcript + tool-shim + relay + …)
npm run typecheck   # tsc --noEmit
```

## Acknowledgements

The overall shape (custom Claude provider for pi, break-early tool deferral, and a
shim between Claude Code and pi tool conventions) is heavily inspired by
[rchern/pi-claude-cli](https://github.com/rchern/pi-claude-cli), which routes through
the `claude` CLI as a subprocess instead of through the SDK.

## License

MIT
