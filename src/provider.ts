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
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { piToTranscript } from "./transcript.js";
import { createPiSessionStore } from "./session-store.js";
import { composeSystemPrompt } from "./system-prompt.js";
import { ALLOWED_CC_TOOLS, DISALLOWED_CC_TOOLS } from "./tool-shim.js";
import { mapEffort } from "./effort.js";
import { buildFastModeOptions, modelSupportsFastMode } from "./settings.js";
import { createEventBridge } from "./event-bridge.js";
import { getAuthStatus, formatAuthBanner, formatAuthDetails } from "./auth.js";
import {
  type ProviderConfig,
  createDefaultConfig,
  PROVIDER_ID,
  PROJECT_KEY,
} from "./config.js";

/** Top-level entry called by index.ts. */
export function registerProvider(pi: ExtensionAPI): void {
  // Auth banner
  const auth = getAuthStatus();
  console.error(`[pi-cas] ${formatAuthBanner(auth)}`);

  // Module-level config; slash commands mutate this.
  const config: ProviderConfig = createDefaultConfig();
  if (config.fastMode) {
    console.error("[pi-cas] fast mode enabled at startup (PI_CAS_FAST_MODE)");
  }
  if (config.configDirOverride) {
    console.error(`[pi-cas] CLAUDE_CONFIG_DIR override: ${config.configDirOverride}`);
  }

  // Slash commands
  registerSlashCommands(pi, config);

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

  pi.registerProvider(PROVIDER_ID, {
    name: "Claude (via Agent SDK)",
    baseUrl: PROVIDER_ID,         // unused, but pi requires it
    apiKey: "PI_CAS_UNUSED",      // unused — actual auth via subprocess env
    api: PROVIDER_ID as any,
    models,
    streamSimple: (model, context, options) =>
      streamViaSDK(model, context as Context, options, config),
  });
}

/* ----------------------------- streamSimple ----------------------------- */

function streamViaSDK(
  model: Model<any>,
  context: Context,
  options: SimpleStreamOptions | undefined,
  config: ProviderConfig,
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

    // 4. Build the subprocess env.
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (typeof v === "string") env[k] = v;
    }
    if (config.configDirOverride) env.CLAUDE_CONFIG_DIR = config.configDirOverride;
    if (config.apiKeyOverride) env.ANTHROPIC_API_KEY = config.apiKeyOverride;
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

    // Fast-mode availability warning (one-shot per pi session).
    const fms = bridge.getFastModeState();
    if (DEBUG && fms) {
      console.error(`[pi-cas/debug] fast_mode_state=${fms}, cost=$${bridge.getCost()?.toFixed(4) ?? "?"}`);
    }
    if (fastModeRequested && fms === "off" && !config.fastModeWarned) {
      config.fastModeWarned = true;
      console.warn(
        "[pi-cas] fast mode was requested but the API returned fast_mode_state=off. " +
        "Your org may not have extra-usage enabled — see " +
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

function registerSlashCommands(pi: ExtensionAPI, config: ProviderConfig): void {
  pi.registerCommand("cas-auth", {
    description: "Show pi-cas-provider auth status",
    handler: async (_args: string, ctx: any) => {
      const auth = getAuthStatus();
      const text = formatAuthDetails(auth, {
        configDir: config.configDirOverride,
        apiKeyOverride: !!config.apiKeyOverride,
      });
      await ctx.sendMessage?.({
        customType: "pi-cas/auth",
        content: text,
        display: { kind: "text", text },
      });
    },
  });

  pi.registerCommand("cas-fast", {
    description: "Toggle pi-cas fast mode for this session (on/off/status)",
    handler: async (args: string, ctx: any) => {
      const arg = args.trim().toLowerCase();
      if (arg === "on") {
        config.fastMode = true;
        config.fastModeWarned = false;
      } else if (arg === "off") {
        config.fastMode = false;
        config.fastModeWarned = false;
      } else if (arg && arg !== "status") {
        // ignore unknown argument; treat as status
      }
      const text =
        `pi-cas fast mode: ${config.fastMode ? "ON" : "off"}\n` +
        `  (only takes effect on claude-opus-4-6 / claude-opus-4-7; ` +
        `silently ignored on other models)\n` +
        `  $30/$150 per MTok when active. See /cas-auth for entitlement.`;
      await ctx.sendMessage?.({
        customType: "pi-cas/fast",
        content: text,
        display: { kind: "text", text },
      });
    },
  });

  pi.registerCommand("cas-status", {
    description: "Show pi-cas-provider configuration",
    handler: async (_args: string, ctx: any) => {
      const text = [
        "pi-cas-provider status:",
        `  fast mode:         ${config.fastMode ? "on" : "off"}`,
        `  config dir:        ${config.configDirOverride ?? "(default ~/.claude)"}`,
        `  api key override:  ${config.apiKeyOverride ? "PI_CAS_API_KEY set" : "no"}`,
        `  active SDK sessions: ${config.sdkSessionIds.size}`,
      ].join("\n");
      await ctx.sendMessage?.({
        customType: "pi-cas/status",
        content: text,
        display: { kind: "text", text },
      });
    },
  });
}
