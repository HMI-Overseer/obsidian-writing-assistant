import { describe, expect, it } from "vitest";
import {
  actionLedgerSummaryEntries,
  buildActionLedgerReviewModel,
} from "../../../../src/chat/messages/actionLedgerReview";
import type {
  ToolActionLedgerEntry,
} from "../../../../src/shared/types";

function entry(
  family: ToolActionLedgerEntry["family"],
): ToolActionLedgerEntry {
  const common = {
    actionRef: `action-${family}`,
    revisionId: "revision-1",
    placement: {
      state: "placed" as const,
      anchor: "tool_call" as const,
      itemId: `item-${family}`,
      correlation: {
        kind: "provider_id" as const,
        toolCallId: `call-${family}`,
      },
    },
    events: [
      {
        eventId: `event-${family}`,
        type: "proposed" as const,
        targetId: `target-${family}`,
        createdAt: 1,
      },
    ],
  };
  switch (family) {
    case "edit":
      return {
        ...common,
        family,
        payload: {
          proposalId: "proposal-edit",
          targets: [
            {
              targetId: "target-edit",
              targetFilePath: "Fixture.md",
              documentSnapshot: "before",
              snapshotTimestamp: 1,
              resolvedEdit: {
                id: "resolved-edit",
                editBlock: {
                  id: "call-edit",
                  searchText: "before",
                  replaceText: "after",
                  rawBlock: "",
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
      };
    case "vault_op":
      return {
        ...common,
        family,
        payload: {
          proposalId: "proposal-vault",
          createdAt: 1,
          targets: [
            {
              targetId: "target-vault_op",
              operation: {
                kind: "create",
                path: "Fixture.md",
                content: "Fixture.",
              },
              gate: "ask",
              summary: "Create Fixture.md",
            },
          ],
        },
      };
    case "memory":
      return {
        ...common,
        family,
        payload: {
          targets: [
            {
              targetId: "target-memory",
              mutation: {
                kind: "forget",
                name: "fixture-memory",
              },
            },
          ],
        },
      };
    case "interaction":
      return {
        ...common,
        family,
        payload: {
          kind: "ask_user",
          targets: [
            {
              targetId: "target-interaction",
              question: "Continue?",
              header: "Choice",
              options: ["Yes", "No"],
              multiSelect: false,
            },
          ],
        },
      };
  }
}

const activeEligibility = {
  canApprove: true,
  canDecline: true,
  canApply: false,
  canUndo: false,
};

describe("ledger-backed review models", () => {
  it("leaves edit hunks to the original edit review renderer", () => {
    const summaries = actionLedgerSummaryEntries([
      entry("edit"),
      entry("vault_op"),
      entry("memory"),
      entry("interaction"),
    ]);

    expect(summaries.map((candidate) => candidate.family)).toEqual([
      "vault_op",
      "memory",
      "interaction",
    ]);
  });

  it.each([
    ["edit", "Fixture.md"],
    ["vault_op", "Create Fixture.md"],
    ["memory", "fixture-memory"],
    ["interaction", "Choice: Continue?"],
  ] as const)("binds %s review by itemId and actionRef", (family, label) => {
    const model = buildActionLedgerReviewModel(
      entry(family),
      () => activeEligibility,
    );

    expect(model.binding).toEqual({
      actionRef: `action-${family}`,
      placement: "placed",
      itemId: `item-${family}`,
    });
    expect(model.targets).toEqual([
      expect.objectContaining({
        targetId: `target-${family}`,
        label: expect.stringContaining(label),
        controls: ["approve", "decline"],
      }),
    ]);
  });

  it("keeps provisional and unplaced entries out of ordered item binding", () => {
    const provisional = entry("memory");
    provisional.placement = {
      state: "provisional",
      correlation: {
        kind: "provider_id",
        toolCallId: "call-memory",
      },
    };
    const unplaced = structuredClone(provisional);
    unplaced.placement = {
      state: "unplaced",
      correlation: {
        kind: "provider_id",
        toolCallId: "call-memory",
      },
      reason: "declaration_missing",
    };

    expect(
      buildActionLedgerReviewModel(provisional, () => activeEligibility).binding,
    ).toEqual({
      actionRef: "action-memory",
      placement: "provisional",
    });
    expect(
      buildActionLedgerReviewModel(unplaced, () => activeEligibility).binding,
    ).toEqual({
      actionRef: "action-memory",
      placement: "unplaced",
    });
  });

  it("offers only what is still actionable, never the target's lifecycle state", () => {
    const applied = entry("memory");
    applied.events.push({
      eventId: "applied-memory",
      type: "apply_succeeded",
      targetId: "target-memory",
      createdAt: 2,
      effect: {
        family: "memory",
        before: null,
        after: null,
        appliedAt: 2,
      },
    });
    const undone = structuredClone(applied);
    undone.events.push({
      eventId: "undone-memory",
      type: "undo_succeeded",
      targetId: "target-memory",
      createdAt: 3,
      undo: {
        family: "memory",
        restored: null,
        undoneAt: 3,
      },
    });

    expect(
      buildActionLedgerReviewModel(applied, () => ({
        ...activeEligibility,
        canApprove: false,
        canDecline: false,
        canUndo: true,
      })).targets[0],
    ).toEqual({
      targetId: "target-memory",
      label: "fixture-memory",
      controls: ["undo"],
    });
    // An undone target used to offer Retry, a redo button hiding in an audit log.
    // It now offers nothing, so it contributes no row at all.
    expect(
      buildActionLedgerReviewModel(undone, () => ({
        ...activeEligibility,
        canApprove: false,
        canDecline: false,
      })).targets[0],
    ).toEqual({
      targetId: "target-memory",
      label: "fixture-memory",
      controls: [],
    });
  });

  it("keeps a failed target's error out of the transcript projection", () => {
    const failed = entry("vault_op");
    failed.events.push({
      eventId: "failed-vault",
      type: "apply_failed",
      targetId: "target-vault_op",
      createdAt: 2,
      error: "Vault operation failed.",
    });

    const target = buildActionLedgerReviewModel(failed, () => ({
      ...activeEligibility,
      canApprove: false,
      canDecline: false,
    })).targets[0];

    expect(target).toEqual({
      targetId: "target-vault_op",
      label: "Create Fixture.md",
      controls: [],
    });
    expect(JSON.stringify(target)).not.toContain("failed");
  });
});
