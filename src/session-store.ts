/**
 * Custom SessionStore adapter for the Agent SDK.
 *
 * The SDK's `Options.sessionStore` is an alpha API (see @anthropic-ai/claude-agent-sdk
 * types) that mirrors transcript entries to and from an external backend.
 *
 *   load(key)        — called once before subprocess spawn when `resume` is set.
 *                      We return pi's converted history; the SDK materializes it
 *                      to a temp JSONL file and the subprocess resumes from there.
 *   append(key, e)   — the SDK mirrors every transcript-line write to us.
 *                      Pi is the system of record, so we drop these (no-op).
 *   listSessions     — not used by our flow; provided for completeness.
 *
 * Empirically validated: probe 1 in /tmp/pi-cas-probe/probe1-sessionstore.mjs
 * confirms `load()` materialization works as documented.
 */

// We avoid a hard import of the SDK type so this module can be unit-tested
// without pulling in the SDK. The shape mirrors the SDK's `SessionStore`.
export interface SessionKey {
  projectKey: string;
  sessionId: string;
  subpath?: string;
}

export interface SessionStoreEntry {
  type: string;
  uuid?: string;
  timestamp?: string;
  [k: string]: unknown;
}

export interface SessionStoreShape {
  load(key: SessionKey): Promise<SessionStoreEntry[] | null>;
  append(key: SessionKey, entries: SessionStoreEntry[]): Promise<void>;
  listSessions?(projectKey: string): Promise<Array<{ sessionId: string; mtime: number }>>;
}

/**
 * Create a one-shot store keyed on a specific session id. `load()` returns the
 * supplied entries for that id; anything else returns null. `append()` is a
 * no-op sink — we accept and discard the SDK's transcript mirroring.
 */
export function createPiSessionStore(opts: {
  sessionId: string;
  projectKey: string;
  entries: SessionStoreEntry[];
}): SessionStoreShape {
  const { sessionId, projectKey, entries } = opts;
  return {
    async load(key: SessionKey): Promise<SessionStoreEntry[] | null> {
      if (key.sessionId !== sessionId) return null;
      // The SDK may also probe for subagent transcripts — return null for those.
      if (key.subpath) return null;
      return entries;
    },
    async append(_key: SessionKey, _entries: SessionStoreEntry[]): Promise<void> {
      // intentional no-op
    },
    async listSessions(pk: string) {
      return pk === projectKey ? [{ sessionId, mtime: Date.now() }] : [];
    },
  };
}
