import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../../../../src/constants";
import { ChatSessionStore } from "../../../../src/chat/conversation/ChatSessionStore";
import type { ConversationStorage } from "../../../../src/chat/conversation/ConversationStorage";
import { normalizeConversation } from "../../../../src/chat/conversation/conversationUtils";
import {
  deriveActionControlEligibility,
  deriveActionLedgerState,
} from "../../../../src/chat/conversation/actionLedger";
import type WritingAssistantChat from "../../../../src/main";
import type {
  Conversation,
  ConversationMessage,
  InFlightGenerationAudit,
  PluginSettings,
  ToolActionLedgerEntry,
} from "../../../../src/shared/types";

/**
 * RFC-0011 phase 6, plan section 9.3: reload and navigation.
 *
 * An audit still on disk means the generation that owned it never finished, so
 * recovery is fail-closed: one failed terminal revision, every intent's evidence
 * preserved, the provider never resumed, and nothing actionable anywhere. Doing it
 * twice must change nothing, because a crash between the terminal write and the
 * clear leaves exactly that state.
 */

function orphan(
  overrides: Partial<InFlightGenerationAudit> = {},
): InFlightGenerationAudit {
  return {
    messageId: "assistant-orphan",
    leaseId: "claude-generation-7",
    turnId: "turn-7",
    attemptOrdinal: 1,
    provider: "claudecode",
    modelId: "claude-sonnet-4-5",
    openedAt: 1700000000000,
    intents: [
      {
        intentId: "intent-action-1-Notes-a",
        actionRef: "action-revision-7-toolu_1",
        family: "vault_op",
        targetId: "Notes/a.md",
        correlation: { kind: "provider_id", toolCallId: "toolu_1" },
        summary: "write_file Notes/a.md",
        recordedAt: 1700000000001,
        outcome: "pending",
      },
      {
        intentId: "intent-action-2-Notes-b",
        actionRef: "action-revision-7-toolu_2",
        family: "edit",
        targetId: "Notes/b.md",
        correlation: { kind: "provider_id", toolCallId: "toolu_2" },
        summary: "propose_edit Notes/b.md",
        recordedAt: 1700000000002,
        outcome: "resolved",
      },
    ],
    ...overrides,
  };
}

function harness(conversation: Conversation) {
  const settings: PluginSettings = {
    ...DEFAULT_SETTINGS,
    chatHistory: {
      conversations: [
        {
          id: conversation.id,
          title: conversation.title,
          createdAt: conversation.createdAt,
          updatedAt: conversation.updatedAt,
          modelId: conversation.modelId,
          modelName: conversation.modelName,
          messageCount: conversation.messages.length,
        },
      ],
      activeConversationId: conversation.id,
    },
  };
  const files = new Map<string, string>([
    [conversation.id, JSON.stringify(conversation)],
  ]);
  const storage = {
    load: (id: string) => {
      const raw = files.get(id);
      return Promise.resolve(raw ? normalizeConversation(JSON.parse(raw)) : null);
    },
    save: (next: Conversation) => {
      files.set(next.id, JSON.stringify(next));
      return Promise.resolve();
    },
    delete: (id: string) => {
      files.delete(id);
      return Promise.resolve();
    },
  } as unknown as ConversationStorage;
  const plugin = {
    settings,
    saveSettings: vi.fn(() => Promise.resolve()),
  } as unknown as WritingAssistantChat;
  const store = new ChatSessionStore(plugin, storage);
  return {
    store,
    onDisk: () => {
      const raw = files.get(conversation.id);
      return raw ? normalizeConversation(JSON.parse(raw)) : null;
    },
  };
}

function conversationWith(
  audit: InFlightGenerationAudit | undefined,
  messages: ConversationMessage[] = [
    { id: "user-1", role: "user", content: "write the note" },
  ],
): Conversation {
  return {
    id: "conversation-1",
    title: "Thread",
    createdAt: 1,
    updatedAt: 1,
    modelId: "claude-sonnet-4-5",
    modelName: "Sonnet",
    messages,
    draft: "",
    approvalPosture: "ask",
    ...(audit ? { inFlightGenerationAudit: audit } : {}),
  };
}

describe("orphaned audit recovery", () => {
  it("recovers one failed terminal revision and clears the audit", async () => {
    const h = harness(conversationWith(orphan()));

    await h.store.restorePersistedState();

    const conversation = h.onDisk();
    expect(conversation?.inFlightGenerationAudit).toBeUndefined();
    const recovered = conversation?.messages.find(
      (message) => message.id === "assistant-orphan",
    );
    const revision = recovered?.revisions?.[0];
    expect(revision?.kind).toBe("turn");
    if (revision?.kind !== "turn") throw new Error("expected a turn revision");
    expect(revision.turn.status).toBe("failed");
    // Forced quiescence: nothing about this generation was proven, so no exact
    // claim and no resume cursor may survive it (settled decisions 18 and 24).
    expect(revision.turn.quiescence).toBe("forced");
    expect(revision.usage?.resumeCursor).toBeUndefined();
    expect(revision.replayEvidence?.capabilities.nativeResume).toBe(false);
    expect(revision.provider).toBe("claudecode");
    // Every intent keeps a record, whatever its last known outcome was.
    expect(revision.turn.captureDiagnostics).toHaveLength(2);
    expect(revision.turn.captureDiagnostics?.[0]).toMatchObject({
      code: "consequential_outcome_unknown",
      stage: "callback",
    });
    expect(revision.turn.captureDiagnostics?.[1]?.message).toContain(
      "Notes/b.md",
    );
    // No prose was invented on the model's behalf (section 9.2).
    expect(revision.turn.items).toEqual([]);
  });

  it("is idempotent when the message already carries the evidence", async () => {
    // A crash between the terminal write and the clear leaves the folded message
    // and the audit both on disk.
    const alreadyFolded: ConversationMessage = {
      id: "assistant-orphan",
      role: "assistant",
      content: "Done.",
      revisions: [
        {
          revisionId: "revision-7",
          kind: "legacy",
          content: "Done.",
        },
      ],
      activeRevisionId: "revision-7",
    };
    const h = harness(
      conversationWith(orphan(), [
        { id: "user-1", role: "user", content: "write the note" },
        alreadyFolded,
      ]),
    );

    await h.store.restorePersistedState();

    const conversation = h.onDisk();
    expect(conversation?.inFlightGenerationAudit).toBeUndefined();
    // One message, not a second recovery revision beside it.
    expect(
      conversation?.messages.filter((message) => message.id === "assistant-orphan"),
    ).toHaveLength(1);
    expect(
      conversation?.messages.find((message) => message.id === "assistant-orphan")
        ?.revisions,
    ).toHaveLength(1);
  });

  it("does nothing when a conversation carries no audit", async () => {
    const h = harness(conversationWith(undefined));

    await h.store.restorePersistedState();

    expect(h.onDisk()?.messages.map((message) => message.role)).toEqual(["user"]);
  });

  it("recovers the audit of a conversation switched into", async () => {
    const first = conversationWith(undefined);
    const h = harness(first);
    const secondFile = conversationWith(orphan());
    secondFile.id = "conversation-2";
    await h.store.restorePersistedState();
    await h.store.addAndSwitchToConversation(secondFile);
    await h.store.switchToConversation("conversation-1");

    await h.store.switchToConversation("conversation-2");

    expect(h.store.getGenerationAudit()).toBeNull();
    expect(
      h.store
        .getSnapshot()
        .messageHistory.some((message) => message.id === "assistant-orphan"),
    ).toBe(true);
  });
});

describe("audit evidence is inert", () => {
  /**
   * Two selectable revisions of one turn, the shape a regeneration leaves. The
   * first owns the action whose outcome is unknown; the second is the replacement
   * the user is looking at.
   */
  function turnRevision(
    revisionId: string,
    text: string,
    owned = false,
  ): NonNullable<ConversationMessage["revisions"]>[number] {
    return {
      revisionId,
      kind: "turn",
      origin: "generated",
      createdAt: 10,
      provider: "lmstudio",
      modelId: "test-model",
      turn: {
        schemaVersion: 1,
        id: `turn-${revisionId}`,
        status: "completed",
        segments: [{ id: `segment-${revisionId}` }],
        items: owned
          ? [
              {
                type: "tool_call",
                id: "item-1",
                segmentId: `segment-${revisionId}`,
                toolCallId: "toolu_1",
                toolName: "create_directory",
                toolArguments: "{}",
                toolArgs: {},
                state: "failed",
                actionRef: "action-1",
              },
            ]
          : [
              {
                type: "prose",
                id: `item-${revisionId}`,
                segmentId: `segment-${revisionId}`,
                text,
              },
            ],
      },
    };
  }

  /** A ledger entry whose write-ahead intent never resolved. */
  function unknownEntry(): ToolActionLedgerEntry {
    return {
      actionRef: "action-1",
      revisionId: "revision-1",
      family: "vault_op",
      placement: {
        state: "placed",
        anchor: "tool_call",
        itemId: "item-1",
        correlation: { kind: "provider_id", toolCallId: "toolu_1" },
      },
      payload: {
        proposalId: "proposal-1",
        createdAt: 1,
        targets: [
          {
            targetId: "op-1",
            operation: { kind: "createDir", path: "Folder" },
            gate: "ask",
            summary: "Create Folder",
          },
        ],
      },
      events: [
        { eventId: "e1", type: "proposed", targetId: "op-1", createdAt: 1 },
        {
          eventId: "e2",
          type: "intent_recorded",
          targetId: "op-1",
          createdAt: 2,
          intentId: "intent-1",
        },
        {
          eventId: "e3",
          type: "outcome_unknown",
          targetId: "op-1",
          createdAt: 3,
          intentId: "intent-1",
          reason: "the owning generation ended with this outcome unknown",
        },
      ],
    };
  }

  it("offers no control for an unknown outcome", () => {
    const eligibility = deriveActionControlEligibility(unknownEntry(), "op-1", {
      activeRevisionId: "revision-1",
      isActiveConversationHead: true,
      visibleRevisionReferencesAction: true,
      driftGuardAllowsUndo: true,
    });

    expect(eligibility).toEqual({
      canApprove: false,
      canDecline: false,
      canApply: false,
      canRetry: false,
      canUndo: false,
    });
  });

  it("is terminal, so regeneration cannot supersede it into another answer", () => {
    const state = deriveActionLedgerState(unknownEntry());

    expect(state.targets["op-1"].outcomeUnknown).toBe(true);
    // Nothing unresolved means `supersedeUnresolvedActions` appends no event when
    // a replacement revision is committed (criterion 35).
    expect(state.unresolvedTargetIds).toEqual([]);
  });

  it("appends no event when version navigation selects another revision", async () => {
    const message: ConversationMessage = {
      id: "assistant-1",
      role: "assistant",
      content: "First.",
      revisions: [
        turnRevision("revision-1", "First.", true),
        turnRevision("revision-2", "Second."),
      ],
      activeRevisionId: "revision-2",
      actionLedger: [unknownEntry()],
    };
    const h = harness(
      conversationWith(undefined, [
        { id: "user-1", role: "user", content: "hi" },
        message,
      ]),
    );
    await h.store.restorePersistedState();

    expect(h.store.switchMessageRevision("assistant-1", "revision-1")).toBe(true);

    const events = h.store
      .getSnapshot()
      .messageHistory.find((entry) => entry.id === "assistant-1")
      ?.actionLedger?.[0].events;
    expect(events?.map((event) => event.type)).toEqual([
      "proposed",
      "intent_recorded",
      "outcome_unknown",
    ]);
  });
});
