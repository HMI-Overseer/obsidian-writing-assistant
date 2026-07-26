import type {
  EditActionPayload,
  InteractionActionPayload,
  MemoryActionPayload,
  ToolActionCorrelationEvidence,
  ToolActionEffectRecord,
  ToolActionEvent,
  ToolActionFamily,
  ToolActionLedgerEntry,
  ToolActionPlacement,
  ToolActionUndoRecord,
  VaultOpActionPayload,
} from "../../shared/types";

const RETRY_FAMILIES: ReadonlySet<ToolActionFamily> = new Set([
  "edit",
  "vault_op",
  "memory",
]);
const UNDO_FAMILIES: ReadonlySet<ToolActionFamily> = new Set([
  "edit",
  "vault_op",
  "memory",
]);

interface ActionEntryCommon {
  actionRef: string;
  revisionId: string;
  proposedEvents: ToolActionEvent[];
}

type ActionEntryInput = ActionEntryCommon &
  (
    | { family: "edit"; payload: EditActionPayload }
    | { family: "vault_op"; payload: VaultOpActionPayload }
    | { family: "memory"; payload: MemoryActionPayload }
    | { family: "interaction"; payload: InteractionActionPayload }
  );

export type CreateProvisionalActionInput = ActionEntryInput & {
  correlation: Extract<
    ToolActionCorrelationEvidence,
    { kind: "provider_id" | "plugin_id" }
  >;
};

export type CreatePlacedToolActionInput = ActionEntryInput & {
  itemId: string;
  correlation: Extract<
    ToolActionCorrelationEvidence,
    { kind: "provider_id" | "plugin_id" }
  >;
};

export interface CreatePlacedParsedEditActionInput
  extends ActionEntryCommon {
  itemId: string;
  payload: EditActionPayload;
}

export type ActionApprovalState =
  | "unproposed"
  | "pending"
  | "approved"
  | "declined"
  | "superseded";
export type ActionEffectState =
  | "none"
  | "failed"
  | "applied"
  | "undone";
export type ActionRetryState =
  | "none"
  | "eligible"
  | "requested"
  | "superseded";

export interface DerivedActionTargetState {
  targetId: string;
  approval: ActionApprovalState;
  effect: ActionEffectState;
  retry: ActionRetryState;
  unresolved: boolean;
  superseded: boolean;
  latestEffect?: ToolActionEffectRecord;
  latestUndo?: ToolActionUndoRecord;
  lastApplyError?: string;
  lastUndoRefusal?: string;
}

export type ActionAggregateState =
  | "pending"
  | "partially_applied"
  | "applied"
  | "failed"
  | "undone"
  | "declined"
  | "superseded"
  | "mixed";

export interface DerivedActionLedgerState {
  targets: Record<string, DerivedActionTargetState>;
  aggregate: ActionAggregateState;
  unresolvedTargetIds: string[];
  appliedTargetIds: string[];
  undoneTargetIds: string[];
}

export interface ActionControlContext {
  activeRevisionId: string;
  isActiveConversationHead: boolean;
  visibleRevisionReferencesAction: boolean;
  driftGuardAllowsUndo: boolean;
}

export interface ActionControlEligibility {
  canApprove: boolean;
  canDecline: boolean;
  canApply: boolean;
  canRetry: boolean;
  canUndo: boolean;
}

export interface SupersessionEventIdentity {
  eventId: string;
  createdAt: number;
}

/** Create a review entry before its exact structured declaration is positioned. */
export function createProvisionalAction(
  input: CreateProvisionalActionInput,
): ToolActionLedgerEntry {
  return createEntry(input, {
    state: "provisional",
    correlation: input.correlation,
  });
}

/** Create a review entry anchored to one declared tool item. */
export function createPlacedToolAction(
  input: CreatePlacedToolActionInput,
): ToolActionLedgerEntry {
  requireNonEmpty(input.itemId, "itemId");
  return createEntry(input, {
    state: "placed",
    anchor: "tool_call",
    itemId: input.itemId,
    correlation: input.correlation,
  });
}

/** Create the structurally honest regex-edit action anchored to prose. */
export function createPlacedParsedEditAction(
  input: CreatePlacedParsedEditActionInput,
): ToolActionLedgerEntry {
  requireNonEmpty(input.itemId, "itemId");
  return createEntry(
    { ...input, family: "edit" },
    {
      state: "placed",
      anchor: "parsed_edit",
      itemId: input.itemId,
    },
  );
}

/**
 * Append one event without changing payload, placement, or prior events.
 *
 * Repeating an identical event ID is an idempotent no-op. Reusing the ID with
 * different evidence is invalid.
 */
export function appendActionEvent(
  entry: ToolActionLedgerEntry,
  event: ToolActionEvent,
): ToolActionLedgerEntry {
  const duplicate = entry.events.find(
    (existing) => existing.eventId === event.eventId,
  );
  if (duplicate) {
    if (valuesEqual(duplicate, event)) return entry;
    throw new Error(
      `Action event ID "${event.eventId}" was reused with different data.`,
    );
  }

  validateEventShape(entry, event);
  const last = entry.events[entry.events.length - 1];
  if (last && event.createdAt < last.createdAt) {
    throw new Error("Action event order must be non-decreasing by createdAt.");
  }
  const before = deriveActionLedgerState(entry).targets[event.targetId];
  validateTransition(entry, event, before);

  return immutable({
    ...structuredClone(entry),
    events: [...structuredClone(entry.events), structuredClone(event)],
  });
}

/** Fold the append-only event stream into per-target and aggregate state. */
export function deriveActionLedgerState(
  entry: ToolActionLedgerEntry,
): DerivedActionLedgerState {
  const targets: Record<string, DerivedActionTargetState> = {};
  for (const targetId of targetIdsOf(entry)) {
    targets[targetId] = initialTargetState(targetId);
  }
  for (const event of entry.events) {
    const target = targets[event.targetId];
    if (!target) continue;
    foldEvent(entry.family, target, event);
  }
  for (const target of Object.values(targets)) {
    target.unresolved = deriveUnresolved(entry.family, target);
  }

  const states = Object.values(targets);
  const unresolvedTargetIds = states
    .filter((target) => target.unresolved)
    .map((target) => target.targetId);
  const appliedTargetIds = states
    .filter((target) => target.effect === "applied")
    .map((target) => target.targetId);
  const undoneTargetIds = states
    .filter((target) => target.effect === "undone")
    .map((target) => target.targetId);

  return {
    targets,
    aggregate: deriveAggregate(states),
    unresolvedTargetIds,
    appliedTargetIds,
    undoneTargetIds,
  };
}

/**
 * Derive pending-work controls separately from historical Undo eligibility.
 */
export function deriveActionControlEligibility(
  entry: ToolActionLedgerEntry,
  targetId: string,
  context: ActionControlContext,
): ActionControlEligibility {
  const state = deriveActionLedgerState(entry).targets[targetId];
  if (!state) {
    return {
      canApprove: false,
      canDecline: false,
      canApply: false,
      canRetry: false,
      canUndo: false,
    };
  }
  const isPlaced = entry.placement.state === "placed";
  const ownsActiveHead =
    isPlaced &&
    entry.revisionId === context.activeRevisionId &&
    context.isActiveConversationHead;
  const canUndo =
    isPlaced &&
    context.visibleRevisionReferencesAction &&
    context.driftGuardAllowsUndo &&
    state.effect === "applied" &&
    UNDO_FAMILIES.has(entry.family) &&
    isEffectUndoable(state.latestEffect);

  return {
    canApprove:
      ownsActiveHead &&
      state.approval === "pending" &&
      state.effect === "none" &&
      !state.superseded,
    canDecline:
      ownsActiveHead &&
      (state.approval === "pending" ||
        state.approval === "approved") &&
      state.effect === "none" &&
      !state.superseded,
    canApply:
      ownsActiveHead &&
      entry.family !== "interaction" &&
      !state.superseded &&
      ((state.approval === "approved" && state.effect === "none") ||
        state.retry === "requested"),
    canRetry:
      ownsActiveHead &&
      !state.superseded &&
      RETRY_FAMILIES.has(entry.family) &&
      state.retry === "eligible",
    canUndo,
  };
}

/** Place one provisional action when its exact declaration item arrives. */
export function attachProvisionalAction(
  entry: ToolActionLedgerEntry,
  itemId: string,
): ToolActionLedgerEntry {
  requireNonEmpty(itemId, "itemId");
  if (entry.placement.state !== "provisional") {
    throw new Error("Only a provisional action can attach to a declaration.");
  }
  return immutable({
    ...structuredClone(entry),
    placement: {
      state: "placed",
      anchor: "tool_call",
      itemId,
      correlation: structuredClone(entry.placement.correlation),
    },
  });
}

/**
 * Drop inconsequential undeclared work or preserve it as explicit safety audit.
 */
export function finalizeUndeclaredAction(
  entry: ToolActionLedgerEntry,
): ToolActionLedgerEntry | null {
  if (entry.placement.state !== "provisional") {
    throw new Error("Only a provisional action can finish undeclared.");
  }
  if (!entry.events.some(isConsequentialActionEvent)) return null;
  return immutable({
    ...structuredClone(entry),
    placement: {
      state: "unplaced",
      correlation: structuredClone(entry.placement.correlation),
      reason: "declaration_missing",
    },
  });
}

/** ADR-0030's exact predicate, every event except proposed is consequential. */
export function isConsequentialActionEvent(
  event: ToolActionEvent,
): boolean {
  return event.type !== "proposed";
}

/**
 * Append supersession only to unresolved targets owned by the replaced revision.
 */
export function supersedeUnresolvedActions(
  entries: ToolActionLedgerEntry[],
  replacedRevisionId: string,
  replacementRevisionId: string,
  identity: (
    actionRef: string,
    targetId: string,
    index: number,
  ) => SupersessionEventIdentity,
): ToolActionLedgerEntry[] {
  requireNonEmpty(replacementRevisionId, "replacementRevisionId");
  let eventIndex = 0;
  return entries.map((entry) => {
    if (entry.revisionId !== replacedRevisionId) return entry;
    let next = entry;
    const unresolved = deriveActionLedgerState(entry).unresolvedTargetIds;
    for (const targetId of unresolved) {
      const eventIdentity = identity(entry.actionRef, targetId, eventIndex);
      eventIndex += 1;
      next = appendActionEvent(next, {
        eventId: eventIdentity.eventId,
        type: "superseded",
        targetId,
        createdAt: eventIdentity.createdAt,
        replacementRevisionId,
      });
    }
    return next;
  });
}

function createEntry(
  input: ActionEntryInput,
  placement: ToolActionPlacement,
): ToolActionLedgerEntry {
  requireNonEmpty(input.actionRef, "actionRef");
  requireNonEmpty(input.revisionId, "revisionId");
  validateUniqueTargets(input);

  let entry = immutable({
    actionRef: input.actionRef,
    revisionId: input.revisionId,
    family: input.family,
    placement: structuredClone(placement),
    payload: structuredClone(input.payload),
    events: [],
  } as ToolActionLedgerEntry);
  for (const proposed of input.proposedEvents) {
    if (proposed.type !== "proposed") {
      throw new Error("Initial action events must be proposed events.");
    }
    entry = appendActionEvent(entry, proposed);
  }
  return entry;
}

function validateUniqueTargets(input: ActionEntryInput): void {
  const seen = new Set<string>();
  for (const targetId of targetIdsOfInput(input)) {
    requireNonEmpty(targetId, "targetId");
    if (seen.has(targetId)) {
      throw new Error(`Duplicate action target ID "${targetId}".`);
    }
    seen.add(targetId);
  }
}

function targetIdsOfInput(input: ActionEntryInput): string[] {
  return input.payload.targets.map((target) => target.targetId);
}

function targetIdsOf(entry: ToolActionLedgerEntry): string[] {
  return entry.payload.targets.map((target) => target.targetId);
}

function validateEventShape(
  entry: ToolActionLedgerEntry,
  event: ToolActionEvent,
): void {
  requireNonEmpty(event.eventId, "eventId");
  requireNonEmpty(event.targetId, "targetId");
  if (!Number.isSafeInteger(event.createdAt) || event.createdAt < 0) {
    throw new Error("Action event createdAt must be a non-negative safe integer.");
  }
  if (!targetIdsOf(entry).includes(event.targetId)) {
    throw new Error(
      `Action event target "${event.targetId}" is not in the proposal payload.`,
    );
  }
  if (
    event.type === "apply_succeeded" &&
    event.effect.family !== entry.family
  ) {
    throw new Error("Apply effect family must match its action entry.");
  }
  if (
    event.type === "undo_succeeded" &&
    event.undo.family !== entry.family
  ) {
    throw new Error("Undo record family must match its action entry.");
  }
  if (
    event.type === "undo_succeeded" &&
    entry.family === "interaction"
  ) {
    throw new Error("Interaction actions do not support Undo.");
  }
}

function validateTransition(
  entry: ToolActionLedgerEntry,
  event: ToolActionEvent,
  state: DerivedActionTargetState,
): void {
  if (event.type === "proposed") {
    if (
      entry.events.some(
        (existing) => existing.targetId === event.targetId,
      )
    ) {
      throw new Error("A target can be proposed only once.");
    }
    return;
  }
  if (event.type === "approved") {
    if (
      state.approval !== "pending" ||
      state.effect !== "none" ||
      state.superseded
    ) {
      throw new Error("Approval is allowed only for pending work.");
    }
    return;
  }
  if (event.type === "declined") {
    if (
      (state.approval !== "pending" &&
        state.approval !== "approved") ||
      state.effect !== "none" ||
      state.superseded
    ) {
      throw new Error("Decline is allowed only before an effect is applied.");
    }
    return;
  }
  if (event.type === "apply_succeeded" || event.type === "apply_failed") {
    const isInitialAttempt =
      state.effect === "none" &&
      (state.approval === "pending" || state.approval === "approved");
    const isRetry = state.retry === "requested";
    if ((!isInitialAttempt && !isRetry) || state.superseded) {
      throw new Error("Apply outcome is not allowed in the current target state.");
    }
    return;
  }
  if (
    event.type === "undo_succeeded" ||
    event.type === "undo_refused"
  ) {
    if (state.effect !== "applied") {
      throw new Error("Undo is allowed only for an applied effect.");
    }
    return;
  }
  if (event.type === "retry_requested") {
    if (
      !RETRY_FAMILIES.has(entry.family) ||
      state.retry !== "eligible" ||
      state.superseded
    ) {
      throw new Error("Retry is allowed only after a failed or undone effect.");
    }
    return;
  }
  if (event.type === "superseded" && !state.unresolved) {
    throw new Error("Supersession is allowed only for unresolved work.");
  }
}

function initialTargetState(targetId: string): DerivedActionTargetState {
  return {
    targetId,
    approval: "unproposed",
    effect: "none",
    retry: "none",
    unresolved: false,
    superseded: false,
  };
}

function foldEvent(
  family: ToolActionFamily,
  target: DerivedActionTargetState,
  event: ToolActionEvent,
): void {
  switch (event.type) {
    case "proposed":
      target.approval = "pending";
      return;
    case "approved":
      target.approval = "approved";
      return;
    case "declined":
      target.approval = "declined";
      target.retry = "none";
      return;
    case "apply_succeeded":
      target.effect = "applied";
      target.latestEffect = event.effect;
      target.retry = "none";
      target.lastApplyError = undefined;
      target.latestUndo = undefined;
      return;
    case "apply_failed":
      target.effect = "failed";
      target.lastApplyError = event.error;
      target.retry = RETRY_FAMILIES.has(family) ? "eligible" : "none";
      return;
    case "undo_succeeded":
      target.effect = "undone";
      target.latestUndo = event.undo;
      target.retry = RETRY_FAMILIES.has(family) ? "eligible" : "none";
      target.lastUndoRefusal = undefined;
      return;
    case "undo_refused":
      target.lastUndoRefusal = event.reason;
      return;
    case "retry_requested":
      target.retry = "requested";
      return;
    case "superseded":
      target.superseded = true;
      target.approval = "superseded";
      target.retry = "superseded";
  }
}

function deriveUnresolved(
  family: ToolActionFamily,
  target: DerivedActionTargetState,
): boolean {
  if (
    target.superseded ||
    target.approval === "declined" ||
    target.effect === "applied"
  ) {
    return false;
  }
  if (target.effect === "none") {
    return (
      target.approval === "pending" ||
      target.approval === "approved"
    );
  }
  return (
    RETRY_FAMILIES.has(family) &&
    (target.effect === "failed" ||
      target.effect === "undone" ||
      target.retry === "requested")
  );
}

function deriveAggregate(
  targets: DerivedActionTargetState[],
): ActionAggregateState {
  if (targets.length === 0) return "pending";
  const applied = targets.filter((target) => target.effect === "applied");
  const unresolved = targets.filter((target) => target.unresolved);
  if (applied.length > 0 && unresolved.length > 0) {
    return "partially_applied";
  }
  if (applied.length === targets.length) return "applied";
  if (targets.every((target) => target.superseded)) return "superseded";
  if (targets.every((target) => target.approval === "declined")) {
    return "declined";
  }
  if (targets.some((target) => target.effect === "failed")) return "failed";
  if (targets.some((target) => target.effect === "undone")) return "undone";
  if (unresolved.length > 0) return "pending";
  return "mixed";
}

function isEffectUndoable(
  effect: ToolActionEffectRecord | undefined,
): boolean {
  if (!effect) return false;
  return effect.family !== "vault_op" || effect.inverse !== null;
}

function requireNonEmpty(value: string, field: string): void {
  if (value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string.`);
  }
}

function valuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (
    typeof left !== "object" ||
    left === null ||
    typeof right !== "object" ||
    right === null
  ) {
    return false;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    if (
      !Array.isArray(left) ||
      !Array.isArray(right) ||
      left.length !== right.length
    ) {
      return false;
    }
    return left.every((entry, index) => valuesEqual(entry, right[index]));
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) =>
        key === rightKeys[index] &&
        valuesEqual(leftRecord[key], rightRecord[key]),
    )
  );
}

function immutable<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const nested of Object.values(value as Record<string, unknown>)) {
    immutable(nested);
  }
  return Object.freeze(value);
}
