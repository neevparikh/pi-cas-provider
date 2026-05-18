# pi-cas-provider

A [pi](https://github.com/earendil-works/pi-coding-agent) extension that registers
a Claude provider routing requests through the
[`@anthropic-ai/claude-agent-sdk`](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk)
instead of calling the Anthropic Messages API directly.

The motivating use case is **[Claude Code fast mode](https://code.claude.com/docs/en/fast-mode)**
on Opus 4.6 / 4.7 — a premium-rate, lower-latency inference path that is only reachable
through Claude Code's settings layer, not the raw Messages API.

> **Anthropic Terms of Service** — Claude Code's OAuth login credentials are scoped to
> Claude Code as a product; routing them through third-party agents (including pi via this
> extension) is **not** intended use. To stay within the TOS, this provider expects your
> Claude Code installation to be authenticated with an **API key** (`ANTHROPIC_API_KEY`,
> Anthropic Console billing). Fast-mode usage is billed under your Anthropic Console
> account just like any other API call. If your `claude` CLI is signed in via
> `/login` (Pro / Max subscription OAuth), do not use this provider with that auth state —
> sign out first or set `ANTHROPIC_API_KEY` in the pi environment to override.

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
- **Pi-native tool execution.** The SDK is configured with `canUseTool: deny` so it
  never executes tools itself; pi runs every tool, just as with any other provider.
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
- The `claude` CLI installed and authenticated **with an API key**
  (`ANTHROPIC_API_KEY`, set on the Anthropic Console)
- An Anthropic org with **extra usage enabled** if you want fast mode
  ([requirements](https://code.claude.com/docs/en/fast-mode#requirements))

## Configuration

All optional. Set as environment variables before launching pi.

| Variable | Effect |
|---|---|
| `PI_CAS_FAST_MODE=1` | Start with fast mode ON (Opus 4.6/4.7 only). Default off. |
| `PI_CAS_CLAUDE_CONFIG_DIR=<path>` | Override the subprocess `CLAUDE_CONFIG_DIR`. Auth + sessions live here instead of `~/.claude`. Useful for isolating pi's Claude Code state from your normal CLI usage. |
| `PI_CAS_API_KEY=sk-ant-...` | Override `ANTHROPIC_API_KEY` for this provider only (e.g., a separate API key from your default). |
| `PI_CAS_DEBUG=1` | Log per-request details (model, history sizes, fast-mode state, cost) to stderr. |
| `CLAUDE_CODE_ENABLE_OPUS_4_7_FAST_MODE=1` | Set automatically by this provider when fast mode is on and the selected model is `claude-opus-4-7`. |

## Slash commands

| Command | Purpose |
|---|---|
| `/cas-auth` | Show auth status, identity, and fast-mode entitlement. |
| `/cas-fast on` / `off` / `status` | Toggle or inspect fast mode for this pi session. |
| `/cas-status` | Show provider configuration and active SDK session count. |

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
- `canUseTool: deny + interrupt` keeps the SDK from executing tools itself; pi
  handles every tool call. A break-early loop on `message_stop` after the first
  `tool_use` prevents the SDK from running a second internal turn that would
  contaminate the assistant message with post-denial text.

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
npm test            # 38 unit tests (transcript + tool-shim)
npm run typecheck   # tsc --noEmit
```

## Acknowledgements

The overall shape (custom Claude provider for pi, break-early tool deferral, and a
shim between Claude Code and pi tool conventions) is heavily inspired by
[rchern/pi-claude-cli](https://github.com/rchern/pi-claude-cli), which routes through
the `claude` CLI as a subprocess instead of through the SDK.

## License

MIT
