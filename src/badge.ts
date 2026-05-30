/**
 * Fast-mode badge & event broadcasting.
 *
 * Event bus only: `pi:fast-mode` events on `pi.events` carry the badge
 * state so any extension can render it however it wants. pi-vim, for
 * instance, listens and paints the glyph next to its NORMAL/INSERT mode
 * label.
 *
 * We *used to* also draw our own footer status entry (a `setStatus`-keyed
 * ⚡ indicator), but that doubled up with pi-vim's editor-border glyph —
 * the same lightning indicator showing up in two places, in two different
 * fonts/colors — so the footer surface was retired in favor of letting
 * subscribers own all rendering.
 *
 * If nobody subscribes (e.g. pi-vim isn't loaded), no glyph is drawn
 * anywhere — that's intentional. The provider is purely a model proxy.
 *
 * The event name and payload shape are part of the *public* contract for
 * pi-cas-provider — third-party extensions can rely on them.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Public event channel. Other extensions subscribe via `pi.events.on(EVENT, …)`. */
export const EVENT = "pi:fast-mode" as const;

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
 * Broadcasts fast-mode state on `pi.events`. No UI of its own — subscribers
 * (e.g. pi-vim) own all rendering. Single instance per extension load,
 * created in registerProvider().
 */
export class FastModeBadge {
  constructor(private pi: ExtensionAPI) {}

  /**
   * Update the badge state. Call after every meaningful change:
   *  - startup (with intent from config.fastMode)
   *  - `/cas-fast on|off` toggle
   *  - after each turn, with the API-reported `fast_mode_state`
   *
   * Broadcast-only (no-op if nobody is listening), so always safe to call.
   */
  update(next: FastModeEvent): void {
    this.pi.events.emit(EVENT, next);
  }
}
