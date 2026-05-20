/**
 * Unit tests for classifyNewContent — the function that decides whether a
 * new streamSimple call carries:
 *   - real user input (enqueue to SDK)
 *   - phantom toolResults from pi's stub tools (don't enqueue, just consume
 *     next SDK events)
 *   - nothing at all (push empty done)
 *
 * Phantom detection is the linchpin of the stream-aligned-segmentation
 * architecture — getting it wrong would either send duplicate tool_results
 * to the SDK (API error) or hang pi's loop forever.
 */

import { describe, it, expect } from "vitest";
import { classifyNewContent } from "../src/provider.js";

const recent = (...ids: string[]) => new Set(ids);

describe("classifyNewContent", () => {
  it("empty slice → kind=empty", () => {
    const r = classifyNewContent([], 0, recent());
    expect(r.kind).toBe("empty");
    expect(r.realUserBlocks).toEqual([]);
    expect(r.phantomToolResultIds).toEqual([]);
  });

  it("slice past end of array → kind=empty", () => {
    const r = classifyNewContent(
      [{ role: "user", content: "hi" }],
      1,
      recent(),
    );
    expect(r.kind).toBe("empty");
  });

  it("plain user text → kind=real with one text block", () => {
    const r = classifyNewContent(
      [{ role: "user", content: "hello" }],
      0,
      recent(),
    );
    expect(r.kind).toBe("real");
    expect(r.realUserBlocks).toEqual([{ type: "text", text: "hello" }]);
  });

  it("array-content user message → kind=real with each block (canonical pi ImageContent)", () => {
    // Canonical pi-ai ImageContent shape is FLAT: { type, data, mimeType }.
    // See node_modules/@earendil-works/pi-ai/dist/types.d.ts:157.
    const r = classifyNewContent(
      [
        {
          role: "user",
          content: [
            { type: "text", text: "look at this" },
            { type: "image", data: "BASE64", mimeType: "image/png" },
          ],
        },
      ],
      0,
      recent(),
    );
    expect(r.kind).toBe("real");
    expect(r.realUserBlocks).toHaveLength(2);
    expect(r.realUserBlocks[0]).toEqual({ type: "text", text: "look at this" });
    expect(r.realUserBlocks[1]).toEqual({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "BASE64" },
    });
  });

  it("image block in nested legacy shape (image: {data, mimeType}) is also translated", () => {
    const r = classifyNewContent(
      [
        {
          role: "user",
          content: [{ type: "image", image: { data: "BASE64", mimeType: "image/jpeg" } }],
        },
      ],
      0,
      recent(),
    );
    expect(r.realUserBlocks).toEqual([
      { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "BASE64" } },
    ]);
  });

  it("image block already in Anthropic shape is passed through", () => {
    const r = classifyNewContent(
      [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: "image/png", data: "AAA" },
            },
          ],
        },
      ],
      0,
      recent(),
    );
    expect(r.realUserBlocks[0]).toMatchObject({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "AAA" },
    });
  });

  it("only toolResult messages with recent ids → kind=phantom", () => {
    const r = classifyNewContent(
      [
        { role: "assistant", content: [{ type: "toolCall", id: "tu-1", name: "Bash" }] },
        {
          role: "toolResult",
          toolCallId: "tu-1",
          toolName: "Bash",
          content: [{ type: "text", text: "x" }],
          isError: false,
        },
      ],
      0,
      recent("tu-1"),
    );
    expect(r.kind).toBe("phantom");
    expect(r.phantomToolResultIds).toEqual(["tu-1"]);
    expect(r.unexpectedToolResultIds).toEqual([]);
    expect(r.realUserBlocks).toEqual([]);
  });

  it("toolResult with unknown id → counted as unexpected, kind still phantom if no real input", () => {
    const r = classifyNewContent(
      [
        {
          role: "toolResult",
          toolCallId: "tu-xyz",
          toolName: "Bash",
          content: [{ type: "text", text: "x" }],
          isError: false,
        },
      ],
      0,
      recent("tu-1"),
    );
    expect(r.phantomToolResultIds).toEqual([]);
    expect(r.unexpectedToolResultIds).toEqual(["tu-xyz"]);
    // No real input either — empty.
    expect(r.kind).toBe("empty");
  });

  it("mix of real user message + phantom toolResults → kind=real (real wins, phantoms tracked)", () => {
    const r = classifyNewContent(
      [
        { role: "assistant", content: [{ type: "toolCall", id: "tu-1", name: "Bash" }] },
        {
          role: "toolResult",
          toolCallId: "tu-1",
          toolName: "Bash",
          content: [{ type: "text", text: "x" }],
          isError: false,
        },
        { role: "user", content: "follow-up question" },
      ],
      0,
      recent("tu-1"),
    );
    expect(r.kind).toBe("real");
    expect(r.realUserBlocks).toEqual([{ type: "text", text: "follow-up question" }]);
    expect(r.phantomToolResultIds).toEqual(["tu-1"]);
  });

  it("assistant messages in the slice are silently ignored", () => {
    const r = classifyNewContent(
      [
        { role: "assistant", content: [{ type: "text", text: "previous reply" }] },
        { role: "user", content: "next" },
      ],
      0,
      recent(),
    );
    expect(r.kind).toBe("real");
    expect(r.realUserBlocks).toEqual([{ type: "text", text: "next" }]);
  });

  it("toolResult embedded inside user message content array is also classified", () => {
    const r = classifyNewContent(
      [
        {
          role: "user",
          content: [
            { type: "toolResult", toolCallId: "tu-1", content: [{ type: "text", text: "x" }] },
          ],
        },
      ],
      0,
      recent("tu-1"),
    );
    expect(r.kind).toBe("phantom");
    expect(r.phantomToolResultIds).toEqual(["tu-1"]);
  });

  it("respects fromIndex (only considers slice [fromIndex..])", () => {
    const r = classifyNewContent(
      [
        { role: "user", content: "old message" },
        { role: "user", content: "new message" },
      ],
      1,
      recent(),
    );
    expect(r.kind).toBe("real");
    expect(r.realUserBlocks).toEqual([{ type: "text", text: "new message" }]);
  });

  it("multiple phantoms accumulate", () => {
    const r = classifyNewContent(
      [
        {
          role: "toolResult",
          toolCallId: "tu-a",
          toolName: "Bash",
          content: [{ type: "text", text: "a" }],
        },
        {
          role: "toolResult",
          toolCallId: "tu-b",
          toolName: "Read",
          content: [{ type: "text", text: "b" }],
        },
      ],
      0,
      recent("tu-a", "tu-b"),
    );
    expect(r.kind).toBe("phantom");
    expect(r.phantomToolResultIds.sort()).toEqual(["tu-a", "tu-b"]);
  });
});
