import { describe, it, expect } from "vitest";
import { piToTranscript, piContentToAnthropicBlocks, piAssistantBlocksToAnthropic } from "../src/transcript.js";

const OPTS = { cwd: "/tmp/x", sessionId: "11111111-1111-4111-8111-111111111111" };

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

  it("user → assistant: assistant ends history, no new prompt content", () => {
    const msgs = [
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: [{ type: "text", text: "hello back" }],
      },
    ];
    const { transcript, newUserContent } = piToTranscript(msgs as any[], OPTS);
    expect(transcript).toHaveLength(2);
    expect(transcript[0].type).toBe("user");
    expect(transcript[1].type).toBe("assistant");
    expect(newUserContent).toEqual([]);
  });

  it("user → assistant → user: trailing user becomes new prompt", () => {
    const msgs = [
      { role: "user", content: "first" },
      { role: "assistant", content: [{ type: "text", text: "hi" }] },
      { role: "user", content: "second" },
    ];
    const { transcript, newUserContent } = piToTranscript(msgs as any[], OPTS);
    expect(transcript).toHaveLength(2);
    expect(newUserContent).toEqual([{ type: "text", text: "second" }]);
  });

  it("user → assistant(toolCall) → toolResult: tool result is the new prompt", () => {
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
    expect(transcript).toHaveLength(2);
    expect(newUserContent).toEqual([
      {
        type: "tool_result",
        tool_use_id: "tu_1",
        content: "file contents",
        is_error: false,
      },
    ]);
  });
});

describe("transcript entry shape", () => {
  it("parentUuid chain is well-formed", () => {
    const msgs = [
      { role: "user", content: "u1" },
      { role: "assistant", content: [{ type: "text", text: "a1" }] },
      { role: "user", content: "u2" },
      { role: "assistant", content: [{ type: "text", text: "a2" }] },
    ];
    const { transcript } = piToTranscript(msgs as any[], OPTS);
    expect(transcript).toHaveLength(4);
    expect(transcript[0].parentUuid).toBeNull();
    expect(transcript[1].parentUuid).toBe(transcript[0].uuid);
    expect(transcript[2].parentUuid).toBe(transcript[1].uuid);
    expect(transcript[3].parentUuid).toBe(transcript[2].uuid);
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

  it("contiguous tool results merge into one user-role entry", () => {
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
    // user, assistant(2 tool_use), user(2 tool_result merged), assistant
    expect(transcript).toHaveLength(4);
    expect(transcript[2].type).toBe("user");
    const trMsg = transcript[2].message as any;
    expect(Array.isArray(trMsg.content)).toBe(true);
    expect(trMsg.content).toHaveLength(2);
    expect(trMsg.content[0]).toMatchObject({ type: "tool_result", tool_use_id: "tu_1" });
    expect(trMsg.content[1]).toMatchObject({ type: "tool_result", tool_use_id: "tu_2" });
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
