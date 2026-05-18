# pi-cas-provider

A pi extension that registers a Claude Agent SDK provider. Routes pi's LLM calls through
[`@anthropic-ai/claude-agent-sdk`](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk)
instead of the raw Anthropic Messages API.

## Why

- **Claude Code auth.** Inherits whatever auth your `claude` CLI is already using —
  `ANTHROPIC_API_KEY`, OAuth subscription, Bedrock, etc.
- **Fast mode.** Opt into Claude Code's
  [premium fast inference](https://code.claude.com/docs/en/fast-mode) on Opus 4.6 / 4.7
  with a slash command.
- **Pi-faithful.** Pi's system prompt, conversation history, tools, and AGENTS.md flow
  through cleanly. No flattened `USER:`/`ASSISTANT:` text history; the SDK sees real
  conversation structure via the alpha `SessionStore` API.

## Install

```bash
cd ~/repos
git clone <this repo>  # or use the path below directly
```

Add to `~/.pi/agent/settings.json`:

```json
{
  "packages": ["file:~/repos/pi-cas-provider"]
}
```

Then in pi, pick a Claude model via `/model` — they appear under the **pi-cas** provider.

## Configuration

All optional. Set as environment variables before launching pi.

| Variable | Effect |
|---|---|
| `PI_CAS_FAST_MODE=1` | Start with fast mode ON (Opus 4.6/4.7 only). Default off. |
| `PI_CAS_CLAUDE_CONFIG_DIR=<path>` | Override the subprocess `CLAUDE_CONFIG_DIR` (auth + sessions live here instead of `~/.claude`). |
| `PI_CAS_API_KEY=sk-ant-...` | Override `ANTHROPIC_API_KEY` for this provider only (e.g., separate from your default). |
| `PI_CAS_DEBUG=1` | Log per-request details (model, history sizes, fast-mode state, cost) to stderr. |
| `CLAUDE_CODE_ENABLE_OPUS_4_7_FAST_MODE=1` | Set automatically by this provider when fast mode + Opus 4.7. |

## Slash commands

- `/cas-auth` — show auth status, identity, fast-mode entitlement
- `/cas-fast on` — enable fast mode for this session
- `/cas-fast off` — disable fast mode
- `/cas-fast` (or `/cas-fast status`) — show current state
- `/cas-status` — show provider config

## Auth

The provider does not implement login. It inherits from `claude`'s own auth resolution:

1. `ANTHROPIC_API_KEY` env var
2. `apiKeyHelper` script in settings
3. OAuth credentials in `<CLAUDE_CONFIG_DIR>/.credentials.json`
4. Third-party providers (Bedrock / Vertex / Foundry) via their own creds

To switch accounts: run `claude /login` outside pi, then `/reload` inside pi.

## Fast mode caveats

Fast mode is ~30x more expensive than standard Opus ($30 / $150 per MTok). The provider
warns once per session if you request fast mode but the API returns `fast_mode_state: off`
(usually because your org doesn't have extra-usage enabled). See
[Fast mode docs](https://code.claude.com/docs/en/fast-mode) for requirements.

Switching fast mode on mid-conversation pays the full uncached input price for the entire
prior context at fast-mode rates. Prefer toggling at the start of a conversation.

## How it works

```
pi → streamSimple(model, context, options)
                  │
                  ▼
        ┌────────────────────────────────────────────┐
        │  pi-cas-provider                           │
        │                                            │
        │  1. split history → transcript + new turn  │
        │  2. SessionStore.load() injects history    │
        │  3. canUseTool deny+interrupt              │
        │  4. shim translates Claude Code tool names │
        │     and arg shapes both directions         │
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

The provider uses the SDK's alpha `SessionStore` API to inject pi's conversation history
as a real Claude Code transcript JSONL — no flattening into `USER:`/`ASSISTANT:` labelled
text. Tool exposure piggybacks on Claude Code's built-in tools (Read/Write/Edit/Bash/Grep/
Glob), with a bidirectional shim handling name and argument differences (e.g., `file_path`
→ `path`, `timeout` ms → s, single-edit `old_string` → `edits` array). Tool-behavior
deltas that can't be losslessly translated are documented in a provider-managed
`<pi-environment>` block appended to the system prompt.

## Status & known issues

### Tested

- **Opus 4.7 + fast mode + tool use: 100/100** runs (parallel batches of 10, 114s wall time).
- Auth inheritance via `ANTHROPIC_API_KEY` (Anthropic Console, METR org with extra-usage enabled).
- Chat (no tools), all models: reliable.

### Known caveats

- **Sonnet flakiness on tool-using turns (~60-80% success).** Pi's system prompt teaches the
  model to call tools by pi's names (`read`, `bash`, etc.) but the SDK exposes them under
  Claude Code's names (`Read`, `Bash`, etc.). A `<pi-environment-override>` block at the end
  of the system prompt resolves this for Opus, but Sonnet sometimes still gives generic
  "is there something I can help with?" responses on the post-tool-result turn. Workaround:
  use Opus for tool-using tasks. Proper fix is to refactor tool exposure to use pi's own
  names via an in-process MCP server (planned for v0.2).
- **`sessionStore` is an alpha SDK API.** Future SDK versions may change the on-disk
  transcript JSONL shape; the empirically-validated shape is captured in `src/transcript.ts`.
  Pinned to `@anthropic-ai/claude-agent-sdk@^0.3.143`.
- **Pollution of `~/.claude/projects/`.** Each pi-cas session creates a transcript file in
  Claude Code's default project dir. Set `PI_CAS_CLAUDE_CONFIG_DIR` to isolate.
- **Custom pi tools (those registered via `pi.registerTool`) are not exposed to Claude.**
  Only the six built-ins (`read`/`write`/`edit`/`bash`/`grep`/`find`) are translated.
  Will be added in v0.2 along with the MCP refactor.
- **Thinking blocks from prior assistant turns are dropped** from injected history. Anthropic
  API requires valid signatures on persisted thinking blocks, which pi doesn't always
  preserve. Each turn produces fresh thinking; this is not visible to the user.
- **Fast-mode mid-conversation toggle is expensive.** Switching `/cas-fast on` after a
  conversation has already accrued context re-bills the entire prior context at
  $30/$150 per MTok. Toggle at session start.

## Development

```bash
npm install
npm test            # 38 unit tests (transcript + tool-shim)
npm run typecheck   # tsc --noEmit
```

## Acknowledgements

The overall shape (custom Claude provider for pi, with break-early tool deferral and shim
between Claude Code and pi tool conventions) is heavily inspired by
[rchern/pi-claude-cli](https://github.com/rchern/pi-claude-cli).

## License

MIT
