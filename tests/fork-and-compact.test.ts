/**
 * Unit tests for fork/compact handling helpers.
 *
 * These exercise the pure-logic pieces of fork preservation and post-compact
 * recovery.  The full lifecycle paths (`session_before_fork` calling the SDK
 * `forkSession()`, `session_before_compact` flagging sessions, and
 * `streamSimple` consuming the pending fork / reseating `lastSentCount`)
 * are integration-level — they require mocking the Agent SDK or driving
 * the full provider — and are covered by manual / probe-level testing.
 *
 * What we DO cover here unit-wise:
 *   - {@link resolveResumeForFreshSession}: precedence rules between a
 *     pending fork and the persisted-resume mapping.
 *   - {@link initialLastSentCount}: the value used to re-seat `lastSentCount`
 *     after compaction.  Already covered indirectly by provider tests; we
 *     pin the behavior explicitly here for the compact-recovery path.
 */

import { describe, it, expect } from "vitest";

import {
  initialLastSentCount,
  resolveResumeForFreshSession,
} from "../src/provider.js";

describe("resolveResumeForFreshSession (fork preservation)", () => {
  it("no pending fork, no persisted id → no resume", () => {
    const r = resolveResumeForFreshSession("pi-new", undefined, undefined);
    expect(r).toEqual({ resumeId: undefined, consumePendingFork: false });
  });

  it("no pending fork, persisted id → resume into persisted (cross-process resume)", () => {
    const r = resolveResumeForFreshSession("pi-A", undefined, "sdk-persisted");
    expect(r).toEqual({ resumeId: "sdk-persisted", consumePendingFork: false });
  });

  it("pending fork from a DIFFERENT pi session → consume the fork (preserve model history)", () => {
    const r = resolveResumeForFreshSession(
      "pi-NEW-branch",
      { sourcePiSessionId: "pi-OLD-source", forkedSdkSessionId: "sdk-forked" },
      undefined,
    );
    expect(r).toEqual({ resumeId: "sdk-forked", consumePendingFork: true });
  });

  it("pending fork takes precedence over a persisted resume id for the new branch", () => {
    // E.g. user previously had a pi session at this id with a recorded
    // mapping (stale).  Then they fork from another session; pi assigns
    // this same id to the new branch.  We should use the FORK, not the
    // stale mapping.
    const r = resolveResumeForFreshSession(
      "pi-X",
      { sourcePiSessionId: "pi-Y", forkedSdkSessionId: "sdk-forked" },
      "sdk-stale-mapping-for-pi-X",
    );
    expect(r).toEqual({ resumeId: "sdk-forked", consumePendingFork: true });
  });

  it("pending fork from the SAME pi session id is NOT consumed (defensive)", () => {
    // Pi shouldn't reuse the source id for the forked branch; if it ever
    // does, we still don't want the source session to eat its own fork
    // stash — that would erase the original's resume mapping.  Fall
    // through to the persisted resume id (or none).
    const r = resolveResumeForFreshSession(
      "pi-SAME",
      { sourcePiSessionId: "pi-SAME", forkedSdkSessionId: "sdk-forked" },
      "sdk-original",
    );
    expect(r).toEqual({ resumeId: "sdk-original", consumePendingFork: false });
  });

  it("documented limitation: single-slot pendingFork, second-fork-wins on double-fork-without-open", () => {
    // Scenario: user forks session A → forks session B → opens A's
    // destination first.  Currently pendingFork has B's data; A's destination
    // resumes into B's SDK fork.  This is a documented limitation
    // (write_up.md "Known limitations" — at least, after this commit).
    //
    // The test pins the actual current behavior so a future refactor that
    // changes it (e.g. to a Map<source, forkedId>) explicitly breaks the
    // test, prompting a docs update.
    let pendingFork:
      | { sourcePiSessionId: string; forkedSdkSessionId: string }
      | undefined;

    pendingFork = { sourcePiSessionId: "pi-A-source", forkedSdkSessionId: "sdk-fork-A" };
    pendingFork = { sourcePiSessionId: "pi-B-source", forkedSdkSessionId: "sdk-fork-B" };
    // Now user opens A's destination first:
    const r = resolveResumeForFreshSession("pi-A-dest", pendingFork, undefined);
    // We consume B's fork, NOT A's.  Bug-ish but a known limitation.
    expect(r).toEqual({ resumeId: "sdk-fork-B", consumePendingFork: true });
  });
});

describe("initialLastSentCount (also: compact-recovery reset target)", () => {
  it("empty message list → 0", () => {
    expect(initialLastSentCount(0)).toBe(0);
  });

  it("single message (just the trailing user prompt) → 0 (everything before it consumed)", () => {
    expect(initialLastSentCount(1)).toBe(0);
  });

  it("N>1 messages → N-1 (only the trailing message is unconsumed)", () => {
    expect(initialLastSentCount(2)).toBe(1);
    expect(initialLastSentCount(5)).toBe(4);
    expect(initialLastSentCount(100)).toBe(99);
  });
});
