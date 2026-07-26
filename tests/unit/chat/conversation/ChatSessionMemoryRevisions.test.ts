import { describe, expect, it } from "vitest";
import { ChatSessionMemory } from "../../../../src/chat/conversation/ChatSessionMemory";
import type {
  AssistantMessageRevision,
  Conversation,
  ConversationMessage,
  ToolActionLedgerEntry,
} from "../../../../src/shared/types";

function legacyRevision(
  revisionId: string,
  content: string,
  provider: "anthropic" | "openai",
  inputTokens: number,
): AssistantMessageRevision {
  return {
    revisionId,
    kind: "legacy",
    content,
    createdAt: inputTokens,
    provider,
    modelId: `${provider}-model`,
    usage: { inputTokens, outputTokens: inputTokens + 1 },
    ragSources: [
      {
        filePath: `${revisionId}.md`,
        headingPath: "",
        score: 0.8,
        content: "transient chunk",
      },
    ],
    rewrittenQuery: `${revisionId} query`,
    isError: revisionId === "revision-1",
    interrupted: revisionId === "revision-1",
    errorMessage: revisionId === "revision-1" ? "Fixture error." : undefined,
  };
}

function pendingLedger(): ToolActionLedgerEntry {
  return {
    actionRef: "action-1",
    revisionId: "revision-1",
    family: "memory",
    placement: {
      state: "unplaced",
      correlation: {
        kind: "none",
        transport: "fixture",
        reason: "Fixture has no declaration.",
      },
      reason: "correlation_unavailable",
    },
    payload: {
      targets: [
        {
          targetId: "target-1",
          mutation: { kind: "forget", name: "fixture-memory" },
        },
      ],
    },
    events: [
      {
        eventId: "event-proposed",
        type: "proposed",
        targetId: "target-1",
        createdAt: 1,
      },
    ],
  };
}

function assistantMessage(): ConversationMessage {
  const revisions = [
    legacyRevision("revision-1", "First.", "anthropic", 10),
    legacyRevision("revision-2", "Second.", "openai", 20),
  ];
  return {
    id: "assistant-1",
    role: "assistant",
    content: "stale top-level content",
    revisions,
    activeRevisionId: "revision-2",
    actionLedger: [pendingLedger()],
    provider: "anthropic",
    modelId: "stale-model",
  };
}

function conversation(message = assistantMessage()): Conversation {
  return {
    id: "conversation-1",
    title: "Fixture",
    createdAt: 1,
    updatedAt: 1,
    modelId: "openai:openai-model",
    modelName: "Fixture",
    messages: [message],
    draft: "",
  };
}

describe("ChatSessionMemory revision ownership", () => {
  it("hydrates and recalculates last response from the selected revision", () => {
    const memory = new ChatSessionMemory();

    memory.hydrateFromConversation(conversation());

    expect(memory.getSnapshot().lastAssistantResponse).toBe("Second.");
  });

  it("uses all visible prose for the last-assistant-response state", () => {
    const message: ConversationMessage = {
      id: "assistant-turn",
      role: "assistant",
      content: "stale",
      revisions: [
        {
          revisionId: "turn-revision",
          kind: "turn",
          origin: "generated",
          createdAt: 1,
          provider: "openai",
          modelId: "gpt-test",
          turn: {
            schemaVersion: 1,
            id: "turn-1",
            status: "completed",
            segments: [{ id: "s1" }],
            items: [
              {
                type: "prose",
                id: "p1",
                segmentId: "s1",
                text: "Before.",
              },
              {
                type: "prose",
                id: "p2",
                segmentId: "s1",
                text: "After.",
              },
            ],
          },
        },
      ],
      activeRevisionId: "turn-revision",
    };
    const memory = new ChatSessionMemory();

    memory.hydrateFromConversation(conversation(message));

    expect(memory.getSnapshot().lastAssistantResponse).toBe(
      "Before.\n\nAfter.",
    );
  });

  it("switches by revision ID with complete compatibility metadata and no ledger event", () => {
    const memory = new ChatSessionMemory();
    memory.hydrateFromConversation(conversation());
    const beforeEvents = structuredClone(
      memory.getSnapshot().messageHistory[0].actionLedger,
    );

    expect(
      memory.switchMessageRevision("assistant-1", "revision-1"),
    ).toBe(true);

    const snapshot = memory.getSnapshot();
    const message = snapshot.messageHistory[0];
    expect(message.activeRevisionId).toBe("revision-1");
    expect(message.content).toBe("First.");
    expect(message.provider).toBe("anthropic");
    expect(message.modelId).toBe("anthropic-model");
    expect(message.usage?.inputTokens).toBe(10);
    expect(message.ragSources?.[0]?.filePath).toBe("revision-1.md");
    expect(message.rewrittenQuery).toBe("revision-1 query");
    expect(message.isError).toBe(true);
    expect(message.interrupted).toBe(true);
    expect(message.actionLedger).toEqual(beforeEvents);
    expect(snapshot.lastAssistantResponse).toBe("First.");
  });

  it("selects a revision without updating load-only legacy indices", () => {
    const memory = new ChatSessionMemory();
    const message = assistantMessage();
    message.versions = [
      { content: "stale first", createdAt: 1 },
      { content: "stale second", createdAt: 2 },
    ];
    message.activeVersionIndex = 1;
    memory.hydrateFromConversation(conversation(message));

    expect(
      memory.switchMessageRevision("assistant-1", "revision-1"),
    ).toBe(true);

    const selected = memory.getSnapshot().messageHistory[0];
    expect(selected.activeRevisionId).toBe("revision-1");
    expect(selected.content).toBe("First.");
    expect(selected.versions?.[0]?.content).toBe("stale first");
    expect(selected.activeVersionIndex).toBe(1);
  });

  it("atomically appends, selects, and supersedes unresolved replacement work", () => {
    const memory = new ChatSessionMemory();
    const message = assistantMessage();
    message.activeRevisionId = "revision-1";
    memory.hydrateFromConversation(conversation(message));
    const replacement = legacyRevision(
      "revision-3",
      "Replacement.",
      "openai",
      30,
    );

    expect(
      memory.commitRevisionReplacement(
        "assistant-1",
        replacement,
        (actionRef, targetId) => ({
          eventId: `supersede-${actionRef}-${targetId}`,
          createdAt: 2,
        }),
      ),
    ).toBe(true);

    const committed = memory.getSnapshot().messageHistory[0];
    expect(committed.revisions?.map((revision) => revision.revisionId)).toEqual([
      "revision-1",
      "revision-2",
      "revision-3",
    ]);
    expect(committed.activeRevisionId).toBe("revision-3");
    expect(committed.content).toBe("Replacement.");
    expect(committed.actionLedger?.[0].events).toEqual([
      {
        eventId: "event-proposed",
        type: "proposed",
        targetId: "target-1",
        createdAt: 1,
      },
      {
        eventId: "supersede-action-1-target-1",
        type: "superseded",
        targetId: "target-1",
        createdAt: 2,
        replacementRevisionId: "revision-3",
      },
    ]);
  });

  it("persists selected compatibility fields and strips RAG content inside revisions", () => {
    const memory = new ChatSessionMemory();
    memory.hydrateFromConversation(conversation());

    const persisted = memory.getCleanMessagesForPersistence()[0];
    const active = persisted.revisions?.find(
      (revision) => revision.revisionId === persisted.activeRevisionId,
    );

    expect(persisted.content).toBe("Second.");
    expect(persisted.provider).toBe("openai");
    expect(persisted.ragSources?.[0].content).toBeUndefined();
    expect(active?.ragSources?.[0].content).toBeUndefined();
  });

  it("returns an independent structured branch prefix with its message-local ledger", () => {
    const memory = new ChatSessionMemory();
    const source = conversation();
    source.messages.push({
      id: "user-after",
      role: "user",
      content: "Not part of this branch.",
    });
    memory.hydrateFromConversation(source);

    const branchPrefix = memory.getMessagesUpToInclusive("assistant-1");
    const branchRevision = branchPrefix[0].revisions?.[0];
    if (branchRevision?.kind === "legacy") {
      branchRevision.content = "Changed in branch.";
    }
    branchPrefix[0].actionLedger?.[0].events.push({
      eventId: "branch-only",
      type: "declined",
      targetId: "target-1",
      createdAt: 2,
    });

    const original = memory.getSnapshot().messageHistory[0];
    expect(branchPrefix).toHaveLength(1);
    expect(
      original.revisions?.[0].kind === "legacy"
        ? original.revisions[0].content
        : null,
    ).toBe("First.");
    expect(original.actionLedger?.[0].events).toHaveLength(1);
  });
});
