import { describe, expect, it } from "vitest";
import { validateAssistantTurn } from "../../../../src/chat/turns/assistantTurnValidation";
import { validateAssistantMessageState } from "../../../../src/chat/conversation/assistantMessageValidation";
import {
  migrateTurnRevisionToVersion2,
  normalizeInFlightGenerationAudit,
} from "../../../../src/chat/conversation/assistantTurnMigration";
import {
  createBranchConversation,
  normalizeConversation,
} from "../../../../src/chat/conversation/conversationUtils";
import {
  hasCaptureInvalidItem,
  isReplayableItem,
  lowerEvidenceFromCapture,
  migratedPlacement,
  summarizeCaptureValidity,
  turnPlacementFloor,
} from "../../../../src/shared/captureEvidence";
import type {
  AssistantReplayEvidence,
  AssistantTurnRecord,
  AssistantTurnRevision,
  InFlightGenerationAudit,
  ProviderItemPlacement,
} from "../../../../src/shared/types";

const EXACT: ProviderItemPlacement = {
  kind: "exact",
  providerMessageKey: "sess_1:msg_1",
  providerBlockId: "block-2",
};

function turnV2(
  placement: ProviderItemPlacement = EXACT,
  overrides: Partial<AssistantTurnRecord> = {},
): AssistantTurnRecord {
  return {
    schemaVersion: 2,
    id: "turn-1",
    status: "completed",
    segments: [{ id: "segment-1", providerMessageId: "msg_1" }],
    items: [
      {
        type: "prose",
        id: "item-1",
        segmentId: "segment-1",
        text: "hello",
        captureEvidence: {
          originBatchId: "turn-1#1:frame-a",
          placement,
          validity: "valid",
        },
      },
    ],
    ...overrides,
  };
}

function turnV1(): AssistantTurnRecord {
  return {
    schemaVersion: 1,
    id: "turn-1",
    status: "completed",
    segments: [
      { id: "segment-1", providerMessageId: "msg_1" },
      { id: "segment-2" },
    ],
    items: [
      { type: "prose", id: "item-1", segmentId: "segment-1", text: "hello" },
      { type: "prose", id: "item-2", segmentId: "segment-2", text: "world" },
    ],
  };
}

function exactEvidence(): AssistantReplayEvidence {
  return {
    tier: "native",
    capabilities: {
      captureOrder: "exact",
      toolCorrelation: "provider_id",
      coldReplay: "structural",
      nativeResume: true,
    },
  };
}

describe("provider item placement validation", () => {
  it("accepts every valid placement shape", () => {
    for (const placement of [
      EXACT,
      { kind: "segment", providerMessageKey: "sess_1:msg_1" },
      { kind: "unplaced" },
    ] as ProviderItemPlacement[]) {
      expect(validateAssistantTurn(turnV2(placement)).ok, placement.kind).toBe(true);
    }
  });

  it("rejects exact placement without a provider block identity", () => {
    const turn = turnV2({
      kind: "exact",
      providerMessageKey: "sess_1:msg_1",
    } as unknown as ProviderItemPlacement);
    const result = validateAssistantTurn(turn);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.code).toBe("capture_placement_invalid");
  });

  it("rejects segment placement without a provider-message key", () => {
    const turn = turnV2({ kind: "segment" } as unknown as ProviderItemPlacement);
    const result = validateAssistantTurn(turn);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.code).toBe("capture_placement_invalid");
  });

  it("rejects unplaced placement carrying a provider-message key", () => {
    const turn = turnV2({
      kind: "unplaced",
      providerMessageKey: "sess_1:msg_1",
    } as unknown as ProviderItemPlacement);
    const result = validateAssistantTurn(turn);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.code).toBe("field_unexpected");
  });

  it("rejects an unknown placement kind", () => {
    const turn = turnV2({ kind: "guessed" } as unknown as ProviderItemPlacement);
    const result = validateAssistantTurn(turn);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.code).toBe("capture_placement_invalid");
  });

  it("requires evidence on every item of a version-2 turn", () => {
    const turn = turnV2();
    delete turn.items[0].captureEvidence;
    const result = validateAssistantTurn(turn);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.code).toBe("capture_evidence_missing");
  });

  it("forbids evidence on a version-1 turn", () => {
    const turn = { ...turnV2(), schemaVersion: 1 as const };
    const result = validateAssistantTurn(turn);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.code).toBe("capture_evidence_invalid");
  });

  it("forbids quiescence and diagnostics on a version-1 turn", () => {
    const quiescence = { ...turnV1(), quiescence: "proven" as const };
    expect(validateAssistantTurn(quiescence).ok).toBe(false);
    const diagnostics = {
      ...turnV1(),
      captureDiagnostics: [
        { code: "c", provider: "anthropic", stage: "capture", message: "m" },
      ],
    };
    expect(validateAssistantTurn(diagnostics).ok).toBe(false);
  });
});

describe("bounded capture diagnostics", () => {
  const diagnostic = {
    code: "capture_conflict_cross_batch",
    provider: "claudecode",
    stage: "capture",
    message: "One exact tool ID claimed two structured positions.",
  };

  it("accepts a bounded diagnostic", () => {
    expect(
      validateAssistantTurn(turnV2(EXACT, { captureDiagnostics: [diagnostic] })).ok,
    ).toBe(true);
  });

  it("accepts as many diagnostics as a failed turn produced", () => {
    const many = Array.from({ length: 40 }, () => ({ ...diagnostic }));
    expect(validateAssistantTurn(turnV2(EXACT, { captureDiagnostics: many })).ok).toBe(true);
  });

  it("rejects an unknown stage and any extra field", () => {
    const badStage = { ...diagnostic, stage: "somewhere" };
    expect(validateAssistantTurn(turnV2(EXACT, { captureDiagnostics: [badStage] })).ok).toBe(false);
    const extra = { ...diagnostic, rawPayload: "{}" };
    expect(validateAssistantTurn(turnV2(EXACT, { captureDiagnostics: [extra] })).ok).toBe(false);
  });
});

describe("fidelity derived from runtime evidence", () => {
  it("keeps an exact claim when every item is exactly placed", () => {
    expect(lowerEvidenceFromCapture(exactEvidence(), turnV2())).toEqual(exactEvidence());
  });

  it("lowers exact capture and native replay for a segment-placed item", () => {
    const lowered = lowerEvidenceFromCapture(
      exactEvidence(),
      turnV2({ kind: "segment", providerMessageKey: "sess_1:msg_1" }),
    );
    expect(lowered.capabilities.captureOrder).toBe("segment");
    expect(lowered.capabilities.nativeResume).toBe(false);
    expect(lowered.loweredReason).toBe("segment_placed_provider_item_present");
  });

  it("lowers to text-only for an unplaced item", () => {
    const lowered = lowerEvidenceFromCapture(exactEvidence(), turnV2({ kind: "unplaced" }));
    expect(lowered.capabilities.captureOrder).toBe("text_only");
    expect(lowered.loweredReason).toBe("unplaced_provider_item_present");
  });

  it("lowers cold replay to textual for a capture-invalid item", () => {
    const turn = turnV2();
    turn.items[0].captureEvidence = {
      originBatchId: "turn-1#1:frame-a",
      placement: EXACT,
      validity: "capture_invalid",
    };
    const lowered = lowerEvidenceFromCapture(exactEvidence(), turn);
    expect(lowered.capabilities.coldReplay).toBe("textual");
    expect(lowered.tier).toBe("textual");
    expect(lowered.loweredReason).toBe("capture_invalid_declaration_present");
    expect(hasCaptureInvalidItem(turn)).toBe(true);
  });

  it("forbids native resume under forced quiescence", () => {
    const lowered = lowerEvidenceFromCapture(
      exactEvidence(),
      turnV2(EXACT, { quiescence: "forced" }),
    );
    expect(lowered.capabilities.nativeResume).toBe(false);
    expect(lowered.loweredReason).toBe("forced_quiescence");
  });

  it("summarizes and floors placements over a whole turn", () => {
    const turn = turnV2();
    turn.items.push({
      type: "prose",
      id: "item-2",
      segmentId: "segment-1",
      text: "second",
      captureEvidence: {
        originBatchId: "turn-1#1:frame-b",
        placement: { kind: "unplaced" },
        validity: "valid",
      },
    });
    expect(turnPlacementFloor(turn)).toBe("unplaced");
    expect(summarizeCaptureValidity(turn)).toMatchObject({
      items: 2,
      exact: 1,
      unplaced: 1,
      captureInvalid: 0,
    });
  });

  it("treats an item with no evidence as unplaced rather than exact", () => {
    expect(turnPlacementFloor(turnV1())).toBe("unplaced");
    expect(summarizeCaptureValidity(turnV1()).unevidenced).toBe(2);
  });

  it("excludes capture-invalid and unplaced items from replay", () => {
    const valid = turnV2().items[0];
    expect(isReplayableItem(valid)).toBe(true);
    expect(isReplayableItem(turnV2({ kind: "unplaced" }).items[0])).toBe(false);
    const invalid = turnV2().items[0];
    invalid.captureEvidence = {
      originBatchId: "b",
      placement: EXACT,
      validity: "capture_invalid",
    };
    expect(isReplayableItem(invalid)).toBe(false);
  });
});

describe("version-1 to version-2 migration", () => {
  function revision(): AssistantTurnRevision {
    return {
      revisionId: "rev-1",
      kind: "turn",
      origin: "generated",
      createdAt: 1,
      provider: "claudecode",
      modelId: "sonnet",
      turn: turnV1(),
      replayEvidence: exactEvidence(),
    };
  }

  it("gives a segment with a provider-message ID segment placement only", () => {
    expect(migratedPlacement("msg_1")).toEqual({
      kind: "segment",
      providerMessageKey: "msg_1",
    });
  });

  it("gives everything else unplaced, never a guessed block index", () => {
    expect(migratedPlacement(undefined)).toEqual({ kind: "unplaced" });
    expect(migratedPlacement("   ")).toEqual({ kind: "unplaced" });
  });

  it("upgrades the turn and lowers its claim in one step", () => {
    const migrated = migrateTurnRevisionToVersion2(revision());
    expect(migrated.turn.schemaVersion).toBe(2);
    expect(migrated.turn.items[0].captureEvidence?.placement).toEqual({
      kind: "segment",
      providerMessageKey: "msg_1",
    });
    expect(migrated.turn.items[1].captureEvidence?.placement).toEqual({ kind: "unplaced" });
    // One unplaced item floors the whole turn, so no exact or native claim survives.
    expect(migrated.replayEvidence?.capabilities.captureOrder).toBe("text_only");
    expect(migrated.replayEvidence?.capabilities.nativeResume).toBe(false);
    expect(validateAssistantTurn(migrated.turn).ok).toBe(true);
  });

  it("is idempotent on an already migrated revision", () => {
    const once = migrateTurnRevisionToVersion2(revision());
    expect(migrateTurnRevisionToVersion2(once)).toBe(once);
  });

  it("leaves the source revision untouched", () => {
    const source = revision();
    migrateTurnRevisionToVersion2(source);
    expect(source.turn.schemaVersion).toBe(1);
    expect(source.turn.items[0].captureEvidence).toBeUndefined();
  });
});

describe("replay-evidence cross-check", () => {
  function state(turn: AssistantTurnRecord, replayEvidence: AssistantReplayEvidence) {
    return {
      revisions: [
        {
          revisionId: "rev-1",
          kind: "turn",
          origin: "generated",
          createdAt: 1,
          provider: "anthropic",
          modelId: "opus",
          turn,
          replayEvidence,
        },
      ],
      activeRevisionId: "rev-1",
      actionLedger: [],
    };
  }

  it("accepts a claim its items support", () => {
    expect(validateAssistantMessageState(state(turnV2(), exactEvidence())).ok).toBe(true);
  });

  it("rejects an exact claim over an unplaced item", () => {
    const result = validateAssistantMessageState(
      state(turnV2({ kind: "unplaced" }), exactEvidence()),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.code).toBe("revision_metadata_invalid");
  });

  it("rejects a resume cursor under forced quiescence", () => {
    const base = state(turnV2(EXACT, { quiescence: "forced" }), {
      tier: "textual",
      capabilities: {
        captureOrder: "exact",
        toolCorrelation: "provider_id",
        coldReplay: "structural",
        nativeResume: false,
      },
      loweredReason: "forced_quiescence",
    });
    const withCursor = {
      ...base,
      revisions: [
        {
          ...base.revisions[0],
          usage: {
            inputTokens: 1,
            outputTokens: 1,
            resumeCursor: {
              sessionId: "sess",
              coveredCount: 2,
              prefixHash: "hash",
              configFingerprint: "fp",
            },
          },
        },
      ],
    };
    const result = validateAssistantMessageState(withCursor);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.path).toContain("resumeCursor");
  });

  it("does not cross-check a version-1 turn", () => {
    expect(validateAssistantMessageState(state(turnV1(), exactEvidence())).ok).toBe(true);
  });
});

describe("in-flight generation audit", () => {
  function audit(): InFlightGenerationAudit {
    return {
      messageId: "message-1",
      leaseId: "turn-1#1",
      turnId: "turn-1",
      attemptOrdinal: 1,
      openedAt: 1700000000000,
      intents: [
        {
          intentId: "intent-1",
          actionRef: "action-toolu_1",
          family: "vault_op",
          targetId: "target-1",
          correlation: { kind: "provider_id", toolCallId: "toolu_1" },
          summary: "Create Notes/new.md",
          recordedAt: 1700000000001,
          outcome: "pending",
        },
      ],
    };
  }

  it("round-trips through JSON", () => {
    const parsed: unknown = JSON.parse(JSON.stringify(audit()));
    expect(normalizeInFlightGenerationAudit(parsed)).toEqual(audit());
  });

  it("survives a conversation load", () => {
    const conversation = normalizeConversation({
      id: "conversation-1",
      title: "",
      createdAt: 1,
      updatedAt: 1,
      modelId: "anthropic:opus",
      modelName: "Opus",
      messages: [],
      draft: "",
      inFlightGenerationAudit: audit(),
    });
    expect(conversation?.inFlightGenerationAudit).toEqual(audit());
  });

  it("is absent, not invented, when the conversation carries none", () => {
    const conversation = normalizeConversation({
      id: "conversation-1",
      title: "",
      createdAt: 1,
      updatedAt: 1,
      modelId: "anthropic:opus",
      modelName: "Opus",
      messages: [],
      draft: "",
    });
    expect(conversation?.inFlightGenerationAudit).toBeUndefined();
  });

  it("rejects a malformed record rather than repairing it", () => {
    for (const mutate of [
      (value: Record<string, unknown>) => delete value.leaseId,
      (value: Record<string, unknown>) => {
        value.attemptOrdinal = 0;
      },
      (value: Record<string, unknown>) => {
        (value.intents as Record<string, unknown>[])[0].family = "unknown_family";
      },
      (value: Record<string, unknown>) => {
        (value.intents as Record<string, unknown>[])[0].outcome = "maybe";
      },
      (value: Record<string, unknown>) => {
        (value.intents as Record<string, unknown>[])[0].correlation = { kind: "guessed" };
      },
      (value: Record<string, unknown>) => {
        (value.intents as Record<string, unknown>[])[0].summary = "";
      },
    ]) {
      const raw = JSON.parse(JSON.stringify(audit())) as Record<string, unknown>;
      mutate(raw);
      expect(normalizeInFlightGenerationAudit(raw)).toBeNull();
    }
  });

  it("is not inherited by a branch", () => {
    const source = normalizeConversation({
      id: "conversation-1",
      title: "Source",
      createdAt: 1,
      updatedAt: 1,
      modelId: "anthropic:opus",
      modelName: "Opus",
      messages: [{ id: "message-1", role: "user", content: "hello" }],
      draft: "",
      inFlightGenerationAudit: audit(),
    });
    expect(source?.inFlightGenerationAudit).toBeDefined();

    const branch = createBranchConversation(
      {
        id: source!.id,
        title: source!.title,
        createdAt: source!.createdAt,
        updatedAt: source!.updatedAt,
        modelId: source!.modelId,
        modelName: source!.modelName,
        messageCount: source!.messages.length,
      },
      source!.messages,
      "message-1",
    );

    // A branch is new work; it inherits history but never an unfinished
    // generation's write-ahead evidence (RFC-0011 criterion 35).
    expect(branch.inFlightGenerationAudit).toBeUndefined();
  });

  it("keeps every intent a long generation produced", () => {
    // The round cap is user-settable to 50 and Claude Code's own agent loop is
    // not bounded by it at all. There is no count at which discarding evidence
    // of irreversible work is the better answer (RFC-0010).
    const raw = JSON.parse(JSON.stringify(audit())) as InFlightGenerationAudit;
    const template = raw.intents[0];
    raw.intents = Array.from({ length: 2000 }, (_value, index) => ({
      ...template,
      intentId: `intent-${index}`,
    }));

    expect(normalizeInFlightGenerationAudit(raw)?.intents).toHaveLength(2000);
  });

  it("rejects duplicate intent identities", () => {
    const raw = JSON.parse(JSON.stringify(audit())) as InFlightGenerationAudit;
    raw.intents = [raw.intents[0], structuredClone(raw.intents[0])];
    expect(normalizeInFlightGenerationAudit(raw)).toBeNull();
  });
});

describe("write-ahead ledger evidence", () => {
  function ledgerState(events: unknown[]) {
    return {
      revisions: [
        {
          revisionId: "rev-1",
          kind: "turn",
          origin: "generated",
          createdAt: 1,
          provider: "claudecode",
          modelId: "sonnet",
          turn: turnV1(),
        },
      ],
      activeRevisionId: "rev-1",
      actionLedger: [
        {
          actionRef: "action-1",
          revisionId: "rev-1",
          family: "memory",
          placement: {
            state: "unplaced",
            correlation: { kind: "provider_id", toolCallId: "toolu_1" },
            reason: "declaration_missing",
          },
          payload: {
            targets: [
              {
                targetId: "target-1",
                mutation: { kind: "forget", name: "old-note" },
              },
            ],
          },
          events,
        },
      ],
    };
  }

  it("accepts an intent and its unknown outcome", () => {
    const result = validateAssistantMessageState(
      ledgerState([
        { eventId: "e1", type: "proposed", targetId: "target-1", createdAt: 1 },
        {
          eventId: "e2",
          type: "intent_recorded",
          targetId: "target-1",
          createdAt: 2,
          intentId: "intent-1",
        },
        {
          eventId: "e3",
          type: "outcome_unknown",
          targetId: "target-1",
          createdAt: 3,
          intentId: "intent-1",
          reason: "forced_disposal",
        },
      ]),
    );
    expect(result.ok ? null : result.reason).toBeNull();
  });

  it("rejects an intent with no identity to reconcile against", () => {
    const result = validateAssistantMessageState(
      ledgerState([
        { eventId: "e1", type: "proposed", targetId: "target-1", createdAt: 1 },
        { eventId: "e2", type: "intent_recorded", targetId: "target-1", createdAt: 2 },
      ]),
    );
    expect(result.ok).toBe(false);
  });
});
