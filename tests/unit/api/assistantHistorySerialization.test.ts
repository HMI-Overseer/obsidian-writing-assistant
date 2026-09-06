import { describe, expect, it } from "vitest";
import { buildAnthropicMessages } from "../../../src/api/buildAnthropicPayload";
import { buildOpenAICompatibleMessages } from "../../../src/api/buildOpenAICompatibleMessages";
import type { ChatRequest, ChatTurn } from "../../../src/shared/chatRequest";

function request(messages: ChatTurn[]): ChatRequest {
  return {
    systemPrompt: "",
    documentContext: null,
    ragContext: null,
    messages,
  };
}

const orderedAssistant: ChatTurn = {
  role: "assistant",
  content: null,
  assistantContent: [
    { type: "prose", text: "Before." },
    {
      type: "tool_call",
      toolCallId: "call-1",
      toolName: "read",
      toolArguments: '{"path":"one.md"}',
      toolArgs: { path: "one.md" },
    },
    { type: "prose", text: "Between." },
    {
      type: "tool_call",
      toolCallId: "call-2",
      toolName: "read",
      toolArguments: '{"path":"two.md"}',
      toolArgs: { path: "two.md" },
    },
  ],
  providerReplayCapsule: {
    provider: "anthropic",
    version: 1,
    thinkingBlocks: [
      { type: "thinking", thinking: "private", signature: "signature-1" },
    ],
  },
};

describe("Phase 6 assistant history serialization", () => {
  it("serializes Anthropic text and tool_use blocks in source order with the valid capsule", () => {
    const { messages } = buildAnthropicMessages(
      request([
        { role: "user", content: "Inspect both." },
        orderedAssistant,
        { role: "tool", content: "one", toolCallId: "call-1" },
        {
          role: "tool",
          content: "two failed",
          toolCallId: "call-2",
          toolResultIsError: true,
        },
      ]),
    );

    expect(messages[1]).toEqual({
      role: "assistant",
      content: [
        {
          type: "thinking",
          thinking: "private",
          signature: "signature-1",
        },
        { type: "text", text: "Before." },
        {
          type: "tool_use",
          id: "call-1",
          name: "read",
          input: { path: "one.md" },
        },
        { type: "text", text: "Between." },
        {
          type: "tool_use",
          id: "call-2",
          name: "read",
          input: { path: "two.md" },
        },
      ],
    });
    expect(messages[2]).toEqual({
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "call-1", content: "one" },
        {
          type: "tool_result",
          tool_use_id: "call-2",
          content: "two failed",
          is_error: true,
        },
      ],
    });
  });

  it("groups OpenAI-compatible content and calls in one segment emission", () => {
    const messages = buildOpenAICompatibleMessages(
      request([
        { role: "user", content: "Inspect both." },
        orderedAssistant,
        { role: "tool", content: "one", toolCallId: "call-1" },
        { role: "tool", content: "two", toolCallId: "call-2" },
      ]),
    );

    expect(messages.slice(1)).toEqual([
      {
        role: "assistant",
        content: "Before.Between.",
        tool_calls: [
          {
            id: "call-1",
            type: "function",
            function: {
              name: "read",
              arguments: '{"path":"one.md"}',
            },
          },
          {
            id: "call-2",
            type: "function",
            function: {
              name: "read",
              arguments: '{"path":"two.md"}',
            },
          },
        ],
      },
      { role: "tool", content: "one", tool_call_id: "call-1" },
      { role: "tool", content: "two", tool_call_id: "call-2" },
    ]);
  });

  it("keeps separate silent segments as distinct OpenAI-compatible emissions", () => {
    const first: ChatTurn = {
      role: "assistant",
      content: null,
      assistantContent: [orderedAssistant.assistantContent?.[1]].filter(
        (item): item is NonNullable<typeof item> => item !== undefined,
      ),
    };
    const second: ChatTurn = {
      role: "assistant",
      content: null,
      assistantContent: [orderedAssistant.assistantContent?.[3]].filter(
        (item): item is NonNullable<typeof item> => item !== undefined,
      ),
    };

    const messages = buildOpenAICompatibleMessages(
      request([
        first,
        { role: "tool", content: "one", toolCallId: "call-1" },
        second,
        { role: "tool", content: "two", toolCallId: "call-2" },
      ]),
    );

    expect(messages.map((message) => message.role)).toEqual([
      "assistant",
      "tool",
      "assistant",
      "tool",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Tool-result images on the OpenAI wire format (RFC-0021 D5, P4, ADR-0041).
// A `tool` message admits text parts only, so the picture rides ONE synthesized
// `user` message after the round's last tool message, and that message must not
// attract the per-round context tail.
// ---------------------------------------------------------------------------

describe("OpenAI-shaped tool-result images", () => {
  const MAP_STUB = "[Art/map.png]\n\nImage: PNG, 1x1, 29 B, attached as an image block.";

  const mapImage = {
    path: "Art/map.png",
    mimeType: "image/png" as const,
    data: "AQID",
    byteLength: 3,
    width: 1,
    height: 1,
  };

  /** Two tool results in one round; only the second carries a picture. */
  function twoResultRound(withImage: boolean): ChatTurn[] {
    return [
      { role: "user", content: "look at the map" },
      {
        role: "assistant",
        content: null,
        toolCalls: [
          { id: "call-1", name: "read", arguments: { path: "Notes/scene.md" } },
          { id: "call-2", name: "read", arguments: { path: "Art/map.png" } },
        ],
      },
      { role: "tool", content: "[Notes/scene.md]\n\n1\ttext", toolCallId: "call-1" },
      {
        role: "tool",
        content: MAP_STUB,
        toolCallId: "call-2",
        ...(withImage ? { toolResultImages: [mapImage] } : {}),
      },
    ];
  }

  it("emits tool, tool, user with the label and the data URI, after the last result", () => {
    const messages = buildOpenAICompatibleMessages(request(twoResultRound(true)));

    expect(messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "tool",
      "user",
    ]);
    // One message for the whole round, after BOTH tool messages, never between them.
    expect(messages[4]).toEqual({
      role: "user",
      content: [
        { type: "text", text: "Image returned by read for Art/map.png" },
        { type: "image_url", image_url: { url: "data:image/png;base64,AQID" } },
      ],
    });
    // The stub still rides the tool message it belongs to.
    expect(messages[3].content).toBe(MAP_STUB);
  });

  it("collects the images of a parallel batch into one message, in call order", () => {
    const second = {
      path: "Art/tree.webp",
      mimeType: "image/webp" as const,
      data: "BAUG",
      byteLength: 3,
    };
    const turns = twoResultRound(true);
    turns[2] = { ...turns[2], toolResultImages: [second] };

    const messages = buildOpenAICompatibleMessages(request(turns));

    expect(messages).toHaveLength(5);
    expect(messages[4].content).toEqual([
      { type: "text", text: "Image returned by read for Art/tree.webp" },
      { type: "image_url", image_url: { url: "data:image/webp;base64,BAUG" } },
      { type: "text", text: "Image returned by read for Art/map.png" },
      { type: "image_url", image_url: { url: "data:image/png;base64,AQID" } },
    ]);
  });

  it("flushes the images before the next non-tool turn, not at the end of history", () => {
    const messages = buildOpenAICompatibleMessages(
      request([
        ...twoResultRound(true),
        { role: "assistant", content: "it is a map" },
        { role: "user", content: "and the tree?" },
      ]),
    );

    expect(messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "tool",
      "user",
      "assistant",
      "user",
    ]);
    expect(Array.isArray(messages[4].content)).toBe(true);
    expect(messages[6].content).toBe("and the tree?");
  });

  // The guarantee: a round that read no image is byte-identical to what this builder
  // emitted before the field existed. The literal was captured from the tree first.
  it("is byte-identical to the pre-change output when no image was read", () => {
    const messages = buildOpenAICompatibleMessages(request(twoResultRound(false)));

    expect(messages).toEqual([
      { role: "user", content: "look at the map" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call-1",
            type: "function",
            function: { name: "read", arguments: '{"path":"Notes/scene.md"}' },
          },
          {
            id: "call-2",
            type: "function",
            function: { name: "read", arguments: '{"path":"Art/map.png"}' },
          },
        ],
      },
      { role: "tool", content: "[Notes/scene.md]\n\n1\ttext", tool_call_id: "call-1" },
      { role: "tool", content: MAP_STUB, tool_call_id: "call-2" },
    ]);
  });

  // P4 / M5. The natural implementation attaches the tail to the synthesized message,
  // because it is a trailing `user` message. It must not: on a tool round this path
  // sends no tail at all today, and the round shape cannot start depending on whether
  // an image was read.
  it("keeps the document, note-image and RAG tail off the synthesized message", () => {
    const withTail = (messages: ChatTurn[]) => ({
      ...request(messages),
      documentContext: { filePath: "n.md", content: "DOC-BODY", isFull: false },
      ragContext: [
        {
          filePath: "r.md",
          headingPath: "",
          content: "RAG-BODY",
          score: 0.9,
        },
      ],
      noteImageContext: [
        {
          noteFilePath: "n.md",
          imageFilePath: "n.png",
          fileName: "n.png",
          mimeType: "image/png" as const,
          data: "Zm9v",
        },
      ],
      additionalContextItems: [{ filePath: "extra.md", content: "EXTRA-BODY" }],
    });

    const withImage = buildOpenAICompatibleMessages(withTail(twoResultRound(true)));
    const asJson = JSON.stringify(withImage);
    expect(asJson).not.toContain("DOC-BODY");
    expect(asJson).not.toContain("RAG-BODY");
    expect(asJson).not.toContain("EXTRA-BODY");
    expect(asJson).not.toContain("Zm9v");
    // The synthesized message carries exactly the label and the picture, nothing else.
    expect(withImage[4].content).toEqual([
      { type: "text", text: "Image returned by read for Art/map.png" },
      { type: "image_url", image_url: { url: "data:image/png;base64,AQID" } },
    ]);

    // And the no-image round is unchanged by the tail too, exactly as today.
    const withoutImage = buildOpenAICompatibleMessages(withTail(twoResultRound(false)));
    expect(JSON.stringify(withoutImage)).not.toContain("DOC-BODY");
    expect(withoutImage).toHaveLength(4);
  });

  // The other half of P4: the tail still reaches a real user turn when that turn ends
  // the request, which is every non-tool round. Guards against fixing the leak by
  // dropping the tail everywhere.
  it("still appends the tail to a trailing real user turn", () => {
    const messages = buildOpenAICompatibleMessages({
      ...request([
        { role: "user", content: "first" },
        { role: "assistant", content: "reply" },
        { role: "user", content: "second" },
      ]),
      documentContext: { filePath: "n.md", content: "DOC-BODY", isFull: false },
    });

    expect(messages).toHaveLength(3);
    expect(messages[2].content).toContain("second");
    expect(messages[2].content).toContain("DOC-BODY");
  });
});
