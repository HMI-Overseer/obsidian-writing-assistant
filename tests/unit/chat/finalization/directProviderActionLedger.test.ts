import { describe, expect, it } from "vitest";
import type { EditProposal } from "../../../../src/editing/editTypes";
import type {
  AssistantTurnRecord,
  GenerationAuditIntent,
} from "../../../../src/shared/types";
import type { ReviewableMemoryProposal } from "../../../../src/chat/messages/memoryReviewTimeline";
import type {
  AppliedVaultOpRecord,
  VaultOperationProposal,
} from "../../../../src/vault-ops/types";
import {
  buildDirectProviderActionLedger,
  unmatchedAuditIntents,
} from "../../../../src/chat/finalization/directProviderActionLedger";

const askArguments = {
  questions: [{
    question: "Which format?",
    header: "Format",
    options: [
      { label: "Short", description: "Use a compact answer." },
      { label: "Long", description: "Include supporting detail." },
    ],
    multiSelect: false,
  }],
};

const turn: AssistantTurnRecord = {
  schemaVersion: 1,
  id: "turn-1",
  status: "completed",
  segments: [{ id: "segment-1" }],
  items: [
    {
      type: "tool_call",
      id: "item-edit",
      segmentId: "segment-1",
      toolCallId: "call-edit",
      toolName: "propose_edit",
      toolArguments: "{}",
      toolArgs: {},
      state: "completed",
      actionRef: "action-edit",
    },
    {
      type: "tool_call",
      id: "item-vault",
      segmentId: "segment-1",
      toolCallId: "call-vault",
      toolName: "create_directory",
      toolArguments: "{}",
      toolArgs: {},
      state: "completed",
      actionRef: "action-vault",
    },
    {
      type: "tool_call",
      id: "item-memory",
      segmentId: "segment-1",
      toolCallId: "call-memory",
      toolName: "add_memory",
      toolArguments: "{}",
      toolArgs: {},
      state: "completed",
      actionRef: "action-memory",
    },
    {
      type: "tool_call",
      id: "item-ask",
      segmentId: "segment-1",
      toolCallId: "call-ask",
      toolName: "ask_user",
      toolArguments: JSON.stringify(askArguments),
      toolArgs: askArguments,
      state: "completed",
      actionRef: "action-ask",
      askStatus: "completed",
      askGuidance: {
        questions: [{
          question: "Which format?",
          header: "Format",
          answer: "Short",
        }],
      },
    },
  ],
};

const editProposal: EditProposal = {
  id: "proposal-edit",
  targetFilePath: "Note.md",
  documentSnapshot: "before",
  snapshotTimestamp: 20,
  prose: "",
  hunks: [{
    id: "hunk-1",
    status: "rejected",
    resolvedEdit: {
      id: "resolved-1",
      editBlock: {
        id: "call-edit",
        searchText: "before",
        replaceText: "after",
        rawBlock: "[tool_call:call-edit]",
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
  }],
};

const vaultProposal: VaultOperationProposal = {
  id: "proposal-vault",
  createdAt: 21,
  ops: [{
    id: "op-1",
    op: { kind: "createDir", path: "Folder" },
    gate: "ask",
    status: "applied",
    summary: "Create Folder",
    sourceToolCallId: "call-vault",
  }],
};

const vaultRecord: AppliedVaultOpRecord = {
  proposalId: "proposal-vault",
  applied: [{
    opId: "op-1",
    inverse: { kind: "trashFolder", path: "Folder" },
  }],
  appliedAt: 30,
};

const memoryProposal: ReviewableMemoryProposal = {
  id: "memory-1",
  sourceToolCallId: "call-memory",
  call: {
    id: "call-memory",
    name: "add_memory",
    arguments: {},
  },
  mutation: {
    kind: "add",
    memory: {
      name: "compact-style",
      type: "rule",
      description: "Prefer compact answers.",
      enabled: true,
    },
  },
  status: "applied",
};

describe("direct provider action ledger", () => {
  it("places every review family on its exact tool item and records outcomes", () => {
    let eventIndex = 0;
    const ledger = buildDirectProviderActionLedger({
      revisionId: "revision-1",
      turn,
      toolCorrelations: {
        "call-edit": "provider_id",
        "call-vault": "provider_id",
        "call-memory": "provider_id",
        "call-ask": "provider_id",
      },
      editProposals: [editProposal],
      vaultOpProposal: vaultProposal,
      appliedVaultOpRecord: vaultRecord,
      memoryProposals: [memoryProposal],
      createEventId: () => `event-${eventIndex++}`,
      createdAt: 25,
    });

    expect(ledger.map((entry) => entry.family)).toEqual([
      "edit",
      "vault_op",
      "memory",
      "interaction",
    ]);
    expect(ledger.map((entry) => entry.placement)).toEqual([
      expect.objectContaining({ state: "placed", itemId: "item-edit" }),
      expect.objectContaining({ state: "placed", itemId: "item-vault" }),
      expect.objectContaining({ state: "placed", itemId: "item-memory" }),
      expect.objectContaining({ state: "placed", itemId: "item-ask" }),
    ]);
    expect(ledger.every((entry) => entry.revisionId === "revision-1")).toBe(
      true,
    );
    expect(ledger[0].events.map((event) => event.type)).toEqual([
      "proposed",
      "declined",
    ]);
    expect(ledger[1].events.map((event) => event.type)).toEqual([
      "proposed",
      "approved",
      "apply_succeeded",
    ]);
    expect(ledger[2].events.map((event) => event.type)).toEqual([
      "proposed",
      "apply_succeeded",
    ]);
    expect(ledger[3].events.map((event) => event.type)).toEqual([
      "proposed",
      "apply_succeeded",
    ]);
    expect(ledger[1].events.at(-1)).toMatchObject({
      effect: {
        family: "vault_op",
        inverse: { kind: "trashFolder", path: "Folder" },
      },
    });
  });

  it("retains consequential undeclared decisions without fabricating placement", () => {
    let eventIndex = 0;
    const ledger = buildDirectProviderActionLedger({
      revisionId: "revision-1",
      turn: {
        ...turn,
        items: turn.items.filter((item) => item.id !== "item-edit"),
      },
      toolCorrelations: { "call-edit": "provider_id" },
      actionRefsByToolCallId: { "call-edit": "action-edit" },
      editProposals: [editProposal],
      createEventId: () => `event-unplaced-${eventIndex++}`,
      createdAt: 25,
    });

    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({
      actionRef: "action-edit",
      placement: {
        state: "unplaced",
        reason: "declaration_missing",
        correlation: {
          kind: "provider_id",
          toolCallId: "call-edit",
        },
      },
      events: [
        { type: "proposed" },
        { type: "declined" },
      ],
    });
  });

  it("discards proposed-only undeclared work", () => {
    const pendingProposal: VaultOperationProposal = {
      ...vaultProposal,
      ops: vaultProposal.ops.map((operation) => ({
        ...operation,
        status: "pending",
      })),
    };

    expect(
      buildDirectProviderActionLedger({
        revisionId: "revision-1",
        turn: {
          ...turn,
          items: turn.items.filter((item) => item.id !== "item-vault"),
        },
        toolCorrelations: { "call-vault": "provider_id" },
        actionRefsByToolCallId: { "call-vault": "action-vault" },
        vaultOpProposal: pendingProposal,
        createEventId: () => "event-proposed-only",
        createdAt: 25,
      }),
    ).toEqual([]);
  });

  it.each([
    ["declined", "rejected", undefined],
    ["failed", "failed", undefined],
    ["auto-applied", "applied", vaultRecord],
  ] as const)(
    "keeps an undeclared %s vault operation auditable",
    (_label, status, appliedRecord) => {
      let eventIndex = 0;
      const proposal: VaultOperationProposal = {
        ...vaultProposal,
        ops: vaultProposal.ops.map((operation) => ({
          ...operation,
          gate: status === "applied" ? "auto" : operation.gate,
          status,
        })),
      };
      const ledger = buildDirectProviderActionLedger({
        revisionId: "revision-1",
        turn: {
          ...turn,
          items: turn.items.filter((item) => item.id !== "item-vault"),
        },
        toolCorrelations: { "call-vault": "provider_id" },
        actionRefsByToolCallId: { "call-vault": "action-vault" },
        vaultOpProposal: proposal,
        ...(appliedRecord
          ? { appliedVaultOpRecord: appliedRecord }
          : {}),
        createEventId: () => `event-${status}-${eventIndex++}`,
        createdAt: 25,
      });

      expect(ledger).toHaveLength(1);
      expect(ledger[0].placement).toMatchObject({
        state: "unplaced",
        reason: "declaration_missing",
      });
      expect(ledger[0].events.some((event) => event.type !== "proposed")).toBe(
        true,
      );
    },
  );
  it("anchors regex edit fallback honestly on the parsed prose item", () => {
    const parsedTurn: AssistantTurnRecord = {
      schemaVersion: 1,
      id: "turn-regex",
      status: "completed",
      segments: [{ id: "segment-regex" }],
      items: [{
        type: "prose",
        id: "item-prose",
        segmentId: "segment-regex",
        text: "<<<SEARCH\nbefore\n===\nafter\n>>>REPLACE",
        actionRef: "action-regex",
        actionAnchor: "parsed_edit",
      }],
    };
    let eventIndex = 0;

    const [entry] = buildDirectProviderActionLedger({
      revisionId: "revision-regex",
      turn: parsedTurn,
      toolCorrelations: {},
      editProposals: [editProposal],
      parsedEditPlacement: {
        itemId: "item-prose",
        actionRef: "action-regex",
      },
      createEventId: () => `event-regex-${eventIndex++}`,
      createdAt: 25,
    });

    expect(entry.placement).toEqual({
      state: "placed",
      anchor: "parsed_edit",
      itemId: "item-prose",
    });
  });
});

/**
 * RFC-0011 phase 6, plan section 9.2: the terminal fold.
 *
 * A write-ahead intent is durable evidence in its own structure while the
 * generation runs. At finalization it has to become part of the append-only
 * history, and the position matters: `intent_recorded` is only valid before an
 * effect, so it folds in behind the proposal and ahead of whatever the review
 * decided.
 */
function auditIntent(
  overrides: Partial<GenerationAuditIntent> = {},
): GenerationAuditIntent {
  return {
    intentId: "intent-action-vault-op-1",
    actionRef: "action-vault",
    family: "vault_op",
    targetId: "op-1",
    correlation: { kind: "provider_id", toolCallId: "call-vault" },
    summary: "create_directory Folder",
    recordedAt: 22,
    outcome: "resolved",
    ...overrides,
  };
}

describe("write-ahead intents folded into the ledger", () => {
  const foldInput = (intents: GenerationAuditIntent[]) => ({
    revisionId: "revision-1",
    turn,
    toolCorrelations: { "call-vault": "provider_id" as const },
    vaultOpProposal: vaultProposal,
    appliedVaultOpRecord: vaultRecord,
    intents,
    createEventId: (() => {
      let index = 0;
      return () => `event-fold-${index++}`;
    })(),
    createdAt: 25,
  });

  it("records the intent before the outcome it preceded", () => {
    const [entry] = buildDirectProviderActionLedger(foldInput([auditIntent()]));

    expect(entry.events.map((event) => event.type)).toEqual([
      "proposed",
      "intent_recorded",
      "approved",
      "apply_succeeded",
    ]);
    expect(entry.events[1]).toMatchObject({
      intentId: "intent-action-vault-op-1",
      targetId: "op-1",
    });
  });

  it("marks an unreconciled intent whose outcome never arrived unknown", () => {
    const [entry] = buildDirectProviderActionLedger({
      ...foldInput([auditIntent({ outcome: "unknown" })]),
      // The review registered the op and then the generation died, so the
      // proposal is still pending and no apply event exists.
      vaultOpProposal: {
        ...vaultProposal,
        ops: [{ ...vaultProposal.ops[0], status: "pending" }],
      },
      appliedVaultOpRecord: undefined,
    });

    expect(entry.events.map((event) => event.type)).toEqual([
      "proposed",
      "intent_recorded",
      "outcome_unknown",
    ]);
    expect(entry.events.at(-1)).toMatchObject({
      intentId: "intent-action-vault-op-1",
      reason: expect.stringContaining("unknown"),
    });
  });

  it("keeps a real outcome instead of overwriting it with unknown", () => {
    // The ledger's own evidence is stronger than the audit's last known state.
    const [entry] = buildDirectProviderActionLedger(
      foldInput([auditIntent({ outcome: "unknown" })]),
    );

    expect(entry.events.map((event) => event.type)).toEqual([
      "proposed",
      "intent_recorded",
      "approved",
      "apply_succeeded",
    ]);
  });

  it("reports an intent whose action never reached its review as unmatched", () => {
    const stranded = auditIntent({
      intentId: "intent-action-edit-hunk-9",
      actionRef: "action-edit",
      family: "edit",
      targetId: "Notes/never.md",
      correlation: { kind: "provider_id", toolCallId: "call-edit" },
      outcome: "unknown",
    });
    // The folded intent is also `unknown`, so "unmatched" has to mean "no entry
    // took it" rather than merely "its outcome was never reconciled". A mutant
    // that ignored the fold survived the first version of this case.
    const intents = [auditIntent({ outcome: "unknown" }), stranded];
    const entries = buildDirectProviderActionLedger(foldInput(intents));

    // No proposal exists for it, so no ledger payload can be built without
    // inventing one; the terminal turn carries it as a bounded diagnostic.
    expect(unmatchedAuditIntents(entries, intents)).toEqual([stranded]);
  });

  it("leaves a proposed-only action with no intent record", () => {
    const [entry] = buildDirectProviderActionLedger({
      ...foldInput([]),
      vaultOpProposal: {
        ...vaultProposal,
        ops: [{ ...vaultProposal.ops[0], status: "pending" }],
      },
      appliedVaultOpRecord: undefined,
    });

    // Settled decision 22: a proposal alone never enters the durable audit, so
    // it produces no write-ahead evidence at the fold either.
    expect(entry.events.map((event) => event.type)).toEqual(["proposed"]);
  });
});
