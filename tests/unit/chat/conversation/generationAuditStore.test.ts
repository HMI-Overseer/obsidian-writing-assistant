import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../../../../src/constants";
import { ChatSessionStore } from "../../../../src/chat/conversation/ChatSessionStore";
import type { ConversationStorage } from "../../../../src/chat/conversation/ConversationStorage";
import { normalizeConversation } from "../../../../src/chat/conversation/conversationUtils";
import type WritingAssistantChat from "../../../../src/main";
import type {
  Conversation,
  EffectIntentRequest,
  GenerationAuditRecorder,
  PluginSettings,
} from "../../../../src/shared/types";

/**
 * RFC-0011 phase 6, plan section 9.1: the durable in-flight generation audit.
 *
 * Phase 1 landed the persisted shape, the normalizer, and the ledger events, and
 * `normalizeConversation()` has preserved an orphaned audit ever since. Nothing
 * ever wrote one: `ChatSessionMemory` had no field for it and the `Conversation`
 * literal `persistActiveConversation()` builds never carried it, so the round trip
 * was load-only. These are the operations that close it.
 *
 * Every case drives the real store against a fake conversation file, so "durable"
 * means the bytes a reload would read rather than an in-memory flag.
 */

const IDENTITY = {
  messageId: "message-1",
  turnId: "turn-1",
  provider: "claudecode" as const,
  modelId: "claude-sonnet-4-5",
  actionRefFor: (toolCallId: string) => `action-revision-1-${toolCallId}`,
};

const OWNERSHIP = { leaseId: "claude-generation-1", attemptOrdinal: 1 };

function intent(
  overrides: Partial<EffectIntentRequest> = {},
): EffectIntentRequest {
  return {
    boundary: "vault_op_review",
    family: "vault_op",
    correlation: { kind: "provider_id", toolCallId: "toolu_1" },
    targetId: "Notes/target.md",
    summary: "write_file Notes/target.md",
    ...overrides,
  };
}

function harness() {
  const settings: PluginSettings = {
    ...DEFAULT_SETTINGS,
    chatHistory: {
      conversations: [
        {
          id: "conversation-1",
          title: "Thread",
          createdAt: 1,
          updatedAt: 1,
          modelId: "claude-sonnet-4-5",
          modelName: "Sonnet",
          messageCount: 0,
        },
      ],
      activeConversationId: "conversation-1",
    },
  };
  const files = new Map<string, string>();
  let failNextSave: Error | null = null;
  const saved: Conversation[] = [];
  const storage = {
    load: (id: string) => {
      const raw = files.get(id);
      return Promise.resolve(raw ? normalizeConversation(JSON.parse(raw)) : null);
    },
    save: (conversation: Conversation) => {
      if (failNextSave) {
        const error = failNextSave;
        failNextSave = null;
        return Promise.reject(error);
      }
      // Round-trip through JSON so a field the literal forgot cannot pass by
      // riding an in-memory object reference.
      files.set(conversation.id, JSON.stringify(conversation));
      saved.push(conversation);
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
    settings,
    files,
    saved,
    failSaveOnce: (error: Error) => {
      failNextSave = error;
    },
    /** What a reload would actually read back. */
    onDisk: (id = "conversation-1") => {
      const raw = files.get(id);
      return raw ? normalizeConversation(JSON.parse(raw)) : null;
    },
    seed: (conversation: Conversation) => {
      files.set(conversation.id, JSON.stringify(conversation));
    },
  };
}

async function activeStore() {
  const h = harness();
  h.seed({
    id: "conversation-1",
    title: "Thread",
    createdAt: 1,
    updatedAt: 1,
    modelId: "claude-sonnet-4-5",
    modelName: "Sonnet",
    messages: [{ id: "user-1", role: "user", content: "hello" }],
    draft: "",
    approvalPosture: "ask",
  });
  await h.store.restorePersistedState();
  return h;
}

describe("in-flight generation audit persistence", () => {
  it("makes an appended intent durable before the append resolves", async () => {
    const h = await activeStore();
    const recorder: GenerationAuditRecorder = h.store.openGenerationAudit(IDENTITY);

    await recorder.recordIntent(intent(), OWNERSHIP);

    const audit = h.onDisk()?.inFlightGenerationAudit;
    expect(audit).toBeDefined();
    expect(audit?.messageId).toBe("message-1");
    expect(audit?.turnId).toBe("turn-1");
    expect(audit?.leaseId).toBe("claude-generation-1");
    expect(audit?.attemptOrdinal).toBe(1);
    expect(audit?.provider).toBe("claudecode");
    expect(audit?.intents).toHaveLength(1);
    expect(audit?.intents[0]).toMatchObject({
      actionRef: "action-revision-1-toolu_1",
      family: "vault_op",
      targetId: "Notes/target.md",
      outcome: "pending",
    });
  });

  it("appends the same intent idempotently", async () => {
    const h = await activeStore();
    const recorder = h.store.openGenerationAudit(IDENTITY);

    await recorder.recordIntent(intent(), OWNERSHIP);
    await recorder.recordIntent(intent(), OWNERSHIP);

    expect(h.onDisk()?.inFlightGenerationAudit?.intents).toHaveLength(1);
  });

  it("keeps every intent of a generation, with no ceiling", async () => {
    const h = await activeStore();
    const recorder = h.store.openGenerationAudit(IDENTITY);

    // RFC-0010 and settled decision 29: these records are the only evidence that
    // irreversible work happened, so there is no count at which dropping one is
    // the better answer.
    for (let index = 0; index < 300; index += 1) {
      await recorder.recordIntent(
        intent({
          correlation: { kind: "provider_id", toolCallId: `toolu_${index}` },
          targetId: `Notes/target-${index}.md`,
        }),
        OWNERSHIP,
      );
    }

    expect(h.onDisk()?.inFlightGenerationAudit?.intents).toHaveLength(300);
  });

  it("rejects the append and persists nothing when the store write fails", async () => {
    const h = await activeStore();
    const recorder = h.store.openGenerationAudit(IDENTITY);
    h.failSaveOnce(new Error("disk full"));

    await expect(recorder.recordIntent(intent(), OWNERSHIP)).rejects.toThrow(
      "disk full",
    );

    // Neither on disk nor left behind in memory claiming to be durable.
    expect(h.onDisk()?.inFlightGenerationAudit).toBeUndefined();
    expect(h.store.getGenerationAudit()).toBeNull();
  });

  it("reconciles an intent to its real outcome", async () => {
    const h = await activeStore();
    const recorder = h.store.openGenerationAudit(IDENTITY);
    await recorder.recordIntent(intent(), OWNERSHIP);

    await recorder.reconcileIntent(intent());

    expect(h.onDisk()?.inFlightGenerationAudit?.intents[0].outcome).toBe(
      "resolved",
    );
  });

  it("converts an unresolved intent to an unknown outcome", async () => {
    const h = await activeStore();
    const recorder = h.store.openGenerationAudit(IDENTITY);
    await recorder.recordIntent(intent(), OWNERSHIP);
    await recorder.recordIntent(
      intent({
        correlation: { kind: "provider_id", toolCallId: "toolu_2" },
        targetId: "Notes/second.md",
      }),
      OWNERSHIP,
    );
    await recorder.reconcileIntent(intent());

    const marked = h.store.markGenerationIntentsUnknown();

    expect(marked?.intents.map((entry) => entry.outcome)).toEqual([
      "resolved",
      "unknown",
    ]);
  });

  it("clears the audit and hands it back so a failed persist can restore it", async () => {
    const h = await activeStore();
    const recorder = h.store.openGenerationAudit(IDENTITY);
    await recorder.recordIntent(intent(), OWNERSHIP);

    const cleared = h.store.clearGenerationAudit();
    expect(cleared?.intents).toHaveLength(1);
    expect(h.store.getGenerationAudit()).toBeNull();

    h.store.restoreGenerationAudit(cleared);
    expect(h.store.getGenerationAudit()?.intents).toHaveLength(1);
  });

  it("refuses to append after the audit is closed", async () => {
    const h = await activeStore();
    const recorder = h.store.openGenerationAudit(IDENTITY);
    await recorder.recordIntent(intent(), OWNERSHIP);
    h.store.clearGenerationAudit();

    // The terminal fold already happened. A callback that reaches its boundary
    // now cannot get durable evidence, so it must not be allowed to act.
    await expect(
      recorder.recordIntent(
        intent({
          correlation: { kind: "provider_id", toolCallId: "toolu_late" },
          targetId: "Notes/late.md",
        }),
        OWNERSHIP,
      ),
    ).rejects.toThrow();
  });

  it("does not carry an audit onto a branched conversation", async () => {
    const h = await activeStore();
    const recorder = h.store.openGenerationAudit(IDENTITY);
    await recorder.recordIntent(intent(), OWNERSHIP);

    const branch: Conversation = {
      id: "conversation-branch",
      title: "Branch",
      createdAt: 2,
      updatedAt: 2,
      modelId: "claude-sonnet-4-5",
      modelName: "Sonnet",
      messages: h.store.getMessagesUpToInclusive("user-1"),
      draft: "",
      approvalPosture: "ask",
      parentConversationId: "conversation-1",
      branchFromMessageId: "user-1",
    };
    await h.store.addAndSwitchToConversation(branch);

    expect(h.onDisk("conversation-branch")?.inFlightGenerationAudit).toBeUndefined();
    expect(h.store.getGenerationAudit()).toBeNull();
  });
});
