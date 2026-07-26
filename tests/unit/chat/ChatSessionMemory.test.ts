import { describe, expect, test } from "vitest";
import { ChatSessionMemory } from "../../../src/chat/conversation/ChatSessionMemory";
import type {
  ClaudeCodeResumeCursor,
  Conversation,
  ConversationMessage,
} from "../../../src/shared/types";

function legacyAssistant(
  id: string,
  revisions: string[],
  activeIndex = revisions.length - 1,
): ConversationMessage {
  return {
    id,
    role: "assistant",
    content: revisions[activeIndex] ?? "",
    revisions: revisions.map((content, index) => ({
      revisionId: `${id}-revision-${index}`,
      kind: "legacy",
      content,
      createdAt: index + 1,
    })),
    activeRevisionId: `${id}-revision-${activeIndex}`,
    actionLedger: [],
  };
}

function conversation(
  messages: ConversationMessage[] = [
    legacyAssistant("assistant-1", ["First version", "Second version"]),
  ],
): Conversation {
  return {
    id: "conversation-1",
    title: "Test conversation",
    createdAt: 1,
    updatedAt: 1,
    modelId: "openai:gpt-test",
    modelName: "GPT test",
    messages,
    draft: "",
  };
}

describe("ChatSessionMemory canonical writes", () => {
  test("edits a user message without accepting an assistant compatibility write", () => {
    const memory = new ChatSessionMemory();
    memory.hydrateFromConversation(
      conversation([
        { id: "user-1", role: "user", content: "Before" },
        legacyAssistant("assistant-1", ["Answer"]),
      ]),
    );

    expect(
      memory.updateUserMessageContent("user-1", "After"),
    ).toBe(true);
    expect(
      memory.updateUserMessageContent("assistant-1", "Not allowed"),
    ).toBe(false);
    expect(memory.getSnapshot().messageHistory[0].content).toBe("After");
  });

  test("turns a legacy inline edit into a canonical edited revision", () => {
    const memory = new ChatSessionMemory();
    const source = legacyAssistant("assistant-1", [
      "First version",
      "Second version",
    ]);
    source.versions = [
      { content: "First version", createdAt: 1 },
      { content: "Second version", createdAt: 2 },
    ];
    source.activeVersionIndex = 1;
    memory.hydrateFromConversation(conversation([source]));

    expect(
      memory.editLegacyAssistantContent(
        "assistant-1",
        "Edited assistant text",
        "openai",
        "gpt-test",
      ),
    ).toBe(true);

    const message = memory.getSnapshot().messageHistory[0];
    const edited = message.revisions?.at(-1);
    expect(edited).toMatchObject({
      kind: "turn",
      origin: "edited",
      parentRevisionId: "assistant-1-revision-1",
      provider: "openai",
      modelId: "gpt-test",
    });
    expect(
      edited?.kind === "turn"
        ? edited.turn.items.map((item) =>
            item.type === "prose" ? item.text : null,
          )
        : [],
    ).toEqual(["Edited assistant text"]);
    expect(message.versions?.map((version) => version.content)).toEqual([
      "First version",
      "Second version",
    ]);
    expect(message.activeVersionIndex).toBe(1);
    expect(message.content).toBe("Edited assistant text");
  });

  test("rejects a newly appended assistant message without a revision", () => {
    const memory = new ChatSessionMemory();

    expect(() =>
      memory.appendMessage({
        id: "assistant-raw",
        role: "assistant",
        content: "Legacy writer",
      }),
    ).toThrow(/immutable revision/u);
  });
});

describe("ChatSessionMemory revision navigation", () => {
  test("selects by revision ID without updating load-only version fields", () => {
    const memory = new ChatSessionMemory();
    const message = legacyAssistant("assistant-1", [
      "First version",
      "Second version",
    ]);
    message.versions = [
      { content: "First version", createdAt: 1 },
      { content: "Second version", createdAt: 2 },
    ];
    message.activeVersionIndex = 1;
    memory.hydrateFromConversation(conversation([message]));

    expect(
      memory.switchMessageRevision(
        "assistant-1",
        "assistant-1-revision-0",
      ),
    ).toBe(true);

    const selected = memory.getSnapshot().messageHistory[0];
    expect(selected.activeRevisionId).toBe(
      "assistant-1-revision-0",
    );
    expect(selected.content).toBe("First version");
    expect(selected.activeVersionIndex).toBe(1);
    expect(memory.getSnapshot().lastAssistantResponse).toBe(
      "First version",
    );
  });

  test("rejects an unknown revision without mutating selection", () => {
    const memory = new ChatSessionMemory();
    memory.hydrateFromConversation(conversation());

    expect(
      memory.switchMessageRevision("assistant-1", "missing"),
    ).toBe(false);
    expect(
      memory.getSnapshot().messageHistory[0].activeRevisionId,
    ).toBe("assistant-1-revision-1");
  });
});

describe("ChatSessionMemory removal", () => {
  test("recalculates the last assistant response after removal", () => {
    const memory = new ChatSessionMemory();
    memory.hydrateFromConversation(
      conversation([
        legacyAssistant("assistant-1", ["First answer"]),
        { id: "user-1", role: "user", content: "Question" },
        legacyAssistant("assistant-2", ["Second answer"]),
      ]),
    );

    expect(memory.removeLastMessage()?.id).toBe("assistant-2");
    expect(memory.getSnapshot().lastAssistantResponse).toBe(
      "First answer",
    );
  });

  test("returns null for an empty history", () => {
    expect(new ChatSessionMemory().removeLastMessage()).toBeNull();
  });
});

describe("ChatSessionMemory Claude Code cursor selection", () => {
  const cursor = (sessionId: string): ClaudeCodeResumeCursor => ({
    sessionId,
    coveredCount: 2,
    prefixHash: "hash",
    configFingerprint: "fingerprint",
  });

  function claudeAssistant(
    id: string,
    resumeCursor?: ClaudeCodeResumeCursor,
  ): ConversationMessage {
    return {
      id,
      role: "assistant",
      content: "Answer",
      revisions: [
        {
          revisionId: `${id}-revision`,
          kind: "turn",
          origin: "generated",
          createdAt: 1,
          provider: "claudecode",
          modelId: "claude-test",
          usage: {
            inputTokens: 1,
            outputTokens: 1,
            ...(resumeCursor ? { resumeCursor } : {}),
          },
          turn: {
            schemaVersion: 1,
            id: `${id}-turn`,
            status: "completed",
            segments: [{ id: `${id}-segment` }],
            items: [
              {
                type: "prose",
                id: `${id}-prose`,
                segmentId: `${id}-segment`,
                text: "Answer",
              },
            ],
          },
        },
      ],
      activeRevisionId: `${id}-revision`,
      actionLedger: [],
    };
  }

  test("returns the newest selected Claude Code revision cursor", () => {
    const memory = new ChatSessionMemory();
    memory.hydrateFromConversation(
      conversation([
        claudeAssistant("assistant-1", cursor("old")),
        { id: "user-1", role: "user", content: "Again" },
        claudeAssistant("assistant-2", cursor("new")),
      ]),
    );

    expect(memory.getClaudeCodeResumeCursor()?.sessionId).toBe("new");
  });

  test("returns undefined when the selected revision has no cursor", () => {
    const memory = new ChatSessionMemory();
    memory.hydrateFromConversation(
      conversation([claudeAssistant("assistant-1")]),
    );

    expect(memory.getClaudeCodeResumeCursor()).toBeUndefined();
  });
});
