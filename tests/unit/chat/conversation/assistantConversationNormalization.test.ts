import { describe, expect, it } from "vitest";
import legacyFixtures from "../../../fixtures/assistant-turns/legacy-conversations.json";
import {
  normalizeConversation,
} from "../../../../src/chat/conversation/conversationUtils";
import type {
  AssistantMessageRevision,
  Conversation,
  ConversationMessage,
} from "../../../../src/shared/types";

interface LegacyFixture {
  name: string;
  message: Record<string, unknown>;
}

const fixtures = legacyFixtures.cases as LegacyFixture[];

function fixture(name: string): Record<string, unknown> {
  const found = fixtures.find((entry) => entry.name === name);
  if (!found) throw new Error(`Missing fixture "${name}".`);
  return structuredClone(found.message);
}

function conversation(
  messages: Array<Record<string, unknown> | ConversationMessage>,
): Record<string, unknown> {
  return {
    id: "conversation-1",
    title: "Fixture",
    createdAt: 100,
    updatedAt: 200,
    modelId: "anthropic:claude-fixture",
    modelName: "Claude fixture",
    messages,
    draft: "",
  };
}

function assistant(
  raw: Record<string, unknown>,
): ConversationMessage {
  const normalized = normalizeConversation(conversation([raw]));
  if (!normalized?.messages[0]) throw new Error("Assistant was dropped.");
  return normalized.messages[0];
}

function activeRevision(
  message: ConversationMessage,
): AssistantMessageRevision {
  const found = message.revisions?.find(
    (revision) => revision.revisionId === message.activeRevisionId,
  );
  if (!found) throw new Error("Missing active revision.");
  return found;
}

describe("normalizeConversation, strict new revision chains", () => {
  it("loads generated, regenerated, and edited revisions directly", () => {
    const raw = {
      id: "assistant-new",
      role: "assistant",
      content: "Edited.",
      revisions: [
        {
          revisionId: "revision-1",
          kind: "turn",
          origin: "generated",
          createdAt: 1,
          provider: "anthropic",
          modelId: "claude-fixture",
          turn: {
            schemaVersion: 1,
            id: "turn-1",
            status: "completed",
            segments: [{ id: "segment-1" }],
            items: [
              {
                type: "prose",
                id: "prose-1",
                segmentId: "segment-1",
                text: "Generated.",
              },
            ],
          },
        },
        {
          revisionId: "revision-2",
          kind: "turn",
          origin: "regenerated",
          parentRevisionId: "revision-1",
          createdAt: 2,
          provider: "openai",
          modelId: "gpt-fixture",
          usage: { inputTokens: 5, outputTokens: 6 },
          turn: {
            schemaVersion: 1,
            id: "turn-2",
            status: "completed",
            segments: [{ id: "segment-2" }],
            items: [
              {
                type: "prose",
                id: "prose-2",
                segmentId: "segment-2",
                text: "Regenerated.",
              },
            ],
          },
        },
        {
          revisionId: "revision-3",
          kind: "turn",
          origin: "edited",
          parentRevisionId: "revision-2",
          createdAt: 3,
          provider: "openai",
          modelId: "gpt-fixture",
          turn: {
            schemaVersion: 1,
            id: "turn-3",
            status: "completed",
            segments: [{ id: "segment-3" }],
            items: [
              {
                type: "prose",
                id: "prose-3",
                sourceItemId: "prose-2",
                segmentId: "segment-3",
                text: "Edited.",
              },
            ],
          },
        },
      ],
      activeRevisionId: "revision-3",
      actionLedger: [],
      provider: "stale-provider",
      modelId: "stale-model",
    };

    const message = assistant(raw);

    expect(message.revisions?.map((revision) => revision.kind)).toEqual([
      "turn",
      "turn",
      "turn",
    ]);
    expect(message.revisions?.map((revision) =>
      revision.kind === "turn" ? revision.origin : null,
    )).toEqual(["generated", "regenerated", "edited"]);
    expect(message.activeRevisionId).toBe("revision-3");
    expect(message.content).toBe("Edited.");
    expect(message.provider).toBe("openai");
    expect(message.modelId).toBe("gpt-fixture");
    expect(message.usage).toBeUndefined();
  });

  it("rejects a malformed new chain as a whole and uses only usable legacy content", () => {
    const malformed = {
      id: "assistant-malformed",
      role: "assistant",
      content: "Readable legacy fallback.",
      revisions: [
        {
          revisionId: "revision-bad",
          kind: "turn",
          origin: "generated",
          createdAt: 1,
          provider: "anthropic",
          modelId: "claude-fixture",
          turn: {
            schemaVersion: 1,
            id: "turn-bad",
            status: "completed",
            segments: [{ id: "segment-1" }],
            items: [
              {
                type: "prose",
                id: "prose-1",
                segmentId: "missing-segment",
                text: "Must not partially survive.",
              },
            ],
          },
        },
      ],
      activeRevisionId: "revision-bad",
      actionLedger: [],
    };
    const noFallback = {
      ...structuredClone(malformed),
      id: "assistant-dropped",
      content: "",
    };
    const normalized = normalizeConversation(
      conversation([malformed, noFallback]),
    );

    expect(normalized?.messages).toHaveLength(1);
    const kept = normalized?.messages[0];
    expect(kept?.content).toBe("Readable legacy fallback.");
    expect(kept?.revisions).toHaveLength(1);
    expect(kept?.revisions?.[0]).toMatchObject({
      kind: "legacy",
      content: "Readable legacy fallback.",
    });
    expect(kept?.actionLedger).toEqual([]);
    expect(JSON.stringify(kept)).not.toContain("missing-segment");
  });

  it("rejects a chain with broken ledger references rather than dropping one entry", () => {
    const raw = {
      id: "assistant-ledger-bad",
      role: "assistant",
      content: "Legacy fallback.",
      revisions: [
        {
          revisionId: "revision-1",
          kind: "turn",
          origin: "generated",
          createdAt: 1,
          provider: "anthropic",
          modelId: "claude-fixture",
          turn: {
            schemaVersion: 1,
            id: "turn-1",
            status: "completed",
            segments: [],
            items: [],
          },
        },
      ],
      activeRevisionId: "revision-1",
      actionLedger: [
        {
          actionRef: "action-1",
          revisionId: "missing",
          family: "memory",
          placement: {
            state: "unplaced",
            correlation: {
              kind: "none",
              transport: "legacy",
              reason: "No exact correlation.",
            },
            reason: "correlation_unavailable",
          },
          payload: { targets: [] },
          events: [],
        },
      ],
    };

    expect(activeRevision(assistant(raw))).toMatchObject({
      kind: "legacy",
      content: "Legacy fallback.",
    });
  });
});

describe("normalizeConversation, conservative legacy ownership", () => {
  it("keeps an unversioned legacy message timestamp-free and step order exact", () => {
    const message = assistant(fixture("steps_then_content"));
    const revision = activeRevision(message);

    expect(revision).toMatchObject({
      kind: "legacy",
      content: "The stored final prose.",
      legacySteps: [
        { type: "reasoning", text: "I will inspect the fixture." },
        { type: "tool_call", toolName: "read" },
      ],
    });
    expect(revision.createdAt).toBeUndefined();
    expect(message.agenticSteps).toEqual(
      revision.kind === "legacy" ? revision.legacySteps : undefined,
    );
  });

  it("converts content-only versions independently and preserves each timestamp", () => {
    const message = assistant(fixture("content_only_versions"));

    expect(message.revisions).toHaveLength(2);
    expect(message.revisions?.map((revision) => revision.kind)).toEqual([
      "legacy",
      "legacy",
    ]);
    expect(message.revisions?.map((revision) => revision.createdAt)).toEqual([
      1000,
      2000,
    ]);
    expect(activeRevision(message)).toMatchObject({
      kind: "legacy",
      content: "Second version.",
      createdAt: 2000,
    });
  });

  it("attaches steps only to the proven active version", () => {
    const message = assistant(
      fixture("provable_active_version_step_owner"),
    );
    const revisions = message.revisions ?? [];

    expect(revisions).toHaveLength(2);
    expect(
      revisions[0].kind === "legacy" ? revisions[0].legacySteps : undefined,
    ).toBeUndefined();
    expect(
      revisions[1].kind === "legacy" ? revisions[1].legacySteps : undefined,
    )?.toHaveLength(1);
    expect(message.activeRevisionId).toBe(revisions[1].revisionId);
  });

  it("preserves ambiguous top-level steps as a distinct current snapshot", () => {
    const message = assistant(fixture("ambiguous_top_level_step_snapshot"));
    const revisions = message.revisions ?? [];

    expect(revisions).toHaveLength(3);
    expect(revisions.slice(0, 2).map((revision) =>
      revision.kind === "legacy" ? revision.legacySteps : undefined,
    )).toEqual([undefined, undefined]);
    expect(activeRevision(message)).toMatchObject({
      kind: "legacy",
      content: "A top-level snapshot not equal to either stored version.",
      legacySteps: [{ toolName: "semantic_search" }],
    });
  });

  it("preserves version-local usage and RAG while attributing only the proven active version", () => {
    const message = assistant(
      fixture("active_only_attribution_and_terminal_metadata"),
    );
    const [inactive, active] = message.revisions ?? [];

    expect(inactive).toMatchObject({
      kind: "legacy",
      createdAt: 1000,
    });
    expect(inactive.provider).toBeUndefined();
    expect(inactive.modelId).toBeUndefined();
    expect(inactive.rewrittenQuery).toBeUndefined();
    expect(inactive.isError).toBeUndefined();
    expect(inactive.interrupted).toBeUndefined();
    expect(active).toMatchObject({
      kind: "legacy",
      createdAt: 2000,
      provider: "claudecode",
      modelId: "claude-fixture",
      rewrittenQuery: "synthetic rewritten query",
      isError: true,
      interrupted: true,
      usage: { inputTokens: 14, outputTokens: 5 },
      ragSources: [{ filePath: "Fixtures/source.md" }],
    });
    expect(message.content).toBe("Interrupted active version.");
    expect(message.provider).toBe("claudecode");
    expect(message.usage).toEqual(active.usage);
  });

  it("keeps legacy proposal and effect metadata only with its proven current snapshot", () => {
    const raw = fixture("content_only_versions");
    raw.provider = "anthropic";
    raw.modelId = "claude-fixture";
    raw.editProposals = [
      {
        id: "proposal-1",
        targetFilePath: "Fixture.md",
        documentSnapshot: "before",
        snapshotTimestamp: 10,
        hunks: [],
        prose: "Fixture.",
      },
    ];
    raw.appliedEdits = [
      {
        proposalId: "proposal-1",
        targetFilePath: "Fixture.md",
        preApplySnapshot: "before",
        postApplySnapshot: "after",
        appliedAt: 20,
        appliedHunkIds: [],
      },
    ];

    const message = assistant(raw);
    const [inactive, active] = message.revisions ?? [];

    expect(inactive.provider).toBeUndefined();
    expect(active.provider).toBe("anthropic");
    expect(message.editProposals?.[0]?.id).toBe("proposal-1");
    expect(message.appliedEdits?.[0]?.proposalId).toBe("proposal-1");
    expect(message.activeRevisionId).toBe(active.revisionId);
  });

  it("does not mutate or eagerly rewrite the loaded raw conversation", () => {
    const raw = conversation([
      fixture("active_only_attribution_and_terminal_metadata"),
    ]);
    const before = structuredClone(raw);

    const normalized = normalizeConversation(raw);

    expect(normalized).not.toBeNull();
    expect(raw).toEqual(before);
  });
});

describe("branching normalized revisions", () => {
  it("leaves structured cloning to create an independent branch record", () => {
    const source = normalizeConversation(
      conversation([fixture("steps_then_content")]),
    ) as Conversation;
    const clone = structuredClone(source.messages);
    const clonedRevision = clone[0].revisions?.[0];
    if (clonedRevision?.kind === "legacy") {
      clonedRevision.content = "Changed only in branch.";
    }

    expect(
      source.messages[0].revisions?.[0].kind === "legacy"
        ? source.messages[0].revisions?.[0].content
        : null,
    ).toBe("The stored final prose.");
  });
});
