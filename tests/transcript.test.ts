import { describe, it, expect } from "vitest";
import { piToTranscript, piContentToAnthropicBlocks, piAssistantBlocksToAnthropic } from "../src/transcript.js";

const OPTS = { cwd: "/tmp/x", sessionId: "11111111-1111-4111-8111-111111111111" };

/**
 * Every non-empty transcript ends with a synthetic assistant marker entry
 * with model:"<synthetic>" and text "No response requested.".  See the
 * design note in src/transcript.ts — this marker suppresses the bundled
 * `claude` binary's resume normalizer (Xg5 + TGH splice).
 *
 * Tests use this helper so they document the marker explicitly rather than
 * silently encoding off-by-one expectations.
 */
function expectSynthMarkerAt(transcript: any[], idx: number): void {
  expect(transcript[idx].type).toBe("assistant");
  const msg = transcript[idx].message as any;
  expect(msg.model).toBe("<synthetic>");
  expect(msg.content).toEqual([{ type: "text", text: "No response requested." }]);
}

describe("piToTranscript split rule", () => {
  it("empty history → empty transcript, empty new content", () => {
    const { transcript, newUserContent } = piToTranscript([], OPTS);
    expect(transcript).toEqual([]);
    expect(newUserContent).toEqual([]);
  });

  it("only a user message (first turn) → transcript empty, new content is that user msg", () => {
    const msgs = [{ role: "user", content: "hi" }];
    const { transcript, newUserContent } = piToTranscript(msgs as any[], OPTS);
    expect(transcript).toEqual([]);
    expect(newUserContent).toEqual([{ type: "text", text: "hi" }]);
  });

  it("user → assistant: assistant ends history, no new prompt content, synth marker appended", () => {
    const msgs = [
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: [{ type: "text", text: "hello back" }],
      },
    ];
    const { transcript, newUserContent } = piToTranscript(msgs as any[], OPTS);
    // [user, assistant, synth-marker]
    expect(transcript).toHaveLength(3);
    expect(transcript[0].type).toBe("user");
    expect(transcript[1].type).toBe("assistant");
    expectSynthMarkerAt(transcript, 2);
    expect(newUserContent).toEqual([]);
  });

  it("user → assistant → user: trailing user becomes new prompt (synth marker still added)", () => {
    const msgs = [
      { role: "user", content: "first" },
      { role: "assistant", content: [{ type: "text", text: "hi" }] },
      { role: "user", content: "second" },
    ];
    const { transcript, newUserContent } = piToTranscript(msgs as any[], OPTS);
    // [user, assistant, synth-marker]; trailing user is in newUserContent
    expect(transcript).toHaveLength(3);
    expectSynthMarkerAt(transcript, 2);
    expect(newUserContent).toEqual([{ type: "text", text: "second" }]);
  });

  it("user → assistant(toolCall) → toolResult: paired tool_result folds INTO historic, prompt is empty", () => {
    // This is the case the synth-marker design exists to fix.  In the old
    // shape, the tool_result was in newUserContent and the disk transcript
    // ended in assistant(tool_use) — which triggered the orphan-prune in iO6
    // and the interrupted-turn injection in Xg5.  Now the paired tool_result
    // lives in the historic transcript right after the assistant tool_use,
    // and a synth-marker terminates the buffer with an assistant message.
    const msgs = [
      { role: "user", content: "do a thing" },
      {
        role: "assistant",
        content: [
          { type: "toolCall", id: "tu_1", name: "read", arguments: { path: "/x" } },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "tu_1",
        toolName: "read",
        content: "file contents",
        isError: false,
      },
    ];
    const { transcript, newUserContent } = piToTranscript(msgs as any[], OPTS);
    // [user, assistant(tool_use), user(tool_result), synth-marker]
    expect(transcript).toHaveLength(4);
    expect(transcript[0].type).toBe("user");
    expect(transcript[1].type).toBe("assistant");
    expect(transcript[2].type).toBe("user");
    const trUserMsg = transcript[2].message as any;
    expect(trUserMsg.content).toEqual([
      {
        type: "tool_result",
        tool_use_id: "tu_1",
        content: "file contents",
        is_error: false,
      },
    ]);
    expectSynthMarkerAt(transcript, 3);
    // The genuinely-new user content is empty: no new user text, the
    // tool_result was paired and folded into historic.
    expect(newUserContent).toEqual([]);
  });

  it("user → assistant(toolCall) → toolResult → user(text): paired tool_result folds, trailing user-text is the new prompt", () => {
    // Real-world case: user runs a tool, then immediately types a follow-up
    // question.  The tool_result pairs with the assistant tool_use and goes
    // into historic; the trailing user-text is the new prompt.
    const msgs = [
      { role: "user", content: "do a thing" },
      {
        role: "assistant",
        content: [
          { type: "toolCall", id: "tu_1", name: "read", arguments: { path: "/x" } },
        ],
      },
      { role: "toolResult", toolCallId: "tu_1", toolName: "read", content: "x", isError: false },
      { role: "user", content: "and now do another thing" },
    ];
    const { transcript, newUserContent } = piToTranscript(msgs as any[], OPTS);
    // [user, assistant(tool_use), user(tool_result), synth-marker]
    expect(transcript).toHaveLength(4);
    expectSynthMarkerAt(transcript, 3);
    expect(newUserContent).toEqual([{ type: "text", text: "and now do another thing" }]);
  });

  it("unpaired toolResult (no matching assistant tool_use) stays in newUserContent", () => {
    // Defensive case: if for some reason a trailing toolResult doesn't
    // pair with the last assistant's tool_use, leave it in newUserContent
    // rather than silently folding it into historic.  This shouldn't happen
    // in normal pi flows, but we don't want to corrupt the transcript if it
    // does (the tool_result with a stranger tool_use_id would still confuse
    // the API, but at least we wouldn't lie about the conversation shape).
    const msgs = [
      { role: "user", content: "hi" },
      { role: "assistant", content: [{ type: "text", text: "hello" }] }, // no tool_use
      { role: "toolResult", toolCallId: "tu_unknown", toolName: "read", content: "x", isError: false },
    ];
    const { transcript, newUserContent } = piToTranscript(msgs as any[], OPTS);
    // [user, assistant(text), synth-marker]; unpaired toolResult → newUserContent
    expect(transcript).toHaveLength(3);
    expectSynthMarkerAt(transcript, 2);
    expect(newUserContent).toEqual([
      {
        type: "tool_result",
        tool_use_id: "tu_unknown",
        content: "x",
        is_error: false,
      },
    ]);
  });

  it("multiple parallel tool calls: all paired tool_results fold into historic", () => {
    const msgs = [
      { role: "user", content: "do two things" },
      {
        role: "assistant",
        content: [
          { type: "toolCall", id: "tu_a", name: "read", arguments: { path: "/a" } },
          { type: "toolCall", id: "tu_b", name: "read", arguments: { path: "/b" } },
        ],
      },
      { role: "toolResult", toolCallId: "tu_a", toolName: "read", content: "A", isError: false },
      { role: "toolResult", toolCallId: "tu_b", toolName: "read", content: "B", isError: false },
    ];
    const { transcript, newUserContent } = piToTranscript(msgs as any[], OPTS);
    // [user, assistant(2 tool_use), user(2 tool_result merged), synth-marker]
    expect(transcript).toHaveLength(4);
    expect(transcript[2].type).toBe("user");
    const trUserMsg = transcript[2].message as any;
    expect(trUserMsg.content).toHaveLength(2);
    expect(trUserMsg.content[0]).toMatchObject({ type: "tool_result", tool_use_id: "tu_a" });
    expect(trUserMsg.content[1]).toMatchObject({ type: "tool_result", tool_use_id: "tu_b" });
    expectSynthMarkerAt(transcript, 3);
    expect(newUserContent).toEqual([]);
  });

  it("empty history: no synth marker (nothing to ward off)", () => {
    const { transcript, newUserContent } = piToTranscript([], OPTS);
    expect(transcript).toEqual([]);
    expect(newUserContent).toEqual([]);
  });

  it("first-turn user only: no synth marker (no assistant yet, no orphan risk)", () => {
    const { transcript, newUserContent } = piToTranscript(
      [{ role: "user", content: "hi" }] as any[],
      OPTS,
    );
    expect(transcript).toEqual([]);
    expect(newUserContent).toEqual([{ type: "text", text: "hi" }]);
  });
});

describe("transcript entry shape", () => {
  it("parentUuid chain is well-formed including the synth marker", () => {
    const msgs = [
      { role: "user", content: "u1" },
      { role: "assistant", content: [{ type: "text", text: "a1" }] },
      { role: "user", content: "u2" },
      { role: "assistant", content: [{ type: "text", text: "a2" }] },
    ];
    const { transcript } = piToTranscript(msgs as any[], OPTS);
    // [u1, a1, u2, a2, synth-marker]
    expect(transcript).toHaveLength(5);
    expect(transcript[0].parentUuid).toBeNull();
    expect(transcript[1].parentUuid).toBe(transcript[0].uuid);
    expect(transcript[2].parentUuid).toBe(transcript[1].uuid);
    expect(transcript[3].parentUuid).toBe(transcript[2].uuid);
    expect(transcript[4].parentUuid).toBe(transcript[3].uuid);
    expectSynthMarkerAt(transcript, 4);
  });

  it("each entry has required Claude Code metadata", () => {
    const msgs: any[] = [
      { role: "user", content: "u1" },
      { role: "assistant", content: [{ type: "text", text: "a1" }] },
    ];
    const { transcript } = piToTranscript(msgs, OPTS);
    for (const e of transcript) {
      expect(e).toMatchObject({
        cwd: "/tmp/x",
        sessionId: OPTS.sessionId,
        version: expect.any(String),
        gitBranch: "",
        isSidechain: false,
        userType: "external",
      });
      expect(typeof e.uuid).toBe("string");
      expect(typeof e.timestamp).toBe("string");
    }
  });

  it("contiguous tool results merge into one user-role entry (mid-history)", () => {
    // Tool results that pair with a NON-last assistant turn still get merged.
    // Here the last assistant turn is text-only, so the trailing case differs
    // from the new "paired-with-LAST-assistant" folding logic.
    const msgs = [
      { role: "user", content: "do two things" },
      {
        role: "assistant",
        content: [
          { type: "toolCall", id: "tu_1", name: "read", arguments: { path: "/a" } },
          { type: "toolCall", id: "tu_2", name: "read", arguments: { path: "/b" } },
        ],
      },
      { role: "toolResult", toolCallId: "tu_1", toolName: "read", content: "A", isError: false },
      { role: "toolResult", toolCallId: "tu_2", toolName: "read", content: "B", isError: false },
      { role: "assistant", content: [{ type: "text", text: "done" }] },
    ];
    const { transcript } = piToTranscript(msgs as any[], OPTS);
    // [user, assistant(2 tool_use), user(2 tool_result merged), assistant(text), synth-marker]
    expect(transcript).toHaveLength(5);
    expect(transcript[2].type).toBe("user");
    const trMsg = transcript[2].message as any;
    expect(Array.isArray(trMsg.content)).toBe(true);
    expect(trMsg.content).toHaveLength(2);
    expect(trMsg.content[0]).toMatchObject({ type: "tool_result", tool_use_id: "tu_1" });
    expect(trMsg.content[1]).toMatchObject({ type: "tool_result", tool_use_id: "tu_2" });
    expect(transcript[3].type).toBe("assistant");
    expectSynthMarkerAt(transcript, 4);
  });
});

describe("content-block translators", () => {
  it("piContentToAnthropicBlocks string → single text block", () => {
    expect(piContentToAnthropicBlocks("hello")).toEqual([
      { type: "text", text: "hello" },
    ]);
  });

  it("piContentToAnthropicBlocks empty string → empty array", () => {
    expect(piContentToAnthropicBlocks("")).toEqual([]);
  });

  it("piContentToAnthropicBlocks image → anthropic image format", () => {
    expect(piContentToAnthropicBlocks([
      { type: "image", data: "abc", mimeType: "image/png" },
    ])).toEqual([{
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "abc" },
    }]);
  });

  it("piAssistantBlocksToAnthropic translates toolCall to tool_use with CC names", () => {
    expect(piAssistantBlocksToAnthropic([
      { type: "text", text: "I'll read it." },
      { type: "toolCall", id: "tu_1", name: "read", arguments: { path: "/x" } },
    ])).toEqual([
      { type: "text", text: "I'll read it." },
      { type: "tool_use", id: "tu_1", name: "Read", input: { file_path: "/x" } },
    ]);
  });

  it("piAssistantBlocksToAnthropic drops thinking blocks from history", () => {
    // Historical thinking can't always carry a valid signature; Anthropic API
    // rejects unsigned thinking blocks. Dropping them is the v0 behavior.
    expect(piAssistantBlocksToAnthropic([
      { type: "text", text: "answer" },
      { type: "thinking", thinking: "hmm", thinkingSignature: "sig_xyz" },
      { type: "toolCall", id: "t1", name: "read", arguments: { path: "/x" } },
    ])).toEqual([
      { type: "text", text: "answer" },
      { type: "tool_use", id: "t1", name: "Read", input: { file_path: "/x" } },
    ]);
  });

  it("piAssistantBlocksToAnthropic truncates content after the last tool_use", () => {
    // When the SDK lets the model emit a post-denial text block after a
    // tool_use, that text becomes confusing in history (it contradicts the
    // tool_result we'll feed back next). Strip it.
    expect(piAssistantBlocksToAnthropic([
      { type: "thinking", thinking: "plan", thinkingSignature: "" },
      { type: "toolCall", id: "t1", name: "read", arguments: { path: "/x" } },
      { type: "thinking", thinking: "post-denial reflection" },
      { type: "text", text: "I can't read that." },
    ])).toEqual([
      { type: "tool_use", id: "t1", name: "Read", input: { file_path: "/x" } },
    ]);
  });

  it("piAssistantBlocksToAnthropic preserves pre-tool-use text", () => {
    expect(piAssistantBlocksToAnthropic([
      { type: "text", text: "Let me read that for you." },
      { type: "toolCall", id: "t1", name: "read", arguments: { path: "/x" } },
    ])).toEqual([
      { type: "text", text: "Let me read that for you." },
      { type: "tool_use", id: "t1", name: "Read", input: { file_path: "/x" } },
    ]);
  });

  it("piAssistantBlocksToAnthropic keeps text-only assistant turns intact", () => {
    // No tool_use → no truncation. Final text stays.
    expect(piAssistantBlocksToAnthropic([
      { type: "text", text: "The answer is 42." },
    ])).toEqual([
      { type: "text", text: "The answer is 42." },
    ]);
  });
});
