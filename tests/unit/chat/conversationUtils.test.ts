import { describe, test, expect } from "vitest";
import { normalizeChatHistory } from "../../../src/chat/conversation/conversationUtils";
import type { Conversation, ConversationMessage, MessageUsage } from "../../../src/shared/types";

/**
 * Simulates a JSON round-trip through data.json — the object is serialized
 * then parsed back as a plain object with no type guarantees.
 */
function jsonRoundTrip<T>(obj: T): unknown {
  return JSON.parse(JSON.stringify(obj));
}

function makeUsage(overrides: Partial<MessageUsage> = {}): MessageUsage {
  return {
    inputTokens: 2489,
    outputTokens: 12,
    estimatedCostUsd: 0.00063725,
    ...overrides,
  };
}

function makeConversation(messages: ConversationMessage[]): Conversation {
  return {
    id: "conv-1",
    title: "Test",
    createdAt: 1000,
    updatedAt: 2000,
    modelId: "profile-1",
    modelName: "Claude Haiku 3",
    messages,
    draft: "",
  };
}

describe("normalizeChatHistory — usage field preservation", () => {
  test("preserves modelId, provider, and usage on assistant messages", () => {
    const msg: ConversationMessage = {
      id: "msg-1",
      role: "assistant",
      content: "Hello!",
      modelId: "claude-3-haiku-20240307",
      provider: "anthropic",
      usage: makeUsage(),
    };

    const raw = jsonRoundTrip({ conversations: [makeConversation([msg])], activeConversationId: "conv-1" });
    const result = normalizeChatHistory(raw);
    const normalized = result.conversations[0].messages[0];

    expect(normalized.modelId).toBe("claude-3-haiku-20240307");
    expect(normalized.provider).toBe("anthropic");
    expect(normalized.usage).toEqual(makeUsage());
  });

  test("preserves isError flag on error messages", () => {
    const msg: ConversationMessage = {
      id: "msg-1",
      role: "assistant",
      content: "Error: Rate limit exceeded",
      isError: true,
      modelId: "claude-3-haiku-20240307",
      provider: "anthropic",
    };

    const raw = jsonRoundTrip({ conversations: [makeConversation([msg])], activeConversationId: "conv-1" });
    const result = normalizeChatHistory(raw);
    const normalized = result.conversations[0].messages[0];

    expect(normalized.isError).toBe(true);
    expect(normalized.modelId).toBe("claude-3-haiku-20240307");
    expect(normalized.provider).toBe("anthropic");
  });

  test("does not add isError when not present", () => {
    const msg: ConversationMessage = {
      id: "msg-1",
      role: "assistant",
      content: "Hello!",
    };

    const raw = jsonRoundTrip({ conversations: [makeConversation([msg])], activeConversationId: "conv-1" });
    const result = normalizeChatHistory(raw);
    const normalized = result.conversations[0].messages[0];

    expect(normalized.isError).toBeUndefined();
  });

  test("preserves usage on MessageVersions after round-trip", () => {
    const msg: ConversationMessage = {
      id: "msg-1",
      role: "assistant",
      content: "v2 content",
      versions: [
        { content: "v1 content", createdAt: 1000, usage: makeUsage({ inputTokens: 100, outputTokens: 50, estimatedCostUsd: 0.001 }) },
        { content: "v2 content", createdAt: 2000, usage: makeUsage({ inputTokens: 200, outputTokens: 80, estimatedCostUsd: 0.003 }) },
      ],
      activeVersionIndex: 1,
      modelId: "claude-3-haiku-20240307",
      provider: "anthropic",
      usage: makeUsage({ inputTokens: 200, outputTokens: 80, estimatedCostUsd: 0.003 }),
    };

    const raw = jsonRoundTrip({ conversations: [makeConversation([msg])], activeConversationId: "conv-1" });
    const result = normalizeChatHistory(raw);
    const normalized = result.conversations[0].messages[0];

    expect(normalized.versions).toHaveLength(2);
    expect(normalized.versions![0].usage).toEqual(
      makeUsage({ inputTokens: 100, outputTokens: 50, estimatedCostUsd: 0.001 })
    );
    expect(normalized.versions![1].usage).toEqual(
      makeUsage({ inputTokens: 200, outputTokens: 80, estimatedCostUsd: 0.003 })
    );
  });

  test("handles versions without usage (backward compat)", () => {
    const msg: ConversationMessage = {
      id: "msg-1",
      role: "assistant",
      content: "v2 content",
      versions: [
        { content: "v1 content", createdAt: 1000 },
        { content: "v2 content", createdAt: 2000 },
      ],
      activeVersionIndex: 1,
    };

    const raw = jsonRoundTrip({ conversations: [makeConversation([msg])], activeConversationId: "conv-1" });
    const result = normalizeChatHistory(raw);
    const normalized = result.conversations[0].messages[0];

    expect(normalized.versions).toHaveLength(2);
    expect(normalized.versions![0].usage).toBeUndefined();
    expect(normalized.versions![1].usage).toBeUndefined();
  });

  test("preserves messages without any usage fields (LM Studio / old data)", () => {
    const msg: ConversationMessage = {
      id: "msg-1",
      role: "assistant",
      content: "Hello from LM Studio",
    };

    const raw = jsonRoundTrip({ conversations: [makeConversation([msg])], activeConversationId: "conv-1" });
    const result = normalizeChatHistory(raw);
    const normalized = result.conversations[0].messages[0];

    expect(normalized.modelId).toBeUndefined();
    expect(normalized.provider).toBeUndefined();
    expect(normalized.usage).toBeUndefined();
  });
});
