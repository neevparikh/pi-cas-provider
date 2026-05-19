/**
 * Top-level provider wiring: registers the pi provider, slash commands, and
 * orchestrates the per-turn streamSimple call through the Agent SDK.
 *
 * Per-turn flow:
 *   1. Split pi history → transcript entries + new user-side content
 *   2. Stand up a one-shot SessionStore around those entries
 *   3. Build SDK options: systemPrompt (replace), allowed/disallowed tools,
 *      canUseTool deny, fastMode + effort, env overrides, sessionStore + resume
 *   4. Iterate query() — feed events into the bridge — push pi events
 *   5. Push final `done` (or `error`) to pi's stream
 */

import { query, type Options } from "@anthropic-ai/claude-agent-sdk";
import {
  getModels,
  createAssistantMessageEventStream,
  type AssistantMessageEventStream,
  type Model,
  type SimpleStreamOptions,
  type Context,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import { piToTranscript } from "./transcript.js";
import { createPiSessionStore } from "./session-store.js";
import { composeSystemPrompt } from "./system-prompt.js";
import { ALLOWED_CC_TOOLS, DISALLOWED_CC_TOOLS } from "./tool-shim.js";
import { mapEffort } from "./effort.js";
import { buildFastModeOptions, modelSupportsFastMode } from "./settings.js";
import { createEventBridge } from "./event-bridge.js";
import { getAuthStatus, formatAuthBanner, formatAuthDetails } from "./auth.js";
import { FastModeBadge } from "./badge.js";
import {
  type ProviderConfig,
  createDefaultConfig,
  PROVIDER_ID,
  PROJECT_KEY,
} from "./config.js";
import { loadState, saveState, statePath } from "./persistence.js";
import { requestRelay, type RelayConfig } from "./relay.js";

/** Top-level entry called by index.ts. */
export function registerProvider(pi: ExtensionAPI): void {
  // Module-level config; slash commands mutate this.
  // We construct config before printing the auth banner so okta mode (read
  // from pi-cas.json) can short-circuit the local-auth classification, which
  // is misleading when the subprocess is going through a relay anyway.
  const config: ProviderConfig = createDefaultConfig();

  const auth = getAuthStatus();
  console.error(
    `[pi-cas] ${formatAuthBanner(auth, {
      okta: { enabled: config.oktaEnabled, provider: config.oktaProvider },
    })}`,
  );
  if (config.fastMode) {
    const env = process.env.PI_CAS_FAST_MODE;
    const source =
      env === "1" || env === "true"
        ? "PI_CAS_FAST_MODE"
        : `persisted preference (${statePath()})`;
    console.error(`[pi-cas] fast mode enabled at startup — source: ${source}`);
  }
  if (config.configDirOverride) {
    console.error(`[pi-cas] CLAUDE_CONFIG_DIR override: ${config.configDirOverride}`);
  }
  if (config.apiKeyOverride) {
    console.error("[pi-cas] ANTHROPIC_API_KEY override active (PI_CAS_API_KEY)");
  }
  if (config.baseUrlOverride) {
    console.error(`[pi-cas] ANTHROPIC_BASE_URL override: ${config.baseUrlOverride}`);
  }
  if (config.oktaEnabled) {
    const who = config.oktaProvider ? `provider=${config.oktaProvider}` : "any responder";
    console.error(
      `[pi-cas] okta relay mode ON (${who}) — bypassing local Claude Code auth, ` +
        `routing subprocess through pi-cas:relay-request responder`,
    );
  }

  // Badge: emits `pi-cas:fast-mode` events + owns the `pi-cas-fast` status
  // entry in the footer. Both surfaces are no-ops for anyone who doesn't
  // subscribe / doesn't render the footer, so this is purely additive.
  const badge = new FastModeBadge(pi);
  // Broadcast initial intent so subscribers can render before the first turn.
  badge.update({ intent: config.fastMode });

  // Slash commands
  registerSlashCommands(pi, config, badge);

  // Provider registration: take pi's Anthropic model catalog and present it
  // under our provider id with our custom streamSimple.
  const models = getModels("anthropic").map((m) => ({
    id: m.id,
    name: m.name,
    reasoning: m.reasoning,
    input: m.input,
    cost: m.cost,
    contextWindow: m.contextWindow,
    maxTokens: m.maxTokens,
  }));

  // Pi treats `apiKey` as an env-var name first, falling back to a literal.
  // Our real auth is whatever the `claude` subprocess uses (API key or Console
  // OAuth), so we don't need a key here — but pi shows "Not logged in" in the
  // footer if the value doesn't resolve. Set the env var to a non-empty
  // sentinel so pi's auth-presence check passes. The value is never used.
  if (!process.env.PI_CAS_UNUSED) {
    process.env.PI_CAS_UNUSED = "managed-by-claude-subprocess";
  }

  pi.registerProvider(PROVIDER_ID, {
    name: "Claude (via Agent SDK)",
    baseUrl: PROVIDER_ID,         // unused, but pi requires it
    apiKey: "PI_CAS_UNUSED",      // satisfies pi's auth-presence check only
    api: PROVIDER_ID as any,
    models,
    streamSimple: (model, context, options) =>
      streamViaSDK(pi, model, context as Context, options, config, badge),
  });
}

/* ----------------------------- streamSimple ----------------------------- */

function streamViaSDK(
  pi: ExtensionAPI,
  model: Model<any>,
  context: Context,
  options: SimpleStreamOptions | undefined,
  config: ProviderConfig,
  badge: FastModeBadge,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();

  // The async pump — fire-and-forget; the returned stream surfaces events to pi.
  void (async () => {
    const DEBUG = process.env.PI_CAS_DEBUG === "1";
    if (DEBUG) {
      console.error(`[pi-cas/debug] streamViaSDK: model=${model.id}, ${context.messages.length} msg(s), systemPrompt=${(context.systemPrompt ?? "").length} chars`);
    }
    const cwd = (options as any)?.cwd ?? process.cwd();

    // 1. Map pi's per-session id → a stable SDK session id we use across turns.
    const piSessionId = (options as any)?.sessionId ?? "default";
    let sdkSessionId = config.sdkSessionIds.get(piSessionId);
    if (!sdkSessionId) {
      sdkSessionId = crypto.randomUUID();
      config.sdkSessionIds.set(piSessionId, sdkSessionId);
    }

    // 2. Build transcript + new prompt content.
    const { transcript, newUserContent } = piToTranscript(context.messages as any[], {
      cwd,
      sessionId: sdkSessionId,
    });
    if (DEBUG) {
      const newCT = newUserContent.map((b: any) => b.type).join(",");
      console.error(`[pi-cas/debug] transcript=${transcript.length} entries, newUserContent=[${newCT}]`);
    }

    // 3. Resolve fast-mode/effort fragments.
    const fastModeRequested = config.fastMode && modelSupportsFastMode(model.id);
    const fastFrag = buildFastModeOptions(fastModeRequested, model.id);

    // 3b. Resolve okta-routed relay endpoint (if enabled). We do this BEFORE
    // building env so we can fail fast with a clear error if the responder
    // is missing or its refresh failed — better than spawning the subprocess
    // and getting a confusing 401 downstream.
    let relay: RelayConfig | undefined;
    if (config.oktaEnabled) {
      try {
        relay = await requestRelay(pi, {
          preferredProvider: config.oktaProvider,
          timeoutMs: 8000,
        });
        config.lastOktaProvider = relay.provider;
        config.lastOktaBaseUrl = relay.baseUrl;
        if (DEBUG) {
          console.error(
            `[pi-cas/debug] okta relay resolved via "${relay.provider}" → ${relay.baseUrl}` +
              ` (token len=${relay.accessToken.length})`,
          );
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const out: any = {
          role: "assistant",
          content: [],
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage: {
            input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "error",
          errorMessage:
            `pi-cas okta mode is on but the relay request failed: ${msg}. ` +
            "Run `/cas-okta off` to disable, or fix the responder " +
            "(`/login <provider>` outside pi).",
          timestamp: Date.now(),
        };
        stream.push({ type: "error", reason: "error", error: out } as any);
        stream.end();
        return;
      }
    }

    // 4. Build the subprocess env.
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (typeof v === "string") env[k] = v;
    }
    if (config.configDirOverride) env.CLAUDE_CONFIG_DIR = config.configDirOverride;
    // Okta relay wins over PI_CAS_API_KEY / PI_CAS_BASE_URL on purpose: if the
    // user explicitly enabled okta mode, that's the auth path they want, and
    // mixing a stale env-var key in would confuse the claude binary.
    if (relay) {
      env.ANTHROPIC_API_KEY = relay.accessToken;
      env.ANTHROPIC_BASE_URL = relay.baseUrl;
      // The bundled claude binary picks up Bearer auth from these and would
      // send both `Authorization: Bearer ...` and `x-api-key: ...`. The relay
      // (e.g. middleman) only accepts x-api-key; sending Authorization
      // alongside causes a 401. Strip them so x-api-key=relay-token is the
      // sole credential.
      delete env.ANTHROPIC_AUTH_TOKEN;
      delete env.CLAUDE_CODE_OAUTH_TOKEN;
    } else {
      if (config.apiKeyOverride) env.ANTHROPIC_API_KEY = config.apiKeyOverride;
      if (config.baseUrlOverride) env.ANTHROPIC_BASE_URL = config.baseUrlOverride;
    }
    if (fastFrag.env) Object.assign(env, fastFrag.env);

    // 5. Hook up abort.
    const abortController = new AbortController();
    if (options?.signal) {
      if (options.signal.aborted) abortController.abort();
      else options.signal.addEventListener("abort", () => abortController.abort(), { once: true });
    }

    // 6. Compose final system prompt (pi's + shim notes).
    const systemPrompt = composeSystemPrompt(context.systemPrompt);

    // 7. Only attach sessionStore + resume when we have history to inject.
    // On the first turn the transcript is empty and `resume`-ing into nothing
    // confuses the SDK (returns error_during_execution).
    const hasHistory = transcript.length > 0;
    const sessionOpts: Partial<Options> = hasHistory
      ? {
          resume: sdkSessionId,
          sessionStore: createPiSessionStore({
            sessionId: sdkSessionId,
            projectKey: PROJECT_KEY,
            entries: transcript as any,
          }) as any,
        }
      : {};

    const sdkOpts: Options = {
      model: model.id,
      systemPrompt,
      settingSources: [],          // do not load Claude Code's own settings
      allowedTools: [...ALLOWED_CC_TOOLS],
      disallowedTools: [...DISALLOWED_CC_TOOLS],
      canUseTool: async () => ({
        behavior: "deny",
        interrupt: true,
        message: "pi executes tools",
      }),
      ...sessionOpts,
      includePartialMessages: true,
      abortController,
      cwd,
      env,
      ...fastFrag.extraArgs ? { extraArgs: fastFrag.extraArgs } : {},
      effort: mapEffort(options?.reasoning),
    };

    const bridge = createEventBridge(stream, model);

    // 8. Prompt generator — yields the new user turn's content.
    async function* promptGen() {
      yield {
        type: "user" as const,
        message: {
          role: "user" as const,
          content: newUserContent.length === 0
            ? ""
            : (newUserContent as any),
        },
        parent_tool_use_id: null,
      };
    }

    try {
      if (DEBUG) console.error(`[pi-cas/debug] calling query() with sessionId=${sdkSessionId}, transcript=${transcript.length} entries, newUserContent=${newUserContent.length} blocks, fastMode=${fastModeRequested}`);
      let toolUseSeen = false;
      for await (const msg of query({ prompt: promptGen(), options: sdkOpts }) as any) {
        if (DEBUG && msg.type === "result" && msg.is_error) {
          console.error(`[pi-cas/debug] error result:`,
            JSON.stringify({ subtype: msg.subtype, result: msg.result }, null, 2));
        }
        bridge.handle(msg);

        if (msg.type === "result") break;

        // Break-early on completed tool_use. After canUseTool denies a tool,
        // the SDK runs a *second* internal turn that emits post-denial text;
        // that text contaminates pi's view of the assistant turn. Stopping at
        // message_stop with a tool_use already in content keeps the turn clean.
        const sseEvent = msg.type === "stream_event" ? (msg.event ?? msg) : null;
        const isMessageStop = sseEvent?.type === "message_stop";
        const hasToolUse = bridge.getOutput().content.some((c) => c.type === "toolCall");
        if (isMessageStop && hasToolUse && !toolUseSeen) {
          toolUseSeen = true;
          if (DEBUG) console.error(`[pi-cas/debug] break-early on tool_use turn`);
          break;
        }
      }
    } catch (err: any) {
      if (DEBUG) console.error(`[pi-cas/debug] query() threw:`, err);
      const output = bridge.getOutput();
      output.stopReason = abortController.signal.aborted ? "aborted" : "error";
      output.errorMessage = err?.message ?? String(err);
      stream.push({ type: "error", reason: output.stopReason, error: output } as any);
      stream.end();
      return;
    }

    // Capture ground-truth fast-mode state for /cas-status to surface.
    const fms = bridge.getFastModeState();
    config.lastModel = model.id;
    if (fms) config.lastFastModeState = fms;
    if (DEBUG && fms) {
      console.error(`[pi-cas/debug] fast_mode_state=${fms}, cost=$${bridge.getCost()?.toFixed(4) ?? "?"}`);
    }
    // Re-broadcast badge state with the just-confirmed `actual`. Dims the
    // footer glyph (and any subscribed extension's UI) if the API refused to
    // engage fast mode despite our request.
    badge.update({
      intent: config.fastMode,
      actual: config.lastFastModeState,
      model: config.lastModel,
    });
    // One-shot warning when we *requested* fast mode and the API authoritatively
    // refused it. Only fires if fms is reported (the API echoed it back) — we
    // don't speculate based on local config.
    if (fastModeRequested && fms === "off" && !config.fastModeWarned) {
      config.fastModeWarned = true;
      console.warn(
        "[pi-cas] fast mode was requested but the API returned fast_mode_state=off. " +
        "Either your org lacks the extra-usage entitlement, or the selected model " +
        `(${model.id}) doesn't support fast mode (Opus 4.6/4.7 only). See ` +
        "https://code.claude.com/docs/en/fast-mode#requirements",
      );
    }

    // Push final done.
    const output = bridge.getOutput();
    const hasToolCalls = output.content.some((c) => c.type === "toolCall");
    const reason: "stop" | "length" | "toolUse" =
      output.stopReason === "toolUse" || hasToolCalls
        ? "toolUse"
        : output.stopReason === "length"
          ? "length"
          : "stop";
    output.stopReason = reason;
    stream.push({ type: "done", reason, message: output } as any);
    stream.end();
  })();

  return stream;
}

/* ----------------------------- slash commands ----------------------------- */

/**
 * Output helper: emit text to the user from a slash command.
 *
 * For short single-line status, `ctx.ui.notify` is ideal (transient banner).
 * For multi-line content we want it to land in the chat scrollback so the user
 * can read and reference it. Pi exposes `pi.sendMessage` for that — sending a
 * `customType` with a `display.kind: "text"` shows the text inline in the
 * session and persists in the transcript.
 *
 * The previous implementation called `ctx.sendMessage?.(...)` which silently
 * no-op'd: `sendMessage` does NOT exist on `ExtensionCommandContext` (only on
 * the top-level `ExtensionAPI`), and the optional-chain hid the missing method.
 */
function emit(pi: ExtensionAPI, ctx: any, customType: string, text: string): void {
  // Short single-line: a notify banner works well.
  if (!text.includes("\n")) {
    ctx.ui.notify(text, "info");
    return;
  }
  // Multi-line: send a custom message into the chat scrollback.
  pi.sendMessage({
    customType,
    content: text,
    display: true,
  });
}

function registerSlashCommands(pi: ExtensionAPI, config: ProviderConfig, badge: FastModeBadge): void {
  pi.registerCommand("cas-auth", {
    description: "Show pi-cas-provider auth status",
    handler: async (_args: string, ctx: any) => {
      const auth = getAuthStatus();
      const text = formatAuthDetails(auth, {
        configDir: config.configDirOverride,
        apiKeyOverride: !!config.apiKeyOverride,
        okta: {
          enabled: config.oktaEnabled,
          provider: config.oktaProvider,
          lastProvider: config.lastOktaProvider,
          lastBaseUrl: config.lastOktaBaseUrl,
        },
      });
      emit(pi, ctx, "pi-cas/auth", text);
    },
  });

  pi.registerCommand("cas-fast", {
    description: "Toggle pi-cas fast mode for this session (on/off/status)",
    getArgumentCompletions: (prefix) => {
      const opts = ["on", "off", "status"];
      const matches = opts.filter((o) => o.startsWith(prefix.toLowerCase()));
      return matches.length ? matches.map((o) => ({ value: o, label: o })) : null;
    },
    handler: async (args: string, ctx: any) => {
      const arg = args.trim().toLowerCase();
      let changed = false;
      if (arg === "on") {
        config.fastMode = true;
        config.fastModeWarned = false;
        changed = true;
      } else if (arg === "off") {
        config.fastMode = false;
        config.fastModeWarned = false;
        changed = true;
      }
      // Persist the new preference so it sticks across sessions. Best-effort:
      // saveState swallows errors, so a read-only home won't break the toggle
      // for the current session. We only write on actual changes to avoid
      // touching the file when `/cas-fast` is used as a read.
      if (changed) {
        saveState({ fastMode: config.fastMode });
        // Reflect the new intent in the badge + event bus immediately. We
        // intentionally don't pass `actual` here: a toggle doesn't change the
        // last-turn ground truth (the next turn will). The badge renderer
        // treats absent `actual` as "unknown / muted".
        badge.update({
          intent: config.fastMode,
          actual: config.fastMode ? config.lastFastModeState : undefined,
          model: config.lastModel,
        });
      }

      // Always emit current state; if changed, lead with the action.
      const heading = changed
        ? `pi-cas fast mode → ${config.fastMode ? "ON" : "off"} (saved)`
        : `pi-cas fast mode: ${config.fastMode ? "ON" : "off"}`;
      // If env var is set, warn that it will override the persisted value on
      // next launch — otherwise users will be confused why /cas-fast off
      // "didn't stick" after a restart.
      const envNote =
        process.env.PI_CAS_FAST_MODE !== undefined
          ? `\n  Note: PI_CAS_FAST_MODE=${process.env.PI_CAS_FAST_MODE} is set; ` +
            `it overrides the saved value on next launch.`
          : "";
      const text =
        `${heading}\n` +
        `  Only takes effect on claude-opus-4-6 / claude-opus-4-7 ` +
        `(silently ignored on other models).\n` +
        `  $30/$150 per MTok when active — ~30x standard Opus pricing.\n` +
        `  Preference persisted to ${statePath()}.\n` +
        `  See /cas-auth for entitlement.${envNote}`;
      emit(pi, ctx, "pi-cas/fast", text);
    },
  });

  pi.registerCommand("cas-okta", {
    description: "Route pi-cas through an Okta-OAuth relay (on/off/status [provider])",
    getArgumentCompletions: (prefix) => {
      const opts = ["on", "off", "status"];
      const matches = opts.filter((o) => o.startsWith(prefix.toLowerCase()));
      return matches.length ? matches.map((o) => ({ value: o, label: o })) : null;
    },
    handler: async (args: string, ctx: any) => {
      // Accept: `on`, `off`, `status`, `on <provider>`, `<provider>` (sugar for `on <provider>`).
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const first = (parts[0] ?? "status").toLowerCase();
      let action: "on" | "off" | "status";
      let provider: string | undefined;
      if (first === "on") {
        action = "on";
        provider = parts[1];
      } else if (first === "off") {
        action = "off";
      } else if (first === "status") {
        action = "status";
      } else {
        // Bare provider name — treat as `on <provider>`. Friendly shortcut.
        action = "on";
        provider = first;
      }

      let changed = false;
      if (action === "on") {
        if (!config.oktaEnabled || config.oktaProvider !== provider) changed = true;
        config.oktaEnabled = true;
        config.oktaProvider = provider;
      } else if (action === "off") {
        if (config.oktaEnabled) changed = true;
        config.oktaEnabled = false;
        // Keep the provider pin so toggling back on remembers it.
      }
      if (changed) {
        saveState({
          okta: {
            enabled: config.oktaEnabled,
            ...(config.oktaProvider ? { provider: config.oktaProvider } : {}),
          },
        });
      }

      const stateLine = config.oktaEnabled
        ? `pi-cas okta relay: ON${
            config.oktaProvider ? ` (provider pinned to "${config.oktaProvider}")` : " (any responder wins)"
          }`
        : "pi-cas okta relay: off";
      const heading = changed ? `→ ${stateLine}` : stateLine;

      const detail: string[] = [heading];
      if (config.oktaEnabled) {
        detail.push(
          "  pi-cas asks pi.events for a relay endpoint before each turn and",
          "  routes the bundled `claude` subprocess through it. Local Claude",
          "  Code auth (api_key / Console managed key) is bypassed.",
        );
        if (config.lastOktaBaseUrl) {
          detail.push(`  last successful relay: ${config.lastOktaProvider} → ${config.lastOktaBaseUrl}`);
        }
      } else {
        detail.push(
          "  pi-cas uses local Claude Code auth (whatever `claude auth status` reports).",
        );
      }
      detail.push(`  Persisted to ${statePath()}.`);
      if (action === "on") {
        detail.push(
          "  Requires a responder extension loaded in pi (e.g. pi-hawk-provider)",
          "  listening on `pi-cas:relay-request`. /cas-status shows the last turn.",
        );
      }

      emit(pi, ctx, "pi-cas/okta", detail.join("\n"));
    },
  });

  pi.registerCommand("cas-status", {
    description: "Show pi-cas-provider configuration and last-turn ground truth",
    handler: async (_args: string, ctx: any) => {
      // Distinguish *intent* (what pi-cas will request) from *reality* (what
      // the API actually returned on the most recent turn). These can diverge:
      // intent=on + reality=off means the API silently downgraded.
      const intent = config.fastMode ? "on" : "off";
      const realityLabel =
        config.lastFastModeState === undefined
          ? "(no request yet this session)"
          : config.lastFastModeState === "on"
            ? `on — confirmed by API on last turn${config.lastModel ? ` (${config.lastModel})` : ""}`
            : config.lastFastModeState === "cooldown"
              ? "cooldown — fast-mode pool depleted, API throttling"
              : `off — API did not engage fast mode on last turn${config.lastModel ? ` (${config.lastModel})` : ""}`;

      const oktaLabel = config.oktaEnabled
        ? `on${config.oktaProvider ? ` (provider=${config.oktaProvider})` : " (any responder)"}`
        : "off";
      const oktaLastLabel = config.lastOktaBaseUrl
        ? `${config.lastOktaProvider ?? "?"} → ${config.lastOktaBaseUrl}`
        : config.oktaEnabled
          ? "(no successful relay turn yet this session)"
          : "—";

      const lines = [
        "pi-cas-provider status:",
        `  fast mode (intent):  ${intent}`,
        `  fast mode (actual):  ${realityLabel}`,
        `  okta relay:          ${oktaLabel}`,
        `  okta last turn:      ${oktaLastLabel}`,
        `  config dir:          ${config.configDirOverride ?? "(default ~/.claude)"}`,
        `  api key override:    ${config.apiKeyOverride ? "PI_CAS_API_KEY set" : "no"}`,
        `  base url override:   ${config.baseUrlOverride ?? "(none — SDK default or ANTHROPIC_BASE_URL)"}`,
        `  active SDK sessions: ${config.sdkSessionIds.size}`,
        `  persisted state:     ${statePath()}`,
      ];

      // Helpful hint when intent and reality disagree. Skip the extra-usage
      // note in okta mode — the local ~/.claude.json entitlement flag is
      // irrelevant when traffic is routed through the relay.
      if (config.fastMode && config.lastFastModeState === "off") {
        lines.push("");
        lines.push("Note: you requested fast mode but the API returned off on the last turn.");
        lines.push("  - On Opus 4.6/4.7? Otherwise the setting is silently ignored.");
        if (!config.oktaEnabled) {
          lines.push("  - Does your org have extra-usage enabled? See /cas-auth.");
        } else {
          lines.push("  - Does the relay have fast-mode entitlement on its upstream Console org?");
        }
      }

      emit(pi, ctx, "pi-cas/status", lines.join("\n"));
    },
  });
}
