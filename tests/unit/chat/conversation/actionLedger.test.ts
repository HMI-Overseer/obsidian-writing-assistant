import { describe, expect, it } from "vitest";
import {
  appendActionEvent,
  attachProvisionalAction,
  createPlacedParsedEditAction,
  createPlacedToolAction,
  createProvisionalAction,
  deriveActionControlEligibility,
  deriveActionLedgerState,
  finalizeUndeclaredAction,
  isConsequentialActionEvent,
  supersedeUnresolvedActions,
} from "../../../../src/chat/conversation/actionLedger";
import type {
  MemoryActionPayload,
  ToolActionEvent,
  ToolActionLedgerEntry,
} from "../../../../src/shared/types";

function memoryPayload(
  targetIds = ["target-1"],
): MemoryActionPayload {
  return {
    targets: targetIds.map((targetId) => ({
      targetId,
      mutation: { kind: "forget" as const, name: `memory-${targetId}` },
    })),
  };
}

function event(
  type: ToolActionEvent["type"],
  targetId = "target-1",
  sequence = 1,
): ToolActionEvent {
  const base = {
    eventId: `event-${sequence}`,
    targetId,
    createdAt: sequence,
  };
  switch (type) {
    case "proposed":
    case "approved":
    case "retry_requested":
      return { ...base, type };
    case "declined":
      return { ...base, type, reason: "Declined in fixture." };
    case "apply_succeeded":
      return {
        ...base,
        type,
        effect: {
          family: "memory",
          before: null,
          after: null,
          appliedAt: sequence,
        },
      };
    case "apply_failed":
      return { ...base, type, error: "Apply failed in fixture." };
    case "undo_succeeded":
      return {
        ...base,
        type,
        undo: { family: "memory", restored: null, undoneAt: sequence },
      };
    case "undo_refused":
      return { ...base, type, reason: "Drift guard refused undo." };
    case "superseded":
      return {
        ...base,
        type,
        replacementRevisionId: "revision-2",
      };
  }
}

function placedEntry(
  targetIds = ["target-1"],
): ToolActionLedgerEntry {
  return createPlacedToolAction({
    actionRef: "action-1",
    revisionId: "revision-1",
    family: "memory",
    itemId: "tool-item-1",
    correlation: { kind: "provider_id", toolCallId: "tool-call-1" },
    payload: memoryPayload(targetIds),
    proposedEvents: targetIds.map((targetId, index) =>
      event("proposed", targetId, index + 1),
    ),
  });
}

function append(
  entry: ToolActionLedgerEntry,
  type: ToolActionEvent["type"],
  targetId: string,
  sequence: number,
): ToolActionLedgerEntry {
  return appendActionEvent(entry, event(type, targetId, sequence));
}

describe("action-ledger creation and immutable append", () => {
  it("creates placed tool and parsed-edit entries without sharing payload state", () => {
    const payload = memoryPayload();
    const toolEntry = createPlacedToolAction({
      actionRef: "action-tool",
      revisionId: "revision-1",
      family: "memory",
      itemId: "tool-item-1",
      correlation: { kind: "plugin_id", toolCallId: "tool-call-1" },
      payload,
      proposedEvents: [event("proposed")],
    });
    const parsedEntry = createPlacedParsedEditAction({
      actionRef: "action-edit",
      revisionId: "revision-1",
      itemId: "prose-item-1",
      payload: { proposalId: "proposal-1", targets: [] },
      proposedEvents: [],
    });

    payload.targets[0].mutation = { kind: "forget", name: "mutated" };

    expect(toolEntry.placement).toEqual({
      state: "placed",
      anchor: "tool_call",
      itemId: "tool-item-1",
      correlation: { kind: "plugin_id", toolCallId: "tool-call-1" },
    });
    expect(toolEntry.payload).not.toEqual(payload);
    expect(Object.isFrozen(toolEntry.payload)).toBe(true);
    expect(parsedEntry).toMatchObject({
      family: "edit",
      placement: {
        state: "placed",
        anchor: "parsed_edit",
        itemId: "prose-item-1",
      },
    });
  });

  it("appends events immutably and treats an identical event ID as idempotent", () => {
    const original = placedEntry();
    const approved = event("approved", "target-1", 2);
    const appended = appendActionEvent(original, approved);
    const duplicate = appendActionEvent(appended, structuredClone(approved));

    expect(original.events.map((entry) => entry.type)).toEqual(["proposed"]);
    expect(appended.events.map((entry) => entry.type)).toEqual([
      "proposed",
      "approved",
    ]);
    expect(duplicate).toBe(appended);
    expect(() =>
      appendActionEvent(appended, { ...approved, createdAt: 3 }),
    ).toThrow(/event ID/i);
  });

  it("rejects unknown targets, decreasing event order, and invalid transitions", () => {
    const entry = placedEntry();
    const unproposed = createPlacedToolAction({
      actionRef: "action-unproposed",
      revisionId: "revision-1",
      family: "memory",
      itemId: "tool-item-1",
      correlation: { kind: "provider_id", toolCallId: "tool-call-1" },
      payload: memoryPayload(),
      proposedEvents: [],
    });

    expect(() =>
      appendActionEvent(entry, event("approved", "missing", 2)),
    ).toThrow(/target/i);
    expect(() =>
      appendActionEvent(unproposed, event("approved", "target-1", 1)),
    ).toThrow(/proposed|pending/i);
    expect(() =>
      appendActionEvent(entry, event("approved", "target-1", 0)),
    ).toThrow(/order/i);
    expect(() =>
      appendActionEvent(entry, event("undo_succeeded", "target-1", 2)),
    ).toThrow(/undo/i);
    expect(() =>
      appendActionEvent(entry, event("retry_requested", "target-1", 2)),
    ).toThrow(/retry/i);
  });
});

describe("per-target ledger derivation", () => {
  it("keeps a partial apply separate from unresolved sibling work", () => {
    let entry = placedEntry(["target-1", "target-2"]);
    entry = append(entry, "approved", "target-1", 3);
    entry = append(entry, "apply_succeeded", "target-1", 4);

    const state = deriveActionLedgerState(entry);

    expect(state.targets["target-1"]).toMatchObject({
      approval: "approved",
      effect: "applied",
      unresolved: false,
    });
    expect(state.targets["target-2"]).toMatchObject({
      approval: "pending",
      effect: "none",
      unresolved: true,
    });
    expect(state.aggregate).toBe("partially_applied");
    expect(state.unresolvedTargetIds).toEqual(["target-2"]);
  });

  it("preserves apply, undo refusal, undo success, retry, and re-apply history", () => {
    let entry = placedEntry();
    entry = append(entry, "approved", "target-1", 2);
    entry = append(entry, "apply_succeeded", "target-1", 3);
    entry = append(entry, "undo_refused", "target-1", 4);

    expect(deriveActionLedgerState(entry).targets["target-1"]).toMatchObject({
      effect: "applied",
      lastUndoRefusal: "Drift guard refused undo.",
    });

    entry = append(entry, "undo_succeeded", "target-1", 5);
    expect(deriveActionLedgerState(entry).targets["target-1"]).toMatchObject({
      effect: "undone",
      retry: "eligible",
    });

    entry = append(entry, "retry_requested", "target-1", 6);
    expect(deriveActionLedgerState(entry).targets["target-1"].retry).toBe(
      "requested",
    );

    entry = append(entry, "apply_succeeded", "target-1", 7);
    expect(deriveActionLedgerState(entry).targets["target-1"]).toMatchObject({
      effect: "applied",
      retry: "none",
    });
    expect(entry.events.map((entry) => entry.type)).toEqual([
      "proposed",
      "approved",
      "apply_succeeded",
      "undo_refused",
      "undo_succeeded",
      "retry_requested",
      "apply_succeeded",
    ]);
  });

  it("keeps failed approval evidence and opens retry without rewriting it", () => {
    let entry = placedEntry();
    entry = append(entry, "approved", "target-1", 2);
    entry = append(entry, "apply_failed", "target-1", 3);

    expect(deriveActionLedgerState(entry).targets["target-1"]).toMatchObject({
      approval: "approved",
      effect: "failed",
      retry: "eligible",
      unresolved: true,
    });

    entry = append(entry, "retry_requested", "target-1", 4);
    expect(deriveActionLedgerState(entry).targets["target-1"].retry).toBe(
      "requested",
    );
  });
});

describe("action control eligibility and supersession", () => {
  const activeHead = {
    activeRevisionId: "revision-1",
    isActiveConversationHead: true,
    visibleRevisionReferencesAction: true,
    driftGuardAllowsUndo: true,
  };

  it("gates approval, apply, and retry by active head but keeps historical Undo", () => {
    const proposed = placedEntry();
    expect(
      deriveActionControlEligibility(proposed, "target-1", activeHead),
    ).toEqual({
      canApprove: true,
      canApply: false,
      canRetry: false,
      canUndo: false,
    });
    expect(
      deriveActionControlEligibility(proposed, "target-1", {
        ...activeHead,
        activeRevisionId: "revision-2",
      }).canApprove,
    ).toBe(false);

    let approved = append(proposed, "approved", "target-1", 2);
    expect(
      deriveActionControlEligibility(approved, "target-1", activeHead).canApply,
    ).toBe(true);

    approved = append(approved, "apply_succeeded", "target-1", 3);
    expect(
      deriveActionControlEligibility(approved, "target-1", {
        ...activeHead,
        activeRevisionId: "revision-2",
        isActiveConversationHead: false,
      }),
    ).toEqual({
      canApprove: false,
      canApply: false,
      canRetry: false,
      canUndo: true,
    });
    expect(
      deriveActionControlEligibility(approved, "target-1", {
        ...activeHead,
        visibleRevisionReferencesAction: false,
      }).canUndo,
    ).toBe(false);
  });

  it("supersedes only unresolved targets and preserves applied evidence", () => {
    let entry = placedEntry(["target-1", "target-2"]);
    entry = append(entry, "approved", "target-1", 3);
    entry = append(entry, "apply_succeeded", "target-1", 4);

    const result = supersedeUnresolvedActions(
      [entry],
      "revision-1",
      "revision-2",
      (actionRef, targetId, index) => ({
        eventId: `supersede-${actionRef}-${targetId}`,
        createdAt: 10 + index,
      }),
    );
    const next = result[0];

    expect(entry.events).toHaveLength(4);
    expect(next.events.filter((entry) => entry.type === "superseded")).toEqual([
      {
        eventId: "supersede-action-1-target-2",
        type: "superseded",
        targetId: "target-2",
        createdAt: 10,
        replacementRevisionId: "revision-2",
      },
    ]);
    expect(deriveActionLedgerState(next).targets["target-1"].effect).toBe(
      "applied",
    );
    expect(deriveActionLedgerState(next).targets["target-2"]).toMatchObject({
      approval: "superseded",
      unresolved: false,
    });
  });
});

describe("provisional and unplaced actions", () => {
  it("attaches a declaration without changing action identity, payload, or events", () => {
    const provisional = createProvisionalAction({
      actionRef: "action-provisional",
      revisionId: "revision-1",
      family: "memory",
      correlation: { kind: "provider_id", toolCallId: "tool-call-1" },
      payload: memoryPayload(),
      proposedEvents: [event("proposed")],
    });

    const placed = attachProvisionalAction(provisional, "tool-item-1");

    expect(placed).toMatchObject({
      actionRef: provisional.actionRef,
      revisionId: provisional.revisionId,
      placement: {
        state: "placed",
        anchor: "tool_call",
        itemId: "tool-item-1",
        correlation: provisional.placement.state === "provisional"
          ? provisional.placement.correlation
          : undefined,
      },
      payload: provisional.payload,
      events: provisional.events,
    });
    expect(provisional.placement.state).toBe("provisional");
  });

  it("discards proposed-only undeclared work and freezes every other event as unplaced", () => {
    const provisional = createProvisionalAction({
      actionRef: "action-provisional",
      revisionId: "revision-1",
      family: "memory",
      correlation: { kind: "provider_id", toolCallId: "tool-call-1" },
      payload: memoryPayload(),
      proposedEvents: [event("proposed")],
    });

    expect(finalizeUndeclaredAction(provisional)).toBeNull();

    const declined = append(
      provisional,
      "declined",
      "target-1",
      2,
    );
    const frozen = finalizeUndeclaredAction(declined);

    expect(frozen?.placement).toEqual({
      state: "unplaced",
      correlation: { kind: "provider_id", toolCallId: "tool-call-1" },
      reason: "declaration_missing",
    });
    expect(frozen).not.toHaveProperty("placement.itemId");
    expect(isConsequentialActionEvent(event("proposed"))).toBe(false);
    expect(
      [
        "approved",
        "declined",
        "apply_succeeded",
        "apply_failed",
        "undo_succeeded",
        "undo_refused",
        "retry_requested",
        "superseded",
      ].every((type, index) =>
        isConsequentialActionEvent(
          event(type as ToolActionEvent["type"], "target-1", index + 2),
        ),
      ),
    ).toBe(true);
  });
});
