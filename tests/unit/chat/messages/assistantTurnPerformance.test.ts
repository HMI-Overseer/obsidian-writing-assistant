import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import type {
  AssistantMessageRevision,
  AssistantTurnRecord,
  Conversation,
  ConversationMessage,
} from "../../../../src/shared/types";
import { ChatSessionMemory } from "../../../../src/chat/conversation/ChatSessionMemory";
import {
  normalizeConversation,
} from "../../../../src/chat/conversation/conversationUtils";
import {
  buildAssistantTurnRenderModel,
  planAssistantTurnRenderUpdate,
} from "../../../../src/chat/messages/assistantTurnRenderModel";

function longTurn(toolState: "running" | "completed"): AssistantTurnRecord {
  const segments = Array.from({ length: 60 }, (_, index) => ({
    id: `segment-${index}`,
  }));
  const items: AssistantTurnRecord["items"] = [];
  for (let index = 0; index < 60; index += 1) {
    items.push({
      type: "prose",
      id: `prose-${index}`,
      segmentId: `segment-${index}`,
      text:
        `## Section ${index}\n\n` +
        `${"Long markdown sentence. ".repeat(80)}\n\n` +
        "- First item\n- Second item\n\n```ts\nconst value = true;\n```",
    });
    items.push({
      type: "tool_call",
      id: `tool-${index}`,
      segmentId: `segment-${index}`,
      toolCallId: `call-${index}`,
      toolName: index % 2 === 0 ? "read_file" : "edit",
      toolArguments: `{"path":"Fixture-${index}.md"}`,
      toolArgs: { path: `Fixture-${index}.md` },
      state: index === 37 ? toolState : "completed",
      resultDigest: `[read_file: Fixture-${index}.md]`,
    });
  }
  return {
    schemaVersion: 1,
    id: "long-turn",
    status: toolState === "running" ? "streaming" : "completed",
    segments,
    items,
  };
}

describe("assistant turn long-update performance", () => {
  it("identifies one changed host in a 120-item lifecycle update", () => {
    const before = buildAssistantTurnRenderModel(longTurn("running"));
    const after = buildAssistantTurnRenderModel(longTurn("completed"));

    const plan = planAssistantTurnRenderUpdate(
      before.items,
      after.items,
    );

    expect(plan.order).toHaveLength(120);
    expect(plan.added).toEqual([]);
    expect(plan.removed).toEqual([]);
    expect(plan.updated).toEqual(["tool-37"]);
  });

  it("keeps repeated keyed planning within a generous linear-time budget", () => {
    let before = buildAssistantTurnRenderModel(longTurn("running"));
    const startedAt = performance.now();
    for (let index = 0; index < 250; index += 1) {
      const after = buildAssistantTurnRenderModel(
        longTurn(index % 2 === 0 ? "completed" : "running"),
      );
      const plan = planAssistantTurnRenderUpdate(
        before.items,
        after.items,
      );
      expect(plan.updated.length).toBeLessThanOrEqual(1);
      before = after;
    }
    const elapsedMs = performance.now() - startedAt;

    expect(elapsedMs).toBeLessThan(2_000);
  });

  it("reloads and swaps a bounded 100-revision history within a generous budget", () => {
    const revisions: AssistantMessageRevision[] = Array.from(
      { length: 100 },
      (_, index) => ({
        revisionId: `revision-${index}`,
        kind: "turn",
        origin: index === 0 ? "generated" : "regenerated",
        ...(index === 0
          ? {}
          : { parentRevisionId: `revision-${index - 1}` }),
        createdAt: index + 1,
        provider: "openai",
        modelId: "gpt-fixture",
        turn: {
          schemaVersion: 1,
          id: `turn-${index}`,
          status: "completed",
          segments: [{ id: `segment-${index}` }],
          items: [
            {
              type: "prose",
              id: `prose-${index}`,
              segmentId: `segment-${index}`,
              text: `Revision ${index}: ${"Long prose. ".repeat(200)}`,
            },
          ],
        },
      }),
    );
    const message: ConversationMessage = {
      id: "assistant-long-history",
      role: "assistant",
      content: "stale",
      revisions,
      activeRevisionId: "revision-99",
      actionLedger: [],
    };
    const conversation: Conversation = {
      id: "conversation-long-history",
      title: "Long history",
      createdAt: 1,
      updatedAt: 2,
      modelId: "openai:gpt-fixture",
      modelName: "GPT fixture",
      messages: [message],
      draft: "",
    };

    const startedAt = performance.now();
    const normalized = normalizeConversation(
      JSON.parse(JSON.stringify(conversation)),
    );
    if (!normalized) throw new Error("Expected history to normalize.");
    const memory = new ChatSessionMemory();
    memory.hydrateFromConversation(normalized);
    for (let index = 0; index < 250; index += 1) {
      expect(
        memory.switchMessageRevision(
          message.id,
          `revision-${index % revisions.length}`,
        ),
      ).toBe(true);
    }
    const elapsedMs = performance.now() - startedAt;

    expect(memory.getSnapshot().messageHistory[0].revisions).toHaveLength(100);
    expect(elapsedMs).toBeLessThan(2_000);
  });
});
