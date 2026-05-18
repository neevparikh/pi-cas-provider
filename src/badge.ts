/**
 * Fast-mode badge & event broadcasting.
 *
 * Two surfaces, both safe in isolation:
 *
 *   1. Footer status: a keyed `setStatus("pi-cas-fast", …)` indicator that
 *      shows a ⚡ glyph whenever fast mode is requested. If the API has
 *      authoritatively reported `fast_mode_state: off` on the most recent
 *      turn, the glyph is dimmed to signal "intended but not honored".
 *      `setStatus` is keyed so this stacks safely with any other extension's
 *      status entries — no single-owner conflict like setHeader/setFooter.
 *
 *   2. Event bus: `pi-cas:fast-mode` events on `pi.events` carry the same
 *      info so any other extension can render its own badge (or do something
 *      else entirely — e.g. log it). pi-vim, for instance, listens and paints
 *      the glyph next to its NORMAL/INSERT mode label.
 *
 * Both surfaces are opt-in for consumers: if pi-cas-provider isn't loaded the
 * status entry simply never appears and the event never fires.
 *
 * The event name and payload shape here are part of the *public* contract for
 * pi-cas-provider — third-party extensions can rely on them.
 */

import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";

/** Public event channel. Other extensions subscribe via `pi.events.on(EVENT, …)`. */
export const EVENT = "pi-cas:fast-mode" as const;

/** Status key used with `ctx.ui.setStatus`. Stable across versions. */
export const STATUS_KEY = "pi-cas-fast" as const;

/** Payload broadcast on the event bus. */
export interface FastModeEvent {
  /** What pi-cas-provider will request on the next turn (config.fastMode). */
  intent: boolean;
  /** What the API actually engaged on the most recent completed turn, if known. */
  actual?: "on" | "off" | "cooldown";
  /** Model id from the most recent completed turn. */
  model?: string;
}

/**
 * Manages the lifetime of the badge: holds the latest ExtensionContext from
 * `session_start`, re-applies status on changes, and broadcasts events.
 *
 * Single instance per extension load, created in registerProvider().
 */
export class FastModeBadge {
  private currentCtx: ExtensionContext | undefined;
  private lastEvent: FastModeEvent = { intent: false };

  constructor(private pi: ExtensionAPI) {
    pi.on("session_start", async (_event, ctx) => {
      this.currentCtx = ctx;
      // Re-apply on every new session — the status registry is per-session.
      this.applyStatus();
    });
  }

  /**
   * Update the badge state. Call after every meaningful change:
   *  - startup (with intent from config.fastMode)
   *  - `/cas-fast on|off` toggle
   *  - after each turn, with the API-reported `fast_mode_state`
   *
   * Idempotent: re-applies the same state cheaply.
   */
  update(next: FastModeEvent): void {
    this.lastEvent = next;
    this.applyStatus();
    // Event bus is broadcast-only (no-op if nobody listening), so always emit.
    this.pi.events.emit(EVENT, next);
  }

  private applyStatus(): void {
    const ctx = this.currentCtx;
    if (!ctx?.hasUI) return;
    ctx.ui.setStatus(STATUS_KEY, renderGlyph(ctx.ui.theme, this.lastEvent));
  }
}

/**
 * Render the glyph for the footer status entry.
 *
 *  - intent off                → undefined (clear the entry)
 *  - intent on, actual on      → bright warning ⚡  (engaged & billing premium)
 *  - intent on, actual off     → dim ⚡            (requested but downgraded)
 *  - intent on, actual unknown → muted ⚡          (requested, no turn yet)
 *  - intent on, actual cooldown→ error-colored ⚡  (pool depleted)
 *
 * Colors are chosen so the indicator is glanceable: bright = real money is
 * being spent, dim = it's not actually engaged so you don't need to worry.
 */
function renderGlyph(theme: Theme, ev: FastModeEvent): string | undefined {
  if (!ev.intent) return undefined;
  const glyph = "⚡";
  switch (ev.actual) {
    case "on":
      return theme.fg("warning", glyph);
    case "off":
      return theme.fg("dim", glyph);
    case "cooldown":
      return theme.fg("error", glyph);
    case undefined:
    default:
      return theme.fg("muted", glyph);
  }
}
