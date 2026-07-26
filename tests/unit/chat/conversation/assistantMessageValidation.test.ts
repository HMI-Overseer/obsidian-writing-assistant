import { describe, expect, it } from "vitest";
import {
  ASSISTANT_MESSAGE_MAX_LEDGER_ENTRIES,
  ASSISTANT_MESSAGE_MAX_REVISIONS,
  validateAssistantMessageState,
} from "../../../../src/chat/conversation/assistantMessageValidation";
import type {
  AssistantMessageRevision,
  ToolActionLedgerEntry,
} from "../../../../src/shared/types";

function revision(
  revisionId = "revision-1",
): AssistantMessageRevision {
  return {
    revisionId,
    kind: "turn",
    origin: "generated",
    createdAt: 1,
    provider: "anthropic",
    modelId: "claude-fixture",
    turn: {
      schemaVersion: 1,
      id: `turn-${revisionId}`,
      status: "completed",
      segments: [{ id: `segment-${revisionId}` }],
      items: [
        {
          type: "tool_call",
          id: `item-${revisionId}`,
          segmentId: `segment-${revisionId}`,
          toolCallId: "tool-call-1",
          toolName: "remember",
          toolArguments: "{}",
          toolArgs: {},
          state: "completed",
          actionRef: "action-1",
        },
      ],
    },
  };
}

function ledger(): ToolActionLedgerEntry {
  return {
    actionRef: "action-1",
    revisionId: "revision-1",
    family: "memory",
    placement: {
      state: "placed",
      anchor: "tool_call",
      itemId: "item-revision-1",
      correlation: { kind: "provider_id", toolCallId: "tool-call-1" },
    },
    payload: {
      targets: [
        {
          targetId: "target-1",
          mutation: { kind: "forget", name: "fixture-memory" },
        },
      ],
    },
    events: [
      {
        eventId: "event-1",
        type: "proposed",
        targetId: "target-1",
        createdAt: 1,
      },
    ],
  };
}

function validState() {
  return {
    revisions: [revision()],
    activeRevisionId: "revision-1",
    actionLedger: [ledger()],
  };
}

describe("assistant message revision validation", () => {
  it("accepts a complete strict chain and copied action provenance", () => {
    const source = revision();
    const copied: AssistantMessageRevision = {
      ...structuredClone(source),
      revisionId: "revision-2",
      origin: "edited",
      parentRevisionId: "revision-1",
      createdAt: 2,
      turn: {
        ...structuredClone(source.turn),
        id: "turn-revision-2",
        segments: [{ id: "segment-revision-2" }],
        items: [
          {
            ...structuredClone(source.turn.items[0]),
            id: "item-revision-2",
            segmentId: "segment-revision-2",
            sourceItemId: "item-revision-1",
          },
        ],
      },
    };

    const result = validateAssistantMessageState({
      revisions: [source, copied],
      activeRevisionId: "revision-2",
      actionLedger: [ledger()],
    });

    expect(result.ok).toBe(true);
  });

  it("rejects missing active IDs, duplicate revision IDs, and malformed turns by name", () => {
    const missing = validateAssistantMessageState({
      ...validState(),
      activeRevisionId: "missing",
    });
    const duplicate = validateAssistantMessageState({
      ...validState(),
      revisions: [revision(), revision()],
    });
    const malformed = structuredClone(validState());
    const turnRevision = malformed.revisions[0];
    if (turnRevision.kind === "turn") {
      turnRevision.turn.items[0].segmentId = "missing";
    }

    expect(missing).toMatchObject({
      ok: false,
      reason: { code: "active_revision_invalid" },
    });
    expect(duplicate).toMatchObject({
      ok: false,
      reason: { code: "revision_id_duplicate" },
    });
    expect(validateAssistantMessageState(malformed)).toMatchObject({
      ok: false,
      reason: { code: "turn_invalid" },
    });
  });

  it("requires new turn attribution and preserves optional legacy unknowns", () => {
    const invalidTurn = structuredClone(revision());
    if (invalidTurn.kind === "turn") {
      (invalidTurn as Partial<typeof invalidTurn>).provider = undefined;
    }
    const legacy: AssistantMessageRevision = {
      revisionId: "legacy-1",
      kind: "legacy",
      content: "Legacy content.",
    };

    expect(
      validateAssistantMessageState({
        revisions: [invalidTurn],
        activeRevisionId: "revision-1",
        actionLedger: [],
      }),
    ).toMatchObject({
      ok: false,
      reason: { code: "revision_attribution_invalid" },
    });
    expect(
      validateAssistantMessageState({
        revisions: [legacy],
        activeRevisionId: "legacy-1",
        actionLedger: [],
      }).ok,
    ).toBe(true);
  });
});

describe("assistant message action-ledger validation", () => {
  it("requires every placed entry and item action reference to resolve both ways", () => {
    const badItem = structuredClone(validState());
    const badRevision = badItem.revisions[0];
    if (badRevision.kind === "turn") {
      badRevision.turn.items.push({
        type: "prose",
        id: "orphan-prose",
        segmentId: "segment-revision-1",
        text: "Orphaned parsed edit.",
        actionRef: "missing",
        actionAnchor: "parsed_edit",
      });
    }
    const badPlacement = structuredClone(validState());
    badPlacement.actionLedger[0].placement = {
      state: "placed",
      anchor: "tool_call",
      itemId: "missing",
      correlation: { kind: "provider_id", toolCallId: "tool-call-1" },
    };

    expect(validateAssistantMessageState(badItem)).toMatchObject({
      ok: false,
      reason: { code: "action_reference_invalid" },
    });
    expect(validateAssistantMessageState(badPlacement)).toMatchObject({
      ok: false,
      reason: { code: "placed_item_invalid" },
    });
  });

  it("requires copied references to prove provenance through sourceItemId", () => {
    const source = revision();
    const copied = structuredClone(source);
    copied.revisionId = "revision-2";
    copied.origin = "edited";
    copied.parentRevisionId = "revision-1";
    copied.createdAt = 2;
    copied.turn.id = "turn-revision-2";
    copied.turn.segments = [{ id: "segment-revision-2" }];
    copied.turn.items = [
      {
        ...copied.turn.items[0],
        id: "item-revision-2",
        segmentId: "segment-revision-2",
      },
    ];

    expect(
      validateAssistantMessageState({
        revisions: [source, copied],
        activeRevisionId: "revision-2",
        actionLedger: [ledger()],
      }),
    ).toMatchObject({
      ok: false,
      reason: { code: "source_item_invalid" },
    });
  });

  it("rejects fabricated unplaced item IDs and incomplete degradation evidence", () => {
    const withItemId = structuredClone(validState()) as unknown as Record<
      string,
      unknown
    >;
    const entries = withItemId.actionLedger as Array<Record<string, unknown>>;
    entries[0].placement = {
      state: "unplaced",
      correlation: { kind: "provider_id", toolCallId: "tool-call-1" },
      reason: "declaration_missing",
      itemId: "fabricated",
    };
    const incomplete = structuredClone(validState()) as unknown as Record<
      string,
      unknown
    >;
    const incompleteEntries = incomplete.actionLedger as Array<
      Record<string, unknown>
    >;
    incompleteEntries[0].placement = {
      state: "unplaced",
      correlation: { kind: "none", transport: "legacy" },
      reason: "correlation_unavailable",
    };

    expect(validateAssistantMessageState(withItemId)).toMatchObject({
      ok: false,
      reason: { code: "placement_invalid" },
    });
    expect(validateAssistantMessageState(incomplete)).toMatchObject({
      ok: false,
      reason: { code: "correlation_invalid" },
    });
  });

  it("rejects persisted provisional and inconsequential unplaced entries", () => {
    const provisional = structuredClone(validState());
    const provisionalRevision = provisional.revisions[0];
    if (provisionalRevision.kind === "turn") {
      provisionalRevision.turn.items = [];
    }
    provisional.actionLedger[0].placement = {
      state: "provisional",
      correlation: { kind: "provider_id", toolCallId: "tool-call-1" },
    };

    const proposedOnly = structuredClone(validState());
    const unplacedRevision = proposedOnly.revisions[0];
    if (unplacedRevision.kind === "turn") {
      unplacedRevision.turn.items = [];
    }
    proposedOnly.actionLedger[0].placement = {
      state: "unplaced",
      correlation: { kind: "provider_id", toolCallId: "tool-call-1" },
      reason: "declaration_missing",
    };

    expect(validateAssistantMessageState(provisional)).toMatchObject({
      ok: false,
      reason: { code: "placement_invalid" },
    });
    expect(validateAssistantMessageState(proposedOnly)).toMatchObject({
      ok: false,
      reason: { code: "placement_invalid" },
    });
  });

  it("accepts consequential unplaced evidence without fabricating an item", () => {
    const state = structuredClone(validState());
    const source = state.revisions[0];
    if (source.kind === "turn") source.turn.items = [];
    state.actionLedger[0].placement = {
      state: "unplaced",
      correlation: { kind: "provider_id", toolCallId: "tool-call-1" },
      reason: "declaration_missing",
    };
    state.actionLedger[0].events.push({
      eventId: "event-2",
      type: "declined",
      targetId: "target-1",
      createdAt: 2,
      reason: "Fixture decline.",
    });

    const result = validateAssistantMessageState(state);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.actionLedger[0].placement).not.toHaveProperty(
        "itemId",
      );
    }
  });

  it("rejects duplicate event IDs, invalid sequences, and oversized bounded fields", () => {
    const duplicate = structuredClone(validState());
    duplicate.actionLedger[0].events.push({
      ...duplicate.actionLedger[0].events[0],
    });
    const invalidSequence = structuredClone(validState());
    invalidSequence.actionLedger[0].events.push({
      eventId: "event-2",
      type: "undo_refused",
      targetId: "target-1",
      createdAt: 2,
      reason: "No applied effect.",
    });
    const oversized = structuredClone(validState());
    const target = oversized.actionLedger[0].payload.targets[0];
    if (oversized.actionLedger[0].family === "memory") {
      target.mutation = { kind: "forget", name: "x".repeat(8_001) };
    }

    expect(validateAssistantMessageState(duplicate)).toMatchObject({
      ok: false,
      reason: { code: "event_id_duplicate" },
    });
    expect(validateAssistantMessageState(invalidSequence)).toMatchObject({
      ok: false,
      reason: { code: "event_sequence_invalid" },
    });
    expect(validateAssistantMessageState(oversized)).toMatchObject({
      ok: false,
      reason: { code: "payload_invalid" },
    });
  });

  it("rejects oversized revision and ledger collections before traversing them", () => {
    const revisions = Array.from(
      { length: ASSISTANT_MESSAGE_MAX_REVISIONS + 1 },
      (_, index) => ({
        revisionId: `revision-${index}`,
        kind: "legacy" as const,
        content: `Revision ${index}`,
      }),
    );
    const entries = Array.from(
      { length: ASSISTANT_MESSAGE_MAX_LEDGER_ENTRIES + 1 },
      () => ledger(),
    );

    expect(
      validateAssistantMessageState({
        revisions,
        activeRevisionId: "revision-0",
        actionLedger: [],
      }),
    ).toMatchObject({
      ok: false,
      reason: { code: "revisions_too_many" },
    });
    expect(
      validateAssistantMessageState({
        ...validState(),
        actionLedger: entries,
      }),
    ).toMatchObject({
      ok: false,
      reason: { code: "ledger_too_many" },
    });
  });

  it("accepts parsed-edit placement only on its prose action anchor", () => {
    const state = validState();
    const source = state.revisions[0];
    if (source.kind !== "turn") throw new Error("Expected turn fixture.");
    source.turn.items = [
      {
        type: "prose",
        id: "prose-1",
        segmentId: "segment-revision-1",
        text: "SEARCH/REPLACE fixture",
        actionRef: "action-1",
        actionAnchor: "parsed_edit",
      },
    ];
    state.actionLedger[0] = {
      actionRef: "action-1",
      revisionId: "revision-1",
      family: "edit",
      placement: {
        state: "placed",
        anchor: "parsed_edit",
        itemId: "prose-1",
      },
      payload: { proposalId: "proposal-1", targets: [] },
      events: [],
    };

    expect(validateAssistantMessageState(state).ok).toBe(true);
  });
});
