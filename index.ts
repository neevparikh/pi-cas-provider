/**
 * pi-cas-provider entry point.
 *
 * Registers a Claude provider that routes through @anthropic-ai/claude-agent-sdk,
 * letting pi use Claude Code's auth and (optionally) fast mode on Opus.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerProvider } from "./src/provider.js";

export default function (pi: ExtensionAPI): void {
  try {
    registerProvider(pi);
  } catch (err) {
    console.error("[pi-cas] failed to register provider:", err);
  }
}
