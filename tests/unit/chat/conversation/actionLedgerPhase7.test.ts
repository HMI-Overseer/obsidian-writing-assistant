import { describe, expect, it } from "vitest";
import { ChatSessionMemory } from "../../../../src/chat/conversation/ChatSessionMemory";
import type {
  Conversation,
  ConversationMessage,
  ToolActionEvent,
  ToolActionLedgerEntry,
} from "../../../../src/shared/types";

function entry(
  events: ToolActionEvent[] = [
    {
      eventId: "proposed-1",
      type: "proposed",
      targetId: "target-1",
      createdAt: 1,
    },
  ],
): ToolActionLedgerEntry {
  return {
    actionRef: "action-1",
    revisionId: "revision-1",
    family: "memory",
    placement: {
      state: "placed",
      anchor: "tool_call",
      itemId: "item-1",
      correlation: {
        kind: "provider_id",
        toolCallId: "call-1",
      },
    },
    payload: {
      targets: [
        {
          targetId: "target-1",
          mutation: { kind: "forget", name: "fixture-memory" },
        },
      ],
    },
    events,
  };
}

function assistant(action = entry()): ConversationMessage {
  return {
    id: "assistant-1",
    role: "assistant",
    content: "Fixture.",
    revisions: [
      {
        revisionId: "revision-1",
        kind: "turn",
        origin: "generated",
        createdAt: 1,
        provider: "openai",
        modelId: "gpt-test",
        turn: {
          schemaVersion: 1,
          id: "turn-1",
          status: "completed",
          segments: [{ id: "segment-1" }],
          items: [
            {
              type: "tool_call",
              id: "item-1",
              segmentId: "segment-1",
              toolCallId: "call-1",
              toolName: "forget_memory",
              toolArguments: "{}",
              toolArgs: {},
              state: "completed",
              actionRef: "action-1",
            },
          ],
        },
      },
    ],
    activeRevisionId: "revision-1",
    actionLedger: [action],
  };
}

function conversation(messages: ConversationMessage[]): Conversation {
  return {
    id: "conversation-1",
    title: "Fixture",
    createdAt: 1,
    updatedAt: 1,
    modelId: "openai:gpt-test",
    modelName: "GPT test",
    messages,
    draft: "",
  };
}

describe("message-local action eligibility", () => {
  it("allows approve and decline only on the active conversation head", () => {
    const memory = new ChatSessionMemory();
    memory.hydrateFromConversation(conversation([assistant()]));

    expect(
      memory.getActionControlEligibility(
        "assistant-1",
        "action-1",
        "target-1",
      ),
    ).toMatchObject({
      canApprove: true,
      canDecline: true,
      canApply: false,
      canRetry: false,
      canUndo: false,
    });

    memory.appendMessage({
      id: "user-2",
      role: "user",
      content: "Moved on.",
    });

    expect(
      memory.getActionControlEligibility(
        "assistant-1",
        "action-1",
        "target-1",
      ),
    ).toMatchObject({
      canApprove: false,
      canDecline: false,
      canApply: false,
      canRetry: false,
    });
  });

  it("rejects ineligible events and appends eligible events without rewriting history", () => {
    const memory = new ChatSessionMemory();
    memory.hydrateFromConversation(conversation([assistant()]));
    const approved: ToolActionEvent = {
      eventId: "approved-1",
      type: "approved",
      targetId: "target-1",
      createdAt: 2,
    };

    expect(
      memory.appendEligibleActionEvent(
        "assistant-1",
        "action-1",
        approved,
      ),
    ).toBe(true);
    expect(
      memory.appendEligibleActionEvent(
        "assistant-1",
        "action-1",
        structuredClone(approved),
      ),
    ).toBe(true);
    expect(
      memory.getSnapshot().messageHistory[0].actionLedger?.[0].events,
    ).toEqual([
      {
        eventId: "proposed-1",
        type: "proposed",
        targetId: "target-1",
        createdAt: 1,
      },
      approved,
    ]);

    memory.appendMessage({
      id: "user-2",
      role: "user",
      content: "Moved on.",
    });
    expect(
      memory.appendEligibleActionEvent(
        "assistant-1",
        "action-1",
        {
          eventId: "failed-1",
          type: "apply_failed",
          targetId: "target-1",
          createdAt: 3,
          error: "Should be gated.",
        },
      ),
    ).toBe(false);
  });

  it("keeps Undo eligible from a historical revision that still references the effect", () => {
    const applied = entry([
      {
        eventId: "proposed-1",
        type: "proposed",
        targetId: "target-1",
        createdAt: 1,
      },
      {
        eventId: "applied-1",
        type: "apply_succeeded",
        targetId: "target-1",
        createdAt: 2,
        effect: {
          family: "memory",
          before: {
            name: "fixture-memory",
            type: "rule",
            description: "Fixture.",
            enabled: true,
          },
          after: null,
          appliedAt: 2,
        },
      },
    ]);
    const message = assistant(applied);
    const source = message.revisions?.[0];
    if (source?.kind !== "turn") throw new Error("Expected a turn revision.");
    message.revisions?.push({
      ...structuredClone(source),
      revisionId: "revision-2",
      origin: "edited",
      parentRevisionId: "revision-1",
      turn: {
        ...structuredClone(source.turn),
        id: "turn-2",
        items: source.turn.items.map((item) => ({
          ...structuredClone(item),
          id: "item-2",
          sourceItemId: item.id,
        })),
      },
    });
    message.activeRevisionId = "revision-2";
    const memory = new ChatSessionMemory();
    memory.hydrateFromConversation(conversation([message]));

    expect(
      memory.getActionControlEligibility(
        "assistant-1",
        "action-1",
        "target-1",
      ),
    ).toMatchObject({
      canApprove: false,
      canApply: false,
      canRetry: false,
      canUndo: true,
    });
  });

  it("keeps inherited branch work historical while preserving its Undo evidence", () => {
    const applied = entry([
      {
        eventId: "proposed-1",
        type: "proposed",
        targetId: "target-1",
        createdAt: 1,
      },
      {
        eventId: "applied-1",
        type: "apply_succeeded",
        targetId: "target-1",
        createdAt: 2,
        effect: {
          family: "memory",
          before: null,
          after: {
            name: "fixture-memory",
            type: "rule",
            description: "Fixture.",
            enabled: true,
          },
          appliedAt: 2,
        },
      },
    ]);
    const branch = conversation([assistant(applied)]);
    branch.createdAt = 10;
    branch.parentConversationId = "source-conversation";
    branch.branchFromMessageId = "assistant-1";
    const memory = new ChatSessionMemory();
    memory.hydrateFromConversation(branch);

    expect(
      memory.getActionControlEligibility(
        "assistant-1",
        "action-1",
        "target-1",
      ),
    ).toMatchObject({
      canApprove: false,
      canDecline: false,
      canApply: false,
      canRetry: false,
      canUndo: true,
    });
  });
});
