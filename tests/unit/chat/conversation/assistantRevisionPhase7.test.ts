import { describe, expect, it } from "vitest";
import {
  isMeaningfulAssistantReplacement,
} from "../../../../src/chat/conversation/assistantRevisions";
import { ChatSessionMemory } from "../../../../src/chat/conversation/ChatSessionMemory";
import type {
  AssistantReplayEvidence,
  AssistantTurnRecord,
  Conversation,
  ConversationMessage,
  ToolActionLedgerEntry,
} from "../../../../src/shared/types";

const STRUCTURAL_EVIDENCE: AssistantReplayEvidence = {
  tier: "structural",
  capabilities: {
    captureOrder: "exact",
    toolCorrelation: "provider_id",
    coldReplay: "structural",
    nativeResume: false,
  },
};

function turn(items: AssistantTurnRecord["items"] = []): AssistantTurnRecord {
  return {
    schemaVersion: 1,
    id: "turn-1",
    status: "completed",
    segments: items.length > 0 ? [{ id: "segment-1" }] : [],
    items,
  };
}

function ledger(): ToolActionLedgerEntry {
  return {
    actionRef: "action-edit",
    revisionId: "revision-1",
    family: "edit",
    placement: {
      state: "placed",
      anchor: "tool_call",
      itemId: "tool-item",
      correlation: {
        kind: "provider_id",
        toolCallId: "tool-call",
      },
    },
    payload: {
      proposalId: "proposal-1",
      targets: [
        {
          targetId: "hunk-1",
          targetFilePath: "Fixture.md",
          documentSnapshot: "before",
          snapshotTimestamp: 1,
          resolvedEdit: {
            id: "resolved-1",
            editBlock: {
              id: "tool-call",
              searchText: "before",
              replaceText: "after",
              rawBlock: "",
              targetPath: "Fixture.md",
            },
            matchOffset: 0,
            matchLength: 6,
            matchedText: "before",
            startLine: 1,
            endLine: 1,
            contextBefore: [],
            contextAfter: [],
            confidence: 1,
            matchType: "exact",
          },
        },
      ],
    },
    events: [
      {
        eventId: "proposed-1",
        type: "proposed",
        targetId: "hunk-1",
        createdAt: 1,
      },
    ],
  };
}

function assistant(): ConversationMessage {
  return {
    id: "assistant-1",
    role: "assistant",
    content: "stale",
    revisions: [
      {
        revisionId: "revision-1",
        kind: "turn",
        origin: "generated",
        createdAt: 1,
        provider: "claudecode",
        modelId: "claude-test",
        usage: {
          inputTokens: 10,
          outputTokens: 5,
          resumeCursor: {
            sessionId: "session-1",
            coveredCount: 2,
            prefixHash: "prefix-1",
            configFingerprint: "config-1",
          },
        },
        replayEvidence: {
          tier: "native",
          capabilities: {
            captureOrder: "exact",
            toolCorrelation: "provider_id",
            coldReplay: "textual",
            nativeResume: true,
          },
        },
        turn: turn([
          {
            type: "prose",
            id: "prose-before",
            segmentId: "segment-1",
            text: "Before.",
          },
          {
            type: "tool_call",
            id: "tool-item",
            segmentId: "segment-1",
            toolCallId: "tool-call",
            toolName: "edit",
            toolArguments: "{}",
            toolArgs: {},
            state: "completed",
            actionRef: "action-edit",
          },
          {
            type: "prose",
            id: "prose-after",
            segmentId: "segment-1",
            text: "After.",
          },
        ]),
      },
    ],
    activeRevisionId: "revision-1",
    actionLedger: [ledger()],
  };
}

function conversation(messages: ConversationMessage[] = [assistant()]): Conversation {
  return {
    id: "conversation-1",
    title: "Phase 7 fixture",
    createdAt: 1,
    updatedAt: 1,
    modelId: "claudecode:claude-test",
    modelName: "Claude test",
    messages,
    draft: "",
  };
}

describe("meaningful assistant replacement", () => {
  it("rejects an empty direct replacement but retains content and tool declarations", () => {
    expect(
      isMeaningfulAssistantReplacement({
        provider: "openai",
        turn: turn(),
        replayEvidence: STRUCTURAL_EVIDENCE,
      }),
    ).toBe(false);
    expect(
      isMeaningfulAssistantReplacement({
        provider: "openai",
        turn: turn([
          {
            type: "prose",
            id: "prose-1",
            segmentId: "segment-1",
            text: "Partial.",
          },
        ]),
        replayEvidence: STRUCTURAL_EVIDENCE,
      }),
    ).toBe(true);
    expect(
      isMeaningfulAssistantReplacement({
        provider: "openai",
        turn: turn([
          {
            type: "tool_call",
            id: "tool-1",
            segmentId: "segment-1",
            toolCallId: "call-1",
            toolName: "read_file",
            toolArguments: "{}",
            toolArgs: {},
            state: "interrupted",
          },
        ]),
        replayEvidence: STRUCTURAL_EVIDENCE,
      }),
    ).toBe(true);
  });

  it("retains an empty Claude turn when native-linearity evidence requires it", () => {
    expect(
      isMeaningfulAssistantReplacement({
        provider: "claudecode",
        turn: turn(),
        replayEvidence: {
          tier: "native",
          capabilities: {
            captureOrder: "exact",
            toolCorrelation: "provider_id",
            coldReplay: "textual",
            nativeResume: true,
          },
        },
        usage: {
          inputTokens: 10,
          outputTokens: 0,
          resumeCursor: {
            sessionId: "session-2",
            coveredCount: 4,
            prefixHash: "prefix-2",
            configFingerprint: "config-2",
          },
        },
      }),
    ).toBe(true);
  });
});

describe("turn-scoped assistant editing", () => {
  it("copies every item, replaces only the addressed prose, and supersedes pending work", () => {
    const memory = new ChatSessionMemory();
    memory.hydrateFromConversation(conversation());
    const before = structuredClone(memory.getSnapshot().messageHistory[0]);

    expect(
      memory.editAssistantTurnProse("assistant-1", [
        { sourceProseItemId: "prose-after", text: "Edited after." },
      ]),
    ).toBe(true);

    const message = memory.getSnapshot().messageHistory[0];
    const revisions = message.revisions ?? [];
    const source = revisions[0];
    const edited = revisions[1];
    expect(source).toEqual(before.revisions?.[0]);
    expect(edited).toMatchObject({
      kind: "turn",
      origin: "edited",
      parentRevisionId: "revision-1",
    });
    if (edited?.kind !== "turn") throw new Error("Expected an edited turn.");
    expect(edited.turn.items.map((item) => item.sourceItemId)).toEqual([
      "prose-before",
      "tool-item",
      "prose-after",
    ]);
    expect(new Set(edited.turn.items.map((item) => item.id)).size).toBe(3);
    expect(
      edited.turn.items.every(
        (item) =>
          item.id !== "prose-before" &&
          item.id !== "tool-item" &&
          item.id !== "prose-after",
      ),
    ).toBe(true);
    expect(edited.turn.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "prose",
          sourceItemId: "prose-before",
          text: "Before.",
        }),
        expect.objectContaining({
          type: "tool_call",
          sourceItemId: "tool-item",
          toolCallId: "tool-call",
          actionRef: "action-edit",
          state: "completed",
        }),
        expect.objectContaining({
          type: "prose",
          sourceItemId: "prose-after",
          text: "Edited after.",
        }),
      ]),
    );
    expect(message.actionLedger).toHaveLength(1);
    expect(message.actionLedger?.[0].events.map((event) => event.type)).toEqual([
      "proposed",
      "superseded",
    ]);
    expect(message.activeRevisionId).toBe(edited.revisionId);
  });

  it("commits one revision for a session that changes every prose item", () => {
    const memory = new ChatSessionMemory();
    memory.hydrateFromConversation(conversation());

    expect(
      memory.editAssistantTurnProse("assistant-1", [
        { sourceProseItemId: "prose-before", text: "Edited before." },
        { sourceProseItemId: "prose-after", text: "Edited after." },
      ]),
    ).toBe(true);

    const message = memory.getSnapshot().messageHistory[0];
    expect(message.revisions).toHaveLength(2);
    const edited = message.revisions?.[1];
    if (edited?.kind !== "turn") throw new Error("Expected an edited turn.");
    expect(
      edited.turn.items.map((item) =>
        item.type === "prose" ? item.text : item.type,
      ),
    ).toEqual(["Edited before.", "tool_call", "Edited after."]);
    expect(message.activeRevisionId).toBe(edited.revisionId);
  });

  it("refuses a session that addresses a tool item or changes nothing", () => {
    const memory = new ChatSessionMemory();
    memory.hydrateFromConversation(conversation());

    expect(
      memory.editAssistantTurnProse("assistant-1", [
        { sourceProseItemId: "tool-item", text: "No." },
      ]),
    ).toBe(false);
    expect(
      memory.editAssistantTurnProse("assistant-1", [
        { sourceProseItemId: "prose-before", text: "Fine." },
        { sourceProseItemId: "tool-item", text: "No." },
      ]),
    ).toBe(false);
    expect(memory.editAssistantTurnProse("assistant-1", [])).toBe(false);
    expect(
      memory.getSnapshot().messageHistory[0].revisions,
    ).toHaveLength(1);
  });

  it("invalidates the copied Claude resume cursor on an edit", () => {
    const memory = new ChatSessionMemory();
    memory.hydrateFromConversation(conversation());

    expect(
      memory.editAssistantTurnProse("assistant-1", [
        { sourceProseItemId: "prose-after", text: "Changed." },
      ]),
    ).toBe(true);
    const edited =
      memory.getSnapshot().messageHistory[0].revisions?.at(-1);
    expect(edited?.usage?.resumeCursor).toBeUndefined();
    expect(
      edited?.kind === "turn" ? edited.replayEvidence : undefined,
    ).toMatchObject({
      tier: "textual",
      loweredReason: "history-edited",
    });
    expect(memory.getClaudeCodeResumeCursor()).toBeUndefined();
  });

  it("deleting an assistant message removes its complete local ledger", () => {
    const memory = new ChatSessionMemory();
    memory.hydrateFromConversation(conversation());

    const removed = memory.removeMessage("assistant-1");

    expect(removed?.actionLedger).toHaveLength(1);
    expect(memory.getSnapshot().messageHistory).toEqual([]);
  });
});
