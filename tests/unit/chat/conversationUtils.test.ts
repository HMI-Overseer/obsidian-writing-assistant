import { describe, test, expect } from "vitest";
import {
  normalizeChatHistory,
  normalizeConversation,
  toConversationMeta,
} from "../../../src/chat/conversation/conversationUtils";
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

describe("normalizeConversation — usage field preservation", () => {
  test("preserves modelId, provider, and usage on assistant messages", () => {
    const msg: ConversationMessage = {
      id: "msg-1",
      role: "assistant",
      content: "Hello!",
      modelId: "claude-3-haiku-20240307",
      provider: "anthropic",
      usage: makeUsage(),
    };

    const raw = jsonRoundTrip(makeConversation([msg])) as Record<string, unknown>;
    const result = normalizeConversation(raw);
    const normalized = result!.messages[0];

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

    const raw = jsonRoundTrip(makeConversation([msg])) as Record<string, unknown>;
    const result = normalizeConversation(raw);
    const normalized = result!.messages[0];

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

    const raw = jsonRoundTrip(makeConversation([msg])) as Record<string, unknown>;
    const result = normalizeConversation(raw);
    const normalized = result!.messages[0];

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

    const raw = jsonRoundTrip(makeConversation([msg])) as Record<string, unknown>;
    const result = normalizeConversation(raw);
    const normalized = result!.messages[0];

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

    const raw = jsonRoundTrip(makeConversation([msg])) as Record<string, unknown>;
    const result = normalizeConversation(raw);
    const normalized = result!.messages[0];

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

    const raw = jsonRoundTrip(makeConversation([msg])) as Record<string, unknown>;
    const result = normalizeConversation(raw);
    const normalized = result!.messages[0];

    expect(normalized.modelId).toBeUndefined();
    expect(normalized.provider).toBeUndefined();
    expect(normalized.usage).toBeUndefined();
  });
});

describe("normalizeChatHistory — metadata index", () => {
  test("normalizes conversation metadata entries", () => {
    const raw = jsonRoundTrip({
      conversations: [
        { id: "conv-1", title: "Test", createdAt: 1000, updatedAt: 2000, modelId: "p1", modelName: "Claude", messageCount: 5 },
      ],
      activeConversationId: "conv-1",
    });

    const result = normalizeChatHistory(raw);
    expect(result.conversations).toHaveLength(1);
    expect(result.conversations[0].id).toBe("conv-1");
    expect(result.conversations[0].messageCount).toBe(5);
    expect(result.activeConversationId).toBe("conv-1");
  });

  test("falls back to first conversation when activeConversationId is invalid", () => {
    const raw = jsonRoundTrip({
      conversations: [
        { id: "conv-1", title: "Test", createdAt: 1000, updatedAt: 2000, modelId: "p1", modelName: "Claude", messageCount: 0 },
      ],
      activeConversationId: "nonexistent",
    });

    const result = normalizeChatHistory(raw);
    expect(result.activeConversationId).toBe("conv-1");
  });

  test("returns empty history for invalid input", () => {
    const result = normalizeChatHistory(null);
    expect(result.conversations).toHaveLength(0);
    expect(result.activeConversationId).toBeNull();
  });
});

describe("normalizeConversation — editProposal / appliedEdit validation", () => {
  function makeEditProposal() {
    return {
      id: "ep-1",
      targetFilePath: "notes/test.md",
      documentSnapshot: "original content",
      snapshotTimestamp: 1000,
      hunks: [{ id: "h1", resolvedEdit: {}, status: "pending" }],
      prose: "Here are the changes.",
    };
  }

  function makeAppliedEditRecord() {
    return {
      proposalId: "ep-1",
      targetFilePath: "notes/test.md",
      preApplySnapshot: "before",
      postApplySnapshot: "after",
      appliedAt: 2000,
      appliedHunkIds: ["h1"],
    };
  }

  test("preserves a well-formed editProposal after round-trip", () => {
    const msg: ConversationMessage = {
      id: "msg-1",
      role: "assistant",
      content: "Edit response",
      editProposal: makeEditProposal() as ConversationMessage["editProposal"],
    };

    const raw = jsonRoundTrip(makeConversation([msg])) as Record<string, unknown>;
    const result = normalizeConversation(raw);
    const normalized = result!.messages[0];

    expect(normalized.editProposal).toBeDefined();
    expect(normalized.editProposal!.id).toBe("ep-1");
    expect(normalized.editProposal!.targetFilePath).toBe("notes/test.md");
    expect(normalized.editProposal!.hunks).toHaveLength(1);
  });

  test("drops editProposal missing required fields", () => {
    const msg: ConversationMessage = {
      id: "msg-1",
      role: "assistant",
      content: "Edit response",
    };

    const raw = jsonRoundTrip(makeConversation([msg])) as Record<string, unknown>;
    // Inject a malformed editProposal (missing hunks, prose, etc.)
    const messages = raw.messages as Array<Record<string, unknown>>;
    messages[0].editProposal = { id: "ep-bad" };

    const result = normalizeConversation(raw);
    const normalized = result!.messages[0];

    expect(normalized.editProposal).toBeUndefined();
  });

  test("drops non-object truthy editProposal", () => {
    const msg: ConversationMessage = {
      id: "msg-1",
      role: "assistant",
      content: "Edit response",
    };

    const raw = jsonRoundTrip(makeConversation([msg])) as Record<string, unknown>;
    const messages = raw.messages as Array<Record<string, unknown>>;
    messages[0].editProposal = "not-an-object";

    const result = normalizeConversation(raw);
    const normalized = result!.messages[0];

    expect(normalized.editProposal).toBeUndefined();
  });

  test("preserves a well-formed appliedEdit after round-trip", () => {
    const msg: ConversationMessage = {
      id: "msg-1",
      role: "assistant",
      content: "Edit response",
      editProposal: makeEditProposal() as ConversationMessage["editProposal"],
      appliedEdit: makeAppliedEditRecord() as ConversationMessage["appliedEdit"],
    };

    const raw = jsonRoundTrip(makeConversation([msg])) as Record<string, unknown>;
    const result = normalizeConversation(raw);
    const normalized = result!.messages[0];

    expect(normalized.appliedEdit).toBeDefined();
    expect(normalized.appliedEdit!.proposalId).toBe("ep-1");
    expect(normalized.appliedEdit!.appliedHunkIds).toEqual(["h1"]);
  });

  test("drops malformed appliedEdit", () => {
    const msg: ConversationMessage = {
      id: "msg-1",
      role: "assistant",
      content: "Edit response",
    };

    const raw = jsonRoundTrip(makeConversation([msg])) as Record<string, unknown>;
    const messages = raw.messages as Array<Record<string, unknown>>;
    messages[0].appliedEdit = { proposalId: "ep-1" }; // missing targetFilePath, appliedHunkIds

    const result = normalizeConversation(raw);
    const normalized = result!.messages[0];

    expect(normalized.appliedEdit).toBeUndefined();
  });
});

describe("toConversationMeta", () => {
  test("extracts metadata from full conversation", () => {
    const conv = makeConversation([
      { id: "m1", role: "user", content: "Hi" },
      { id: "m2", role: "assistant", content: "Hello" },
    ]);

    const meta = toConversationMeta(conv);

    expect(meta.id).toBe("conv-1");
    expect(meta.title).toBe("Test");
    expect(meta.messageCount).toBe(2);
    expect(meta.modelId).toBe("profile-1");
    expect(meta.modelName).toBe("Claude Haiku 3");
    expect((meta as Record<string, unknown>)["messages"]).toBeUndefined();
  });
});
