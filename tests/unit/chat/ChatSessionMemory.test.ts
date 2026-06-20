import { describe, test, expect } from "vitest";
import { ChatSessionMemory } from "../../../src/chat/conversation/ChatSessionMemory";
import type { Conversation } from "../../../src/shared/types";

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
  // original up front; an empty-response abort must put it back EXACTLY — same
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
