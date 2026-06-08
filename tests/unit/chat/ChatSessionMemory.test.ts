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
