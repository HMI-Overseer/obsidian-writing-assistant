import { describe, test, expect } from "vitest";
import {
  createBranchConversation,
  createConversation,
  normalizeChatHistory,
  normalizeConversation,
  normalizePosture,
  toConversationMeta,
} from "../../../src/chat/conversation/conversationUtils";
import type {
  Conversation,
  ConversationMessage,
  ConversationMeta,
  MessageUsage,
} from "../../../src/shared/types";

/**
 * Simulates a JSON round-trip through data.json, the object is serialized
 * then parsed back as a plain object with no type guarantees.
 */
function jsonRoundTrip<T>(obj: T): unknown {
  return JSON.parse(JSON.stringify(obj));
}

function makeUsage(overrides: Partial<MessageUsage> = {}): MessageUsage {
  return {
    inputTokens: 2489,
    outputTokens: 12,
    estimatedCostUsd: 0.00063725,
    ...overrides,
  };
}

function makeConversation(messages: ConversationMessage[]): Conversation {
  return {
    id: "conv-1",
    title: "Test",
    createdAt: 1000,
    updatedAt: 2000,
    modelId: "profile-1",
    modelName: "Claude Haiku 3",
    messages,
    draft: "",
  };
}

describe("normalizeConversation, malformed persisted data (disk boundary)", () => {
  // data.json is user-editable and can be corrupted or predate the current shape.
  // JSON.parse yields any of null / a primitive / an array here, none of which is a
  // conversation. Each must be rejected, not crash and not silently become a junk
  // conversation with a fresh id.
  test("null is rejected, not dereferenced", () => {
    expect(normalizeConversation(null)).toBeNull();
  });

  test("a bare primitive is rejected", () => {
    expect(normalizeConversation(42)).toBeNull();
    expect(normalizeConversation("not a conversation")).toBeNull();
  });

  test("an array is rejected", () => {
    expect(normalizeConversation([])).toBeNull();
    expect(normalizeConversation([{ id: "x" }])).toBeNull();
  });

  test("a well-formed object still normalizes (guard is not over-broad)", () => {
    const result = normalizeConversation(makeConversation([]));
    expect(result).not.toBeNull();
    expect(result!.id).toBe("conv-1");
  });
});

describe("normalizeConversation, usage field preservation", () => {
  test("preserves modelId, provider, and usage on assistant messages", () => {
    const msg: ConversationMessage = {
      id: "msg-1",
      role: "assistant",
      content: "Hello!",
      modelId: "claude-3-haiku-20240307",
      provider: "anthropic",
      usage: makeUsage(),
    };

    const raw = jsonRoundTrip(makeConversation([msg])) as Record<string, unknown>;
    const result = normalizeConversation(raw);
    const normalized = result!.messages[0];

    expect(normalized.modelId).toBe("claude-3-haiku-20240307");
    expect(normalized.provider).toBe("anthropic");
    expect(normalized.usage).toEqual(makeUsage());
  });

  test("preserves isError flag on error messages", () => {
    const msg: ConversationMessage = {
      id: "msg-1",
      role: "assistant",
      content: "Error: Rate limit exceeded",
      isError: true,
      modelId: "claude-3-haiku-20240307",
      provider: "anthropic",
    };

    const raw = jsonRoundTrip(makeConversation([msg])) as Record<string, unknown>;
    const result = normalizeConversation(raw);
    const normalized = result!.messages[0];

    expect(normalized.isError).toBe(true);
    expect(normalized.modelId).toBe("claude-3-haiku-20240307");
    expect(normalized.provider).toBe("anthropic");
  });

  test("does not add isError when not present", () => {
    const msg: ConversationMessage = {
      id: "msg-1",
      role: "assistant",
      content: "Hello!",
    };

    const raw = jsonRoundTrip(makeConversation([msg])) as Record<string, unknown>;
    const result = normalizeConversation(raw);
    const normalized = result!.messages[0];

    expect(normalized.isError).toBeUndefined();
  });

  test("preserves usage on MessageVersions after round-trip", () => {
    const msg: ConversationMessage = {
      id: "msg-1",
      role: "assistant",
      content: "v2 content",
      versions: [
        { content: "v1 content", createdAt: 1000, usage: makeUsage({ inputTokens: 100, outputTokens: 50, estimatedCostUsd: 0.001 }) },
        { content: "v2 content", createdAt: 2000, usage: makeUsage({ inputTokens: 200, outputTokens: 80, estimatedCostUsd: 0.003 }) },
      ],
      activeVersionIndex: 1,
      modelId: "claude-3-haiku-20240307",
      provider: "anthropic",
      usage: makeUsage({ inputTokens: 200, outputTokens: 80, estimatedCostUsd: 0.003 }),
    };

    const raw = jsonRoundTrip(makeConversation([msg])) as Record<string, unknown>;
    const result = normalizeConversation(raw);
    const normalized = result!.messages[0];

    expect(normalized.versions).toHaveLength(2);
    expect(normalized.versions![0].usage).toEqual(
      makeUsage({ inputTokens: 100, outputTokens: 50, estimatedCostUsd: 0.001 })
    );
    expect(normalized.versions![1].usage).toEqual(
      makeUsage({ inputTokens: 200, outputTokens: 80, estimatedCostUsd: 0.003 })
    );
  });

  test("handles versions without usage (backward compat)", () => {
    const msg: ConversationMessage = {
      id: "msg-1",
      role: "assistant",
      content: "v2 content",
      versions: [
        { content: "v1 content", createdAt: 1000 },
        { content: "v2 content", createdAt: 2000 },
      ],
      activeVersionIndex: 1,
    };

    const raw = jsonRoundTrip(makeConversation([msg])) as Record<string, unknown>;
    const result = normalizeConversation(raw);
    const normalized = result!.messages[0];

    expect(normalized.versions).toHaveLength(2);
    expect(normalized.versions![0].usage).toBeUndefined();
    expect(normalized.versions![1].usage).toBeUndefined();
  });

  test("preserves messages without any usage fields (LM Studio / old data)", () => {
    const msg: ConversationMessage = {
      id: "msg-1",
      role: "assistant",
      content: "Hello from LM Studio",
    };

    const raw = jsonRoundTrip(makeConversation([msg])) as Record<string, unknown>;
    const result = normalizeConversation(raw);
    const normalized = result!.messages[0];

    expect(normalized.modelId).toBeUndefined();
    expect(normalized.provider).toBeUndefined();
    expect(normalized.usage).toBeUndefined();
  });
});

describe("normalizeChatHistory, metadata index", () => {
  test("normalizes conversation metadata entries", () => {
    const raw = jsonRoundTrip({
      conversations: [
        { id: "conv-1", title: "Test", createdAt: 1000, updatedAt: 2000, modelId: "p1", modelName: "Claude", messageCount: 5 },
      ],
      activeConversationId: "conv-1",
    });

    const result = normalizeChatHistory(raw);
    expect(result.conversations).toHaveLength(1);
    expect(result.conversations[0].id).toBe("conv-1");
    expect(result.conversations[0].messageCount).toBe(5);
    expect(result.activeConversationId).toBe("conv-1");
  });

  test("falls back to first conversation when activeConversationId is invalid", () => {
    const raw = jsonRoundTrip({
      conversations: [
        { id: "conv-1", title: "Test", createdAt: 1000, updatedAt: 2000, modelId: "p1", modelName: "Claude", messageCount: 0 },
      ],
      activeConversationId: "nonexistent",
    });

    const result = normalizeChatHistory(raw);
    expect(result.activeConversationId).toBe("conv-1");
  });

  test("returns empty history for invalid input", () => {
    const result = normalizeChatHistory(null);
    expect(result.conversations).toHaveLength(0);
    expect(result.activeConversationId).toBeNull();
  });
});

describe("normalizeConversation, editProposal / appliedEdit validation", () => {
  function makeEditProposal() {
    return {
      id: "ep-1",
      targetFilePath: "notes/test.md",
      documentSnapshot: "original content",
      snapshotTimestamp: 1000,
      hunks: [{ id: "h1", resolvedEdit: {}, status: "pending" }],
      prose: "Here are the changes.",
    };
  }

  function makeAppliedEditRecord() {
    return {
      proposalId: "ep-1",
      targetFilePath: "notes/test.md",
      preApplySnapshot: "before",
      postApplySnapshot: "after",
      appliedAt: 2000,
      appliedHunkIds: ["h1"],
    };
  }

  test("migrates a legacy single editProposal into editProposals[] (ADR-0010)", () => {
    const msg: ConversationMessage = {
      id: "msg-1",
      role: "assistant",
      content: "Edit response",
    };

    const raw = jsonRoundTrip(makeConversation([msg])) as Record<string, unknown>;
    // The pre-ADR-0010 singular field exists only in the on-disk shape now (retired from
    // the live type, ADR-0027); inject it onto the raw persisted record to test migration.
    (raw.messages as Array<Record<string, unknown>>)[0].editProposal = makeEditProposal();

    const result = normalizeConversation(raw);
    const normalized = result!.messages[0];

    // The legacy singular field folds into the array without loss.
    expect(normalized.editProposals).toHaveLength(1);
    expect(normalized.editProposals![0].id).toBe("ep-1");
    expect(normalized.editProposals![0].targetFilePath).toBe("notes/test.md");
    expect(normalized.editProposals![0].hunks).toHaveLength(1);
  });

  test("round-trips a multi-file editProposals[] without loss (ADR-0010)", () => {
    const second = { ...makeEditProposal(), id: "ep-2", targetFilePath: "notes/other.md" };
    const msg: ConversationMessage = {
      id: "msg-1",
      role: "assistant",
      content: "Edit response",
      editProposals: [makeEditProposal(), second] as ConversationMessage["editProposals"],
    };

    const raw = jsonRoundTrip(makeConversation([msg])) as Record<string, unknown>;
    const result = normalizeConversation(raw);
    const normalized = result!.messages[0];

    expect(normalized.editProposals).toHaveLength(2);
    expect(normalized.editProposals!.map((p) => p.targetFilePath)).toEqual([
      "notes/test.md",
      "notes/other.md",
    ]);
  });

  test("drops editProposal missing required fields", () => {
    const msg: ConversationMessage = {
      id: "msg-1",
      role: "assistant",
      content: "Edit response",
    };

    const raw = jsonRoundTrip(makeConversation([msg])) as Record<string, unknown>;
    // Inject a malformed editProposal (missing hunks, prose, etc.)
    const messages = raw.messages as Array<Record<string, unknown>>;
    messages[0].editProposal = { id: "ep-bad" };

    const result = normalizeConversation(raw);
    const normalized = result!.messages[0];

    expect(normalized.editProposals).toBeUndefined();
  });

  test("drops non-object truthy editProposal", () => {
    const msg: ConversationMessage = {
      id: "msg-1",
      role: "assistant",
      content: "Edit response",
    };

    const raw = jsonRoundTrip(makeConversation([msg])) as Record<string, unknown>;
    const messages = raw.messages as Array<Record<string, unknown>>;
    messages[0].editProposal = "not-an-object";

    const result = normalizeConversation(raw);
    const normalized = result!.messages[0];

    expect(normalized.editProposals).toBeUndefined();
  });

  test("migrates a legacy single appliedEdit into appliedEdits[] (ADR-0010)", () => {
    const msg: ConversationMessage = {
      id: "msg-1",
      role: "assistant",
      content: "Edit response",
    };

    const raw = jsonRoundTrip(makeConversation([msg])) as Record<string, unknown>;
    // Legacy singular fields live only in the on-disk shape (retired, ADR-0027).
    const rawMessages = raw.messages as Array<Record<string, unknown>>;
    rawMessages[0].editProposal = makeEditProposal();
    rawMessages[0].appliedEdit = makeAppliedEditRecord();

    const result = normalizeConversation(raw);
    const normalized = result!.messages[0];

    expect(normalized.appliedEdits).toHaveLength(1);
    expect(normalized.appliedEdits![0].proposalId).toBe("ep-1");
    expect(normalized.appliedEdits![0].appliedHunkIds).toEqual(["h1"]);
  });

  test("drops malformed appliedEdit", () => {
    const msg: ConversationMessage = {
      id: "msg-1",
      role: "assistant",
      content: "Edit response",
    };

    const raw = jsonRoundTrip(makeConversation([msg])) as Record<string, unknown>;
    const messages = raw.messages as Array<Record<string, unknown>>;
    messages[0].appliedEdit = { proposalId: "ep-1" }; // missing targetFilePath, appliedHunkIds

    const result = normalizeConversation(raw);
    const normalized = result!.messages[0];

    expect(normalized.appliedEdits).toBeUndefined();
  });
});

describe("normalizeConversation, phase-2 agenticStep capture fields", () => {
  test("preserves disposition / resultDigest / resultRecord across a JSON round-trip", () => {
    const msg: ConversationMessage = {
      id: "msg-1",
      role: "assistant",
      content: "Done.",
      agenticSteps: [
        {
          type: "tool_call",
          round: 0,
          toolName: "semantic_search",
          toolCallId: "s-1",
          resultDigest: '[semantic_search: "oath", surfaced: Chapters/ch1.md]',
          resultRecord: 'Search results for: "oath"\n\n[Chapters/ch1.md] (score: 0.9)\nbody',
        },
        {
          type: "tool_call",
          round: 1,
          toolName: "create_directory",
          toolCallId: "d-1",
          disposition: "declined",
          resultRecord: 'Declined by user, "Drafts/Arcs" was not changed.',
        },
      ],
    };

    const raw = jsonRoundTrip(makeConversation([msg])) as Record<string, unknown>;
    const steps = normalizeConversation(raw)!.messages[0].agenticSteps!;

    expect(steps[0].resultDigest).toBe('[semantic_search: "oath", surfaced: Chapters/ch1.md]');
    expect(steps[0].resultRecord).toContain("Search results for");
    expect(steps[0].disposition).toBeUndefined();
    expect(steps[1].disposition).toBe("declined");
    expect(steps[1].resultDigest).toBeUndefined();
  });

  test("a step written before phase 2 stays field-free after load (no silent backfill)", () => {
    // Guards against a serializer defaulting the new fields, which would fake
    // provenance the old conversation never had.
    const msg: ConversationMessage = {
      id: "msg-1",
      role: "assistant",
      content: "Done.",
      agenticSteps: [{ type: "tool_call", round: 0, toolName: "read_file", toolCallId: "r-1" }],
    };

    const raw = jsonRoundTrip(makeConversation([msg])) as Record<string, unknown>;
    const step = normalizeConversation(raw)!.messages[0].agenticSteps![0];

    expect(step.disposition).toBeUndefined();
    expect(step.resultDigest).toBeUndefined();
    expect(step.resultRecord).toBeUndefined();
  });

  test("preserves a valid exact ask guidance record across a JSON round-trip", () => {
    const msg: ConversationMessage = {
      id: "msg-ask",
      role: "assistant",
      content: "Done.",
      agenticSteps: [{
        type: "tool_call",
        round: 0,
        toolName: "ask_user",
        toolCallId: "ask-1",
        askStatus: "completed",
        askGuidance: {
          questions: [{
            question: "Which areas should I cover?",
            header: "Coverage",
            answer: ["Testing", "Also include accessibility\nfailure modes"],
          }],
        },
      }],
    };

    const raw = jsonRoundTrip(makeConversation([msg])) as Record<string, unknown>;
    expect(normalizeConversation(raw)!.messages[0].agenticSteps![0].askGuidance).toEqual(
      msg.agenticSteps![0].askGuidance,
    );
    expect(normalizeConversation(raw)!.messages[0].agenticSteps![0].askStatus).toBe(
      "completed",
    );
  });

  test("drops a malformed ask guidance record instead of repairing it", () => {
    const msg: ConversationMessage = {
      id: "msg-ask",
      role: "assistant",
      content: "Done.",
      agenticSteps: [{
        type: "tool_call",
        round: 0,
        toolName: "ask_user",
        toolCallId: "ask-1",
      }],
    };
    const raw = jsonRoundTrip(makeConversation([msg])) as Record<string, unknown>;
    const messages = raw.messages as Array<Record<string, unknown>>;
    const steps = messages[0].agenticSteps as Array<Record<string, unknown>>;
    steps[0].askGuidance = {
      questions: [{
        question: "Which areas should I cover?",
        header: " Coverage ",
        answer: ["Testing"],
      }],
    };

    expect(normalizeConversation(raw)!.messages[0].agenticSteps![0].askGuidance).toBeUndefined();
  });

  test("drops an invalid structured ask status", () => {
    const msg: ConversationMessage = {
      id: "msg-ask",
      role: "assistant",
      content: "Done.",
      agenticSteps: [{
        type: "tool_call",
        round: 0,
        toolName: "ask_user",
      }],
    };
    const raw = jsonRoundTrip(makeConversation([msg])) as Record<string, unknown>;
    const messages = raw.messages as Array<Record<string, unknown>>;
    const steps = messages[0].agenticSteps as Array<Record<string, unknown>>;
    steps[0].askStatus = "pending";

    expect(normalizeConversation(raw)!.messages[0].agenticSteps![0].askStatus).toBeUndefined();
  });
});

describe("normalizeConversation, interrupted marker (section 4.C)", () => {
  test("preserves interrupted on a stopped assistant turn across a JSON round-trip", () => {
    const msg: ConversationMessage = {
      id: "msg-1",
      role: "assistant",
      content: "Once upon a",
      provider: "claudecode",
      interrupted: true,
    };
    const raw = jsonRoundTrip(makeConversation([msg])) as Record<string, unknown>;
    expect(normalizeConversation(raw)!.messages[0].interrupted).toBe(true);
  });

  test("a completed turn stays uninterrupted after load (no silent backfill)", () => {
    const msg: ConversationMessage = { id: "msg-1", role: "assistant", content: "All done." };
    const raw = jsonRoundTrip(makeConversation([msg])) as Record<string, unknown>;
    expect(normalizeConversation(raw)!.messages[0].interrupted).toBeUndefined();
  });
});

describe("toConversationMeta", () => {
  test("extracts metadata from full conversation", () => {
    const conv = makeConversation([
      { id: "m1", role: "user", content: "Hi" },
      { id: "m2", role: "assistant", content: "Hello" },
    ]);

    const meta = toConversationMeta(conv);

    expect(meta.id).toBe("conv-1");
    expect(meta.title).toBe("Test");
    expect(meta.messageCount).toBe(2);
    expect(meta.modelId).toBe("profile-1");
    expect(meta.modelName).toBe("Claude Haiku 3");
    expect((meta as Record<string, unknown>)["messages"]).toBeUndefined();
  });
});

describe("approval posture, per conversation", () => {
  test("a new conversation defaults to ask", () => {
    expect(createConversation("p1", "Model").approvalPosture).toBe("ask");
  });

  test("a branch inherits its source's posture, not the default", () => {
    const source: ConversationMeta = {
      id: "conv-1",
      title: "Original",
      createdAt: 1000,
      updatedAt: 2000,
      modelId: "p1",
      modelName: "Model",
      messageCount: 2,
      approvalPosture: "auto",
    };
    const branch = createBranchConversation(
      source,
      [{ id: "m1", role: "user", content: "Hi" }],
      "m1",
    );
    expect(branch.approvalPosture).toBe("auto");
    expect(branch.parentConversationId).toBe("conv-1");
  });

  test("a branch preserves completed ask guidance as an independent audit record", () => {
    const source: ConversationMeta = {
      id: "conv-1",
      title: "Original",
      createdAt: 1000,
      updatedAt: 2000,
      modelId: "p1",
      modelName: "Model",
      messageCount: 1,
      approvalPosture: "ask",
    };
    const message: ConversationMessage = {
      id: "assistant-1",
      role: "assistant",
      content: "Done.",
      agenticSteps: [{
        type: "tool_call",
        round: 0,
        toolName: "ask_user",
        askStatus: "completed",
        askGuidance: {
          questions: [{
            question: "Format?",
            header: "Output",
            answer: "<table> **Detailed**",
          }],
        },
      }],
    };

    const branch = createBranchConversation(source, [message], message.id);
    const branchedGuidance = branch.messages[0].agenticSteps?.[0].askGuidance;

    expect(branchedGuidance).toEqual(message.agenticSteps?.[0].askGuidance);
    expect(branchedGuidance).not.toBe(message.agenticSteps?.[0].askGuidance);
  });

  test("toConversationMeta carries the posture onto the meta", () => {
    const conv = makeConversation([]);
    conv.approvalPosture = "auto";
    expect(toConversationMeta(conv).approvalPosture).toBe("auto");
  });

  test("toConversationMeta defaults a legacy conversation with no posture to ask", () => {
    const conv = makeConversation([]);
    delete conv.approvalPosture;
    expect(toConversationMeta(conv).approvalPosture).toBe("ask");
  });

  test("normalizeConversation restores a persisted posture and defaults junk to ask", () => {
    const auto = makeConversation([]);
    auto.approvalPosture = "auto";
    const rawAuto = jsonRoundTrip(auto) as Record<string, unknown>;
    expect(normalizeConversation(rawAuto)!.approvalPosture).toBe("auto");

    const rawJunk = jsonRoundTrip(makeConversation([])) as Record<string, unknown>;
    rawJunk.approvalPosture = "plan"; // not a known posture
    expect(normalizeConversation(rawJunk)!.approvalPosture).toBe("ask");
  });

  test("normalizeChatHistory restores the meta's posture and defaults a legacy entry", () => {
    const raw = jsonRoundTrip({
      conversations: [
        { id: "conv-1", title: "A", createdAt: 1, updatedAt: 2, modelId: "p1", modelName: "M", messageCount: 0, approvalPosture: "auto" },
        { id: "conv-2", title: "B", createdAt: 1, updatedAt: 2, modelId: "p1", modelName: "M", messageCount: 0 },
      ],
      activeConversationId: "conv-1",
    });
    const result = normalizeChatHistory(raw);
    expect(result.conversations[0].approvalPosture).toBe("auto");
    expect(result.conversations[1].approvalPosture).toBe("ask");
  });

  test("normalizePosture coerces to ask unless it is exactly auto", () => {
    expect(normalizePosture("auto")).toBe("auto");
    expect(normalizePosture("ask")).toBe("ask");
    expect(normalizePosture(undefined)).toBe("ask");
    expect(normalizePosture("something")).toBe("ask");
  });
});
