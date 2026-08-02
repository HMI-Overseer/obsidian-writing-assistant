import { describe, expect, it } from "vitest";
import {
  createAssistantTurnRevision,
  createAssistantTurnMessage,
} from "../../../../src/chat/finalization/assistantTurnFinalization";
import { ChatSessionMemory } from "../../../../src/chat/conversation/ChatSessionMemory";
import {
  createBranchConversation,
  normalizeConversation,
  toConversationMeta,
} from "../../../../src/chat/conversation/conversationUtils";
import type {
  AssistantTurnRecord,
  Conversation,
  ConversationMessage,
} from "../../../../src/shared/types";

function rawConversation(message: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "conversation-legacy",
    title: "Phase 8 compatibility",
    createdAt: 1,
    updatedAt: 2,
    modelId: "anthropic:claude-fixture",
    modelName: "Claude fixture",
    messages: [message],
    draft: "",
  };
}

function turn(id: string, proseId: string, text: string): AssistantTurnRecord {
  const segmentId = `segment-${id}`;
  return {
    schemaVersion: 1,
    id,
    status: "completed",
    segments: [{ id: segmentId }],
    items: [
      {
        type: "prose",
        id: proseId,
        segmentId,
        text,
      },
    ],
  };
}

function loadedConversation(message: Record<string, unknown>): Conversation {
  const loaded = normalizeConversation(rawConversation(message));
  if (!loaded) throw new Error("Expected the legacy fixture to load.");
  return loaded;
}

describe("Phase 8 mixed-history compatibility", () => {
  it("preserves legacy prose, steps, reviews, effects, and Claude diagnostics", () => {
    const conversation = loadedConversation({
      id: "assistant-legacy",
      role: "assistant",
      content: "Partial legacy response.",
      provider: "claudecode",
      modelId: "claude-fixture",
      interrupted: true,
      errorMessage: "<provider-error>fixture</provider-error>",
      agenticSteps: [
        {
          type: "tool_call",
          round: 0,
          toolName: "read",
          toolCallId: "legacy-call",
          toolInput: "Fixture.md",
          resultDigest: "[read: Fixture.md]",
        },
      ],
      editProposals: [
        {
          id: "edit-1",
          targetFilePath: "Fixture.md",
          documentSnapshot: "before",
          snapshotTimestamp: 3,
          hunks: [],
          prose: "Legacy edit.",
        },
      ],
      vaultOpProposal: {
        id: "vault-1",
        createdAt: 4,
        ops: [
          {
            id: "op-1",
            op: { kind: "createDir", path: "Fixture" },
            gate: "ask",
            status: "applied",
            summary: "Create Fixture",
            sourceToolCallId: "legacy-call",
          },
        ],
      },
      appliedVaultOps: {
        proposalId: "vault-1",
        applied: [
          {
            opId: "op-1",
            inverse: { kind: "trashFolder", path: "Fixture" },
          },
        ],
        appliedAt: 5,
      },
    });
    const message = conversation.messages[0];
    const revision = message.revisions?.[0];

    expect(revision).toMatchObject({
      kind: "legacy",
      provider: "claudecode",
      modelId: "claude-fixture",
      interrupted: true,
      errorMessage: "<provider-error>fixture</provider-error>",
      legacySteps: [
        {
          toolCallId: "legacy-call",
          resultDigest: "[read: Fixture.md]",
        },
      ],
    });
    expect(message.editProposals?.[0]?.id).toBe("edit-1");
    expect(message.vaultOpProposal?.id).toBe("vault-1");
    expect(message.appliedVaultOps?.proposalId).toBe("vault-1");
  });

  it("upgrades, edits, regenerates, switches, branches, reloads, and continues", () => {
    const loaded = loadedConversation({
      id: "assistant-legacy",
      role: "assistant",
      content: "Legacy prose.",
      versions: [
        { content: "Earlier prose.", createdAt: 10 },
        { content: "Legacy prose.", createdAt: 20 },
      ],
      activeVersionIndex: 1,
    });
    const memory = new ChatSessionMemory();
    memory.hydrateFromConversation(loaded);
    const legacyMessage = memory.getSnapshot().messageHistory[0];
    const legacyRevisionId = legacyMessage.activeRevisionId;
    if (!legacyRevisionId) throw new Error("Missing legacy revision.");

    const regenerated = createAssistantTurnRevision({
      revisionId: "revision-regenerated",
      origin: "regenerated",
      parentRevisionId: legacyRevisionId,
      createdAt: 30,
      provider: "openai",
      modelId: "gpt-fixture",
      turn: turn("turn-regenerated", "prose-regenerated", "Regenerated prose."),
    });
    expect(
      memory.commitRevisionReplacement(
        "assistant-legacy",
        regenerated,
        (_actionRef, _targetId, index) => ({
          eventId: `superseded-regenerated-${index}`,
          createdAt: 30 + index,
        }),
      ),
    ).toBe(true);
    expect(
      memory.editAssistantTurnProse("assistant-legacy", [
        { sourceProseItemId: "prose-regenerated", text: "Edited prose." },
      ]),
    ).toBe(true);
    const editedMessage = memory.getSnapshot().messageHistory[0];
    const editedRevisionId = editedMessage.activeRevisionId;
    if (!editedRevisionId) throw new Error("Missing edited revision.");

    const regeneratedAgain = createAssistantTurnRevision({
      revisionId: "revision-regenerated-again",
      origin: "regenerated",
      parentRevisionId: editedRevisionId,
      createdAt: Date.now() + 1,
      provider: "anthropic",
      modelId: "claude-fixture",
      turn: turn(
        "turn-regenerated-again",
        "prose-regenerated-again",
        "Regenerated again.",
      ),
    });
    expect(
      memory.commitRevisionReplacement(
        "assistant-legacy",
        regeneratedAgain,
        (_actionRef, _targetId, index) => ({
          eventId: `superseded-again-${index}`,
          createdAt: regeneratedAgain.createdAt + index,
        }),
      ),
    ).toBe(true);
    expect(
      memory.switchMessageRevision("assistant-legacy", legacyRevisionId),
    ).toBe(true);
    expect(memory.getSnapshot().lastAssistantResponse).toBe("Legacy prose.");
    expect(
      memory.switchMessageRevision(
        "assistant-legacy",
        regeneratedAgain.revisionId,
      ),
    ).toBe(true);

    const messages = memory.getMessagesUpToInclusive("assistant-legacy");
    const branch = createBranchConversation(
      toConversationMeta(loaded),
      messages,
      "assistant-legacy",
    );
    branch.messages.push({ id: "user-continued", role: "user", content: "Continue." });
    branch.messages.push(
      createAssistantTurnMessage({
        messageId: "assistant-continued",
        revision: createAssistantTurnRevision({
          revisionId: "revision-continued",
          origin: "generated",
          createdAt: Date.now() + 2,
          provider: "anthropic",
          modelId: "claude-fixture",
          turn: turn("turn-continued", "prose-continued", "Continued."),
        }),
        actionLedger: [],
      }),
    );

    const reloaded = normalizeConversation(
      JSON.parse(JSON.stringify(branch)),
    );
    if (!reloaded) throw new Error("Expected the mixed branch to reload.");
    const reloadedChain = reloaded.messages[0];
    const reloadedContinuation = reloaded.messages[2];

    expect(reloadedChain.revisions?.map((revision) => revision.kind)).toEqual([
      "legacy",
      "legacy",
      "turn",
      "turn",
      "turn",
    ]);
    expect(reloadedChain.activeRevisionId).toBe("revision-regenerated-again");
    expect(reloadedChain.content).toBe("Regenerated again.");
    expect(reloadedContinuation).toMatchObject({
      id: "assistant-continued",
      activeRevisionId: "revision-continued",
      content: "Continued.",
    } satisfies Partial<ConversationMessage>);
    expect(reloaded.parentConversationId).toBe("conversation-legacy");
    expect(reloaded.branchFromMessageId).toBe("assistant-legacy");
  });
});
