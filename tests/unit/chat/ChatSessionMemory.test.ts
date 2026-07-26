import { describe, test, expect } from "vitest";
import { ChatSessionMemory } from "../../../src/chat/conversation/ChatSessionMemory";
import type { ClaudeCodeResumeCursor, Conversation, ConversationMessage } from "../../../src/shared/types";

function makeConversation(): Conversation {
  return {
    id: "conv-1",
    title: "Test conversation",
    createdAt: 1000,
    updatedAt: 1000,
    modelId: "model-1",
    modelName: "Model 1",
    draft: "",
    messages: [
      {
        id: "assistant-1",
        role: "assistant",
        content: "Second version",
        versions: [
          { content: "First version", createdAt: 1000 },
          { content: "Second version", createdAt: 2000 },
        ],
        activeVersionIndex: 1,
      },
    ],
  };
}

describe("ChatSessionMemory.updateMessageContent", () => {
  test("updates the active version content for versioned assistant messages", () => {
    const memory = new ChatSessionMemory();
    memory.hydrateFromConversation(makeConversation());

    const updated = memory.updateMessageContent("assistant-1", "Edited assistant text");
    const snapshot = memory.getSnapshot();
    const message = snapshot.messageHistory[0];

    expect(updated).toBe(true);
    expect(message.content).toBe("Edited assistant text");
    expect(message.versions?.[1]?.content).toBe("Edited assistant text");
    expect(snapshot.lastAssistantResponse).toBe("Edited assistant text");
  });
});

describe("ChatSessionMemory.restoreRegeneration", () => {
  // Regression for the "regenerate then immediately Stop loses the original
  // message + its version history" data-loss bug. regenerateMessage pops the
  // original up front; an empty-response abort must put it back EXACTLY, same
  // object, same versions, no spurious duplicate version appended.
  test("re-appends the popped message with its version history untouched", () => {
    const memory = new ChatSessionMemory();
    memory.hydrateFromConversation(makeConversation());

    // regenerateMessage pops the original assistant message before generating.
    const old = memory.removeLastMessage();
    expect(old?.id).toBe("assistant-1");
    expect(memory.getSnapshot().messageHistory).toHaveLength(0);

    // The user stops before any text streams: restore must be loss-free.
    memory.restoreRegeneration(old!);

    const snapshot = memory.getSnapshot();
    expect(snapshot.messageHistory).toHaveLength(1);
    const restored = snapshot.messageHistory[0];
    expect(restored).toBe(old); // same object, never re-versioned
    expect(restored.content).toBe("Second version");
    expect(restored.versions?.map((v) => v.content)).toEqual([
      "First version",
      "Second version",
    ]);
    expect(restored.activeVersionIndex).toBe(1);
    expect(snapshot.lastAssistantResponse).toBe("Second version");
  });
});

describe("ChatSessionMemory.finalizeRegeneration", () => {
  test("seeds a base version from a version-less original, then appends the new content", () => {
    const memory = new ChatSessionMemory();
    memory.hydrateFromConversation({
      ...makeConversation(),
      messages: [{ id: "assistant-1", role: "assistant", content: "Original" }],
    });

    const old = memory.removeLastMessage();
    const result = memory.finalizeRegeneration(old!, "Regenerated");

    expect(result.content).toBe("Regenerated");
    expect(result.versions?.map((v) => v.content)).toEqual(["Original", "Regenerated"]);
    expect(result.activeVersionIndex).toBe(1);
    expect(memory.getSnapshot().lastAssistantResponse).toBe("Regenerated");
  });

  test("preserves the existing version history when regenerating an already-versioned message", () => {
    const memory = new ChatSessionMemory();
    memory.hydrateFromConversation(makeConversation());

    const old = memory.removeLastMessage();
    const result = memory.finalizeRegeneration(old!, "Third version");

    expect(result.versions?.map((v) => v.content)).toEqual([
      "First version",
      "Second version",
      "Third version",
    ]);
    expect(result.activeVersionIndex).toBe(2);
  });

  test("keeps historical version metadata separate from the active regeneration metadata", () => {
    const memory = new ChatSessionMemory();
    memory.hydrateFromConversation({
      ...makeConversation(),
      messages: [
        {
          id: "assistant-1",
          role: "assistant",
          content: "Second version",
          versions: [
            {
              content: "First version",
              createdAt: 1000,
              usage: { inputTokens: 1, outputTokens: 2 },
              ragSources: [
                { filePath: "Fixtures/first.md", headingPath: "", score: 0.7 },
              ],
            },
            {
              content: "Second version",
              createdAt: 2000,
              usage: { inputTokens: 3, outputTokens: 4 },
              ragSources: [
                { filePath: "Fixtures/second.md", headingPath: "", score: 0.8 },
              ],
            },
          ],
          activeVersionIndex: 1,
        },
      ],
    });

    const old = memory.removeLastMessage();
    const result = memory.finalizeRegeneration(old!, "Third version", {
      provider: "anthropic",
      modelId: "claude-fixture",
      usage: { inputTokens: 5, outputTokens: 6 },
      ragSources: [
        { filePath: "Fixtures/third.md", headingPath: "", score: 0.9 },
      ],
      rewrittenQuery: "synthetic rewritten query",
      interrupted: true,
    });

    expect(result.versions?.map((version) => version.usage?.inputTokens)).toEqual([1, 3, 5]);
    expect(result.versions?.map((version) => version.ragSources?.[0]?.filePath)).toEqual([
      "Fixtures/first.md",
      "Fixtures/second.md",
      "Fixtures/third.md",
    ]);
    expect(result.provider).toBe("anthropic");
    expect(result.modelId).toBe("claude-fixture");
    expect(result.rewrittenQuery).toBe("synthetic rewritten query");
    expect(result.interrupted).toBe(true);
  });
});

describe("ChatSessionMemory.switchMessageVersion", () => {
  test("activates the selected version and updates the last-assistant response", () => {
    const memory = new ChatSessionMemory();
    memory.hydrateFromConversation(makeConversation());

    expect(memory.switchMessageVersion("assistant-1", 0)).toBe(true);
    const snapshot = memory.getSnapshot();
    expect(snapshot.messageHistory[0].content).toBe("First version");
    expect(snapshot.messageHistory[0].activeVersionIndex).toBe(0);
    expect(snapshot.lastAssistantResponse).toBe("First version");
  });

  test("rejects an out-of-range index without mutating state", () => {
    const memory = new ChatSessionMemory();
    memory.hydrateFromConversation(makeConversation());

    expect(memory.switchMessageVersion("assistant-1", 5)).toBe(false);
    expect(memory.switchMessageVersion("assistant-1", -1)).toBe(false);
    expect(memory.getSnapshot().messageHistory[0].content).toBe("Second version");
  });
});

describe("ChatSessionMemory.removeLastMessage", () => {
  /** Build a conversation with an explicit message list. */
  function withMessages(messages: Conversation["messages"]): Conversation {
    return { ...makeConversation(), messages };
  }

  test("returns null and does not mutate when the history is empty", () => {
    const memory = new ChatSessionMemory();

    expect(memory.removeLastMessage()).toBeNull();
    expect(memory.getSnapshot().messageHistory).toHaveLength(0);
  });

  test("pops the last message and recalculates the last-assistant response", () => {
    const memory = new ChatSessionMemory();
    memory.hydrateFromConversation(
      withMessages([
        { id: "u1", role: "user", content: "q1" },
        { id: "a1", role: "assistant", content: "First answer" },
        { id: "u2", role: "user", content: "q2" },
        { id: "a2", role: "assistant", content: "Second answer" },
      ]),
    );
    expect(memory.getSnapshot().lastAssistantResponse).toBe("Second answer");

    const removed = memory.removeLastMessage();

    expect(removed?.id).toBe("a2");
    const snapshot = memory.getSnapshot();
    expect(snapshot.messageHistory).toHaveLength(3);
    // The newest assistant is gone, so the meter falls back to the prior one.
    expect(snapshot.lastAssistantResponse).toBe("First answer");
  });

  test("keeps the last-assistant response when a trailing user message is popped", () => {
    const memory = new ChatSessionMemory();
    memory.hydrateFromConversation(
      withMessages([
        { id: "a1", role: "assistant", content: "Hello" },
        { id: "u1", role: "user", content: "pending question" },
      ]),
    );

    const removed = memory.removeLastMessage();

    expect(removed?.id).toBe("u1");
    expect(memory.getSnapshot().lastAssistantResponse).toBe("Hello");
  });

  test("clears the last-assistant response when no assistant message remains", () => {
    const memory = new ChatSessionMemory();
    memory.hydrateFromConversation(
      withMessages([
        { id: "u1", role: "user", content: "q1" },
        { id: "a1", role: "assistant", content: "Only answer" },
      ]),
    );

    memory.removeLastMessage();

    expect(memory.getSnapshot().lastAssistantResponse).toBe("");
  });
});

describe("ChatSessionMemory.getClaudeCodeResumeCursor", () => {
  const cursor = (sessionId: string): ClaudeCodeResumeCursor => ({
    sessionId,
    coveredCount: 2,
    prefixHash: "h",
    configFingerprint: "fp",
  });

  function convWith(messages: ConversationMessage[]): Conversation {
    return { ...makeConversation(), messages };
  }

  test("returns the cursor from the most recent claudecode assistant turn", () => {
    const memory = new ChatSessionMemory();
    memory.hydrateFromConversation(
      convWith([
        { id: "u1", role: "user", content: "hi" },
        {
          id: "a1",
          role: "assistant",
          content: "one",
          provider: "claudecode",
          usage: { inputTokens: 1, outputTokens: 1, resumeCursor: cursor("old") },
        },
        { id: "u2", role: "user", content: "again" },
        {
          id: "a2",
          role: "assistant",
          content: "two",
          provider: "claudecode",
          usage: { inputTokens: 1, outputTokens: 1, resumeCursor: cursor("new") },
        },
      ]),
    );

    expect(memory.getClaudeCodeResumeCursor()?.sessionId).toBe("new");
  });

  test("returns undefined when no claudecode turn has banked a cursor", () => {
    const memory = new ChatSessionMemory();
    memory.hydrateFromConversation(
      convWith([
        { id: "u1", role: "user", content: "hi" },
        {
          id: "a1",
          role: "assistant",
          content: "one",
          provider: "claudecode",
          usage: { inputTokens: 1, outputTokens: 1 },
        },
      ]),
    );

    expect(memory.getClaudeCodeResumeCursor()).toBeUndefined();
  });

  test("ignores a cursor carried by a non-claudecode provider", () => {
    const memory = new ChatSessionMemory();
    memory.hydrateFromConversation(
      convWith([
        {
          id: "a1",
          role: "assistant",
          content: "one",
          provider: "anthropic",
          usage: { inputTokens: 1, outputTokens: 1, resumeCursor: cursor("foreign") },
        },
      ]),
    );

    expect(memory.getClaudeCodeResumeCursor()).toBeUndefined();
  });
});
