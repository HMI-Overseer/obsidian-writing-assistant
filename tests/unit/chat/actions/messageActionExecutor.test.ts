import { describe, expect, it, vi } from "vitest";
import { executeMessageAction } from "../../../../src/chat/actions/messageActionExecutor";
import { ChatSessionMemory } from "../../../../src/chat/conversation/ChatSessionMemory";
import type { ChatSessionStore } from "../../../../src/chat/conversation/ChatSessionStore";
import type WritingAssistantChat from "../../../../src/main";
import type {
  Conversation,
  ConversationMessage,
  Memory,
} from "../../../../src/shared/types";

function message(): ConversationMessage {
  return {
    id: "assistant-1",
    role: "assistant",
    content: "",
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
              toolName: "add_memory",
              toolArguments: "{}",
              state: "completed",
              actionRef: "action-1",
            },
          ],
        },
      },
    ],
    activeRevisionId: "revision-1",
    actionLedger: [
      {
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
              mutation: {
                kind: "add",
                memory: {
                  name: "fixture-memory",
                  type: "rule",
                  description: "Keep the fixture stable.",
                  enabled: true,
                },
              },
            },
          ],
        },
        events: [
          {
            eventId: "proposed-1",
            type: "proposed",
            targetId: "target-1",
            createdAt: 1,
          },
          {
            eventId: "approved-1",
            type: "approved",
            targetId: "target-1",
            createdAt: 2,
          },
        ],
      },
    ],
  };
}

function harness() {
  const memory = new ChatSessionMemory();
  const conversation: Conversation = {
    id: "conversation-1",
    title: "Fixture",
    createdAt: 1,
    updatedAt: 1,
    modelId: "openai:gpt-test",
    modelName: "GPT test",
    messages: [message()],
    draft: "",
  };
  memory.hydrateFromConversation(conversation);
  const store = {
    getSnapshot: () => memory.getSnapshot(),
    appendEligibleActionEvent: (
      messageId: string,
      actionRef: string,
      event: Parameters<
        ChatSessionMemory["appendEligibleActionEvent"]
      >[2],
    ) =>
      memory.appendEligibleActionEvent(
        messageId,
        actionRef,
        event,
      ),
  } as ChatSessionStore;
  const memories: Memory[] = [];
  const invalidateAll = vi.fn();
  const saveSettings = vi.fn().mockResolvedValue(undefined);
  const plugin = {
    app: {},
    settings: { memories },
    services: {
      memoryService: { invalidateAll },
    },
    saveSettings,
  } as unknown as WritingAssistantChat;
  return { memory, store, plugin, memories, invalidateAll, saveSettings };
}

describe("message action executor", () => {
  it("applies and undoes a memory target while appending effect history", async () => {
    const { memory, store, plugin, memories, invalidateAll } =
      harness();

    await expect(
      executeMessageAction({
        plugin,
        store,
        messageId: "assistant-1",
        actionRef: "action-1",
        targetId: "target-1",
        control: "apply",
      }),
    ).resolves.toBe(true);
    expect(memories).toEqual([
      expect.objectContaining({ name: "fixture-memory" }),
    ]);

    await expect(
      executeMessageAction({
        plugin,
        store,
        messageId: "assistant-1",
        actionRef: "action-1",
        targetId: "target-1",
        control: "undo",
      }),
    ).resolves.toBe(true);
    expect(memories).toEqual([]);
    expect(invalidateAll).toHaveBeenCalledOnce();
    expect(
      memory.getSnapshot().messageHistory[0].actionLedger?.[0].events
        .map((event) => event.type),
    ).toEqual([
      "proposed",
      "approved",
      "apply_succeeded",
      "undo_succeeded",
    ]);
    expect(
      memory.getActionControlEligibility(
        "assistant-1",
        "action-1",
        "target-1",
      ).canRetry,
    ).toBe(true);
  });

  it("records an undo refusal without erasing the applied effect", async () => {
    const { memory, store, plugin, memories } = harness();
    await executeMessageAction({
      plugin,
      store,
      messageId: "assistant-1",
      actionRef: "action-1",
      targetId: "target-1",
      control: "apply",
    });
    memories[0].description = "Drifted after apply.";

    await expect(
      executeMessageAction({
        plugin,
        store,
        messageId: "assistant-1",
        actionRef: "action-1",
        targetId: "target-1",
        control: "undo",
      }),
    ).resolves.toBe(true);

    const events =
      memory.getSnapshot().messageHistory[0].actionLedger?.[0].events ??
      [];
    expect(events.map((event) => event.type)).toEqual([
      "proposed",
      "approved",
      "apply_succeeded",
      "undo_refused",
    ]);
    expect(memories[0].description).toBe("Drifted after apply.");
  });
});
