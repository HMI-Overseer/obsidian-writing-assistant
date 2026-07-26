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
      toolName: "read_file",
      toolArguments: '{"path":"one.md"}',
      toolArgs: { path: "one.md" },
    },
    { type: "prose", text: "Between." },
    {
      type: "tool_call",
      toolCallId: "call-2",
      toolName: "read_file",
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
          name: "read_file",
          input: { path: "one.md" },
        },
        { type: "text", text: "Between." },
        {
          type: "tool_use",
          id: "call-2",
          name: "read_file",
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
              name: "read_file",
              arguments: '{"path":"one.md"}',
            },
          },
          {
            id: "call-2",
            type: "function",
            function: {
              name: "read_file",
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
