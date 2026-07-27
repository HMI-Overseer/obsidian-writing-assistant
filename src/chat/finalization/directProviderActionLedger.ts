import type {
  AppliedEditRecord,
  EditProposal,
} from "../../editing/editTypes";
import type {
  AssistantToolCallItem,
  AssistantTurnRecord,
  GenerationAuditIntent,
  ToolActionEvent,
  ToolActionLedgerEntry,
  ToolActionPlacement,
} from "../../shared/types";
import type { ReviewableMemoryProposal } from "../messages/memoryReviewTimeline";
import type {
  AppliedVaultOpRecord,
  VaultOperationProposal,
} from "../../vault-ops/types";
import {
  appendActionEvent,
  createProvisionalAction,
  createPlacedParsedEditAction,
  createPlacedToolAction,
  deriveActionLedgerState,
  finalizeUndeclaredAction,
} from "../conversation/actionLedger";
import { validateAskRequest } from "../../tools/ask/validation";

export interface DirectProviderActionLedgerInput {
  revisionId: string;
  turn: AssistantTurnRecord;
  toolCorrelations: Record<string, "provider_id" | "plugin_id">;
  actionRefsByToolCallId?: Record<string, string>;
  editProposals?: EditProposal[];
  appliedEditRecords?: AppliedEditRecord[];
  vaultOpProposal?: VaultOperationProposal;
  appliedVaultOpRecord?: AppliedVaultOpRecord;
  memoryProposals?: ReviewableMemoryProposal[];
  parsedEditPlacement?: { itemId: string; actionRef: string };
  /**
   * This generation's durable write-ahead intents, with their outcomes already
   * settled (ADR-0033). Each one folds into the entry that shares its
   * action reference, behind the proposal and ahead of whatever the review
   * decided, because `intent_recorded` is only valid before an effect.
   */
  intents?: readonly GenerationAuditIntent[];
  createEventId: () => string;
  createdAt: number;
}

interface LedgerContext {
  input: DirectProviderActionLedgerInput;
  itemByToolCallId: Map<string, AssistantToolCallItem>;
}

/** Convert direct-provider review state into the message-local append-only ledger. */
export function buildDirectProviderActionLedger(
  input: DirectProviderActionLedgerInput,
): ToolActionLedgerEntry[] {
  const context: LedgerContext = {
    input,
    itemByToolCallId: new Map(
      input.turn.items
        .filter(
          (item): item is AssistantToolCallItem =>
            item.type === "tool_call",
        )
        .map((item) => [item.toolCallId, item]),
    ),
  };
  const entries = [
    ...buildEditEntries(context),
    ...buildVaultOpEntries(context),
    ...buildMemoryEntries(context),
    ...buildInteractionEntries(context),
  ];
  return entries.flatMap((built) => {
    const entry = appendUnknownOutcomes(context, built);
    if (entry.placement.state !== "provisional") return [entry];
    const finalized = finalizeUndeclaredAction(entry);
    return finalized ? [finalized] : [];
  });
}

/**
 * The intents that could not be folded into any entry.
 *
 * These cannot be persisted as unplaced `outcome_unknown` ledger events against
 * the current tree: an entry needs a family
 * payload, and every one of those requires evidence an intent deliberately does
 * not carry. The caller records them as bounded turn diagnostics instead. A
 * reconciled intent with no entry needs no record at all: its review refused
 * before registering anything, so nothing happened.
 */
export function unmatchedAuditIntents(
  entries: readonly ToolActionLedgerEntry[],
  intents: readonly GenerationAuditIntent[],
): GenerationAuditIntent[] {
  const folded = new Set(entries.map((entry) => entry.actionRef));
  return intents.filter(
    (intent) => intent.outcome === "unknown" && !folded.has(intent.actionRef),
  );
}

/**
 * Drops an item's action reference when the ledger has no placed entry for it.
 *
 * The loop stamps `actionRef` on an action tool the moment it starts running, but
 * the entry it points at only exists once the review registered a proposal. A
 * review that refused before registering anything, an unconvertible path for
 * instance, therefore left an item pointing at nothing, and
 * `validateAssistantMessageState()` refuses that whole revision on load
 * (`action_reference_invalid`), so the entire turn degraded to a legacy snapshot.
 * A stranded write-ahead intent exposes exactly that invalid reference
 * (ADR-0033).
 *
 * A dangling reference is a broken link rather than evidence: the tool row, its
 * failed state, and its error text all stay, and the audit keeps its own record.
 */
export function pruneDanglingActionRefs(
  turn: AssistantTurnRecord,
  ledger: readonly ToolActionLedgerEntry[],
): AssistantTurnRecord {
  const placed = new Set(
    ledger
      .filter((entry) => entry.placement.state === "placed")
      .map((entry) => entry.actionRef),
  );
  const dangling = turn.items.some(
    (item) => item.actionRef !== undefined && !placed.has(item.actionRef),
  );
  if (!dangling) return turn;
  return {
    ...turn,
    items: turn.items.map((item) => {
      if (item.actionRef === undefined || placed.has(item.actionRef)) return item;
      const pruned = { ...item };
      delete pruned.actionRef;
      // A prose anchor exists only to point at an action, so it goes with it.
      if (pruned.type === "prose") delete pruned.actionAnchor;
      return pruned;
    }),
  };
}

/** Every intent that belongs to one entry, matched on its action reference. */
function intentsFor(
  context: LedgerContext,
  actionRef: string,
): readonly GenerationAuditIntent[] {
  return (context.input.intents ?? []).filter(
    (intent) => intent.actionRef === actionRef,
  );
}

/**
 * Folds `intent_recorded` in behind the proposal, for every target of the call the
 * intent covered.
 *
 * An intent is per tool call, not per ledger target: the effect boundary is
 * crossed before the review exists, so the target IDs the review will mint are
 * not knowable yet. Every target of the matched entry therefore inherits the
 * intent, which is exactly what it covered.
 */
function appendRecordedIntents(
  context: LedgerContext,
  entry: ToolActionLedgerEntry,
): ToolActionLedgerEntry {
  let next = entry;
  for (const intent of intentsFor(context, entry.actionRef)) {
    for (const target of entry.payload.targets) {
      next = append(context, next, {
        type: "intent_recorded",
        targetId: target.targetId,
        intentId: intent.intentId,
        createdAt: intent.recordedAt,
      });
    }
  }
  return next;
}

/**
 * Closes an unresolved intent once every real outcome is in place.
 *
 * Only a target the review never resolved becomes `outcome_unknown`. When the
 * ledger holds a real outcome, that outcome is the better evidence and the audit's
 * last known state does not overwrite it.
 */
function appendUnknownOutcomes(
  context: LedgerContext,
  entry: ToolActionLedgerEntry,
): ToolActionLedgerEntry {
  let next = entry;
  const state = deriveActionLedgerState(entry).targets;
  for (const intent of intentsFor(context, entry.actionRef)) {
    if (intent.outcome !== "unknown") continue;
    for (const target of entry.payload.targets) {
      const derived = state[target.targetId];
      if (
        !derived ||
        derived.approval !== "pending" ||
        derived.effect !== "none" ||
        derived.superseded ||
        derived.outcomeUnknown ||
        derived.writeAheadIntentId !== intent.intentId
      ) {
        continue;
      }
      next = append(context, next, {
        type: "outcome_unknown",
        targetId: target.targetId,
        intentId: intent.intentId,
        reason: "the owning generation ended with this outcome unknown",
      });
    }
  }
  return next;
}

function buildEditEntries(context: LedgerContext): ToolActionLedgerEntry[] {
  const entries: ToolActionLedgerEntry[] = [];
  for (const proposal of context.input.editProposals ?? []) {
    const byToolCallId = new Map<string, typeof proposal.hunks>();
    for (const hunk of proposal.hunks) {
      const toolCallId = hunk.resolvedEdit.editBlock.id;
      const group = byToolCallId.get(toolCallId);
      if (group) group.push(hunk);
      else byToolCallId.set(toolCallId, [hunk]);
    }
    const appliedRecord = context.input.appliedEditRecords?.find(
      (record) => record.proposalId === proposal.id,
    );
    for (const [toolCallId, hunks] of byToolCallId) {
      if (!context.itemByToolCallId.has(toolCallId)) {
        if (context.input.parsedEditPlacement) continue;
      }
      let entry = createToolEntry(context, toolCallId, "edit", {
        proposalId: proposal.id,
        targets: hunks.map((hunk) => ({
          targetId: hunk.id,
          targetFilePath: proposal.targetFilePath,
          documentSnapshot: proposal.documentSnapshot,
          snapshotTimestamp: proposal.snapshotTimestamp,
          resolvedEdit: structuredClone(hunk.resolvedEdit),
        })),
      }, hunks.map((hunk) => ({
        targetId: hunk.id,
        createdAt: proposal.snapshotTimestamp,
      })));
      entry = appendEditOutcomes(
        context,
        entry,
        hunks,
        appliedRecord,
      );
      entries.push(entry);
    }
    const parsedHunks = proposal.hunks.filter(
      (hunk) =>
        !context.itemByToolCallId.has(hunk.resolvedEdit.editBlock.id),
    );
    const parsedPlacement = context.input.parsedEditPlacement;
    if (parsedHunks.length > 0 && parsedPlacement) {
      let entry = appendRecordedIntents(
        context,
        createPlacedParsedEditAction({
          actionRef: parsedPlacement.actionRef,
          revisionId: context.input.revisionId,
          itemId: parsedPlacement.itemId,
          payload: {
            proposalId: proposal.id,
            targets: parsedHunks.map((hunk) => ({
              targetId: hunk.id,
              targetFilePath: proposal.targetFilePath,
              documentSnapshot: proposal.documentSnapshot,
              snapshotTimestamp: proposal.snapshotTimestamp,
              resolvedEdit: structuredClone(hunk.resolvedEdit),
            })),
          },
          proposedEvents: parsedHunks.map((hunk) => ({
            eventId: context.input.createEventId(),
            type: "proposed",
            targetId: hunk.id,
            createdAt: proposal.snapshotTimestamp,
          })),
        }),
      );
      entry = appendEditOutcomes(
        context,
        entry,
        parsedHunks,
        appliedRecord,
      );
      entries.push(entry);
    }
  }
  return entries;
}

function appendEditOutcomes(
  context: LedgerContext,
  initial: ToolActionLedgerEntry,
  hunks: EditProposal["hunks"],
  appliedRecord: AppliedEditRecord | undefined,
): ToolActionLedgerEntry {
  let entry = initial;
  for (const hunk of hunks) {
    if (hunk.status === "rejected") {
      entry = append(context, entry, {
        type: "declined",
        targetId: hunk.id,
        reason: "rejected",
      });
      continue;
    }
    const wasApplied =
      appliedRecord?.appliedHunkIds.includes(hunk.id) ?? false;
    if (hunk.status === "accepted") {
      entry = append(context, entry, {
        type: "approved",
        targetId: hunk.id,
      });
    }
    if (wasApplied && appliedRecord) {
      entry = append(context, entry, {
        type: "apply_succeeded",
        targetId: hunk.id,
        createdAt: appliedRecord.appliedAt,
        effect: {
          family: "edit",
          targetFilePath: appliedRecord.targetFilePath,
          preApplySnapshot: appliedRecord.preApplySnapshot,
          postApplySnapshot: appliedRecord.postApplySnapshot,
          appliedAt: appliedRecord.appliedAt,
        },
      });
    }
  }
  return entry;
}

function buildVaultOpEntries(
  context: LedgerContext,
): ToolActionLedgerEntry[] {
  const proposal = context.input.vaultOpProposal;
  if (!proposal) return [];
  const entries: ToolActionLedgerEntry[] = [];
  const byToolCallId = new Map<string, typeof proposal.ops>();
  for (const operation of proposal.ops) {
    if (!operation.sourceToolCallId) continue;
    const group = byToolCallId.get(operation.sourceToolCallId);
    if (group) group.push(operation);
    else byToolCallId.set(operation.sourceToolCallId, [operation]);
  }
  for (const [toolCallId, operations] of byToolCallId) {
    let entry = createToolEntry(context, toolCallId, "vault_op", {
      proposalId: proposal.id,
      createdAt: proposal.createdAt,
      targets: operations.map((operation) => ({
        targetId: operation.id,
        operation: structuredClone(operation.op),
        gate: operation.gate,
        summary: operation.summary,
        ...(operation.linkImpact === undefined
          ? {}
          : { linkImpact: operation.linkImpact }),
      })),
    }, operations.map((operation) => ({
      targetId: operation.id,
      createdAt: proposal.createdAt,
    })));
    for (const operation of operations) {
      if (operation.status === "accepted") {
        entry = append(context, entry, {
          type: "approved",
          targetId: operation.id,
        });
      } else if (
        operation.status === "rejected" ||
        operation.status === "satisfied"
      ) {
        entry = append(context, entry, {
          type: "declined",
          targetId: operation.id,
          reason:
            operation.status === "satisfied"
              ? "already satisfied"
              : "rejected",
        });
      } else if (operation.status === "failed") {
        if (operation.gate === "ask") {
          entry = append(context, entry, {
            type: "approved",
            targetId: operation.id,
          });
        }
        entry = append(context, entry, {
          type: "apply_failed",
          targetId: operation.id,
          error: "Vault operation failed.",
        });
      } else if (operation.status === "applied") {
        const applied = context.input.appliedVaultOpRecord?.applied.find(
          (record) => record.opId === operation.id,
        );
        if (operation.gate === "ask") {
          entry = append(context, entry, {
            type: "approved",
            targetId: operation.id,
          });
        }
        entry = append(context, entry, {
          type: "apply_succeeded",
          targetId: operation.id,
          createdAt:
            context.input.appliedVaultOpRecord?.appliedAt ??
            proposal.createdAt,
          effect: {
            family: "vault_op",
            operation: structuredClone(operation.op),
            inverse: applied ? structuredClone(applied.inverse) : null,
            appliedAt:
              context.input.appliedVaultOpRecord?.appliedAt ??
              proposal.createdAt,
          },
        });
      }
    }
    entries.push(entry);
  }
  return entries;
}

function buildMemoryEntries(
  context: LedgerContext,
): ToolActionLedgerEntry[] {
  return (context.input.memoryProposals ?? []).map((proposal) => {
    let entry = createToolEntry(context, proposal.sourceToolCallId, "memory", {
      targets: [{
        targetId: proposal.id,
        mutation:
          proposal.mutation.kind === "add"
            ? {
                kind: "add" as const,
                memory: structuredClone(proposal.mutation.memory),
              }
            : {
                kind: "forget" as const,
                name: proposal.mutation.name,
              },
      }],
    }, [{
      targetId: proposal.id,
      createdAt: context.input.createdAt,
    }]);
    if (proposal.status === "declined") {
      entry = append(context, entry, {
        type: "declined",
        targetId: proposal.id,
        reason: "rejected",
      });
    } else if (proposal.status === "failed") {
      entry = append(context, entry, {
        type: "apply_failed",
        targetId: proposal.id,
        error: proposal.error ?? "Memory mutation failed.",
      });
    } else if (proposal.status === "applied") {
      const effect = proposal.effect;
      entry = append(context, entry, {
        type: "apply_succeeded",
        targetId: proposal.id,
        effect: {
          family: "memory",
          before: effect ? structuredClone(effect.before) : null,
          after: effect
            ? structuredClone(effect.after)
            : proposal.mutation.kind === "add"
              ? structuredClone(proposal.mutation.memory)
              : null,
          appliedAt: effect?.appliedAt ?? context.input.createdAt,
        },
        createdAt: effect?.appliedAt,
      });
    }
    return entry;
  });
}

function buildInteractionEntries(
  context: LedgerContext,
): ToolActionLedgerEntry[] {
  const entries: ToolActionLedgerEntry[] = [];
  for (const item of context.itemByToolCallId.values()) {
    if (item.toolName !== "ask_user" || !item.actionRef) continue;
    if (!context.input.toolCorrelations[item.toolCallId]) continue;
    const request = validateAskRequest(item.toolArgs);
    if (!request.ok) continue;
    let entry = createToolEntry(context, item.toolCallId, "interaction", {
      kind: "ask_user",
      targets: request.value.questions.map((question, index) => ({
        targetId: `${item.toolCallId}-question-${index}`,
        question: question.question,
        header: question.header,
        options: question.options.map((option) => option.label),
        multiSelect: question.multiSelect,
      })),
    }, request.value.questions.map((_, index) => ({
      targetId: `${item.toolCallId}-question-${index}`,
      createdAt: context.input.createdAt,
    })));
    for (let index = 0; index < request.value.questions.length; index += 1) {
      const targetId = `${item.toolCallId}-question-${index}`;
      if (item.askStatus === "completed" && item.askGuidance) {
        entry = append(context, entry, {
          type: "apply_succeeded",
          targetId,
          effect: {
            family: "interaction",
            guidance: structuredClone(item.askGuidance),
            completedAt: context.input.createdAt,
          },
        });
      } else if (item.askStatus === "skipped") {
        entry = append(context, entry, {
          type: "declined",
          targetId,
          reason: "skipped",
        });
      } else if (item.askStatus === "cancelled" || item.isError) {
        entry = append(context, entry, {
          type: "apply_failed",
          targetId,
          error: item.errorContent ?? "Question interaction was cancelled.",
        });
      }
    }
    entries.push(entry);
  }
  return entries;
}

function createToolEntry(
  context: LedgerContext,
  toolCallId: string,
  family: ToolActionLedgerEntry["family"],
  payload: ToolActionLedgerEntry["payload"],
  proposed: Array<{ targetId: string; createdAt: number }>,
): ToolActionLedgerEntry {
  const item = context.itemByToolCallId.get(toolCallId);
  const actionRef =
    item?.actionRef ?? context.input.actionRefsByToolCallId?.[toolCallId];
  if (!actionRef) {
    throw new Error(
      `Review state for tool call "${toolCallId}" has no action reference.`,
    );
  }
  const correlation = context.input.toolCorrelations[toolCallId];
  if (!correlation) {
    throw new Error(
      `Review state for tool call "${toolCallId}" has no correlation evidence.`,
    );
  }
  const common = {
    actionRef,
    revisionId: context.input.revisionId,
    correlation: {
      kind: correlation,
      toolCallId,
    } satisfies Extract<
      ToolActionPlacement,
      { state: "placed"; anchor: "tool_call" }
    >["correlation"],
    proposedEvents: proposed.map(({ targetId, createdAt }) => ({
      eventId: context.input.createEventId(),
      type: "proposed" as const,
      targetId,
      createdAt,
    })),
  };
  switch (family) {
    case "edit":
      return createToolOrProvisionalAction(context, toolCallId, {
        ...common,
        family,
        payload: payload as Extract<
          ToolActionLedgerEntry,
          { family: "edit" }
        >["payload"],
      });
    case "vault_op":
      return createToolOrProvisionalAction(context, toolCallId, {
        ...common,
        family,
        payload: payload as Extract<
          ToolActionLedgerEntry,
          { family: "vault_op" }
        >["payload"],
      });
    case "memory":
      return createToolOrProvisionalAction(context, toolCallId, {
        ...common,
        family,
        payload: payload as Extract<
          ToolActionLedgerEntry,
          { family: "memory" }
        >["payload"],
      });
    case "interaction":
      return createToolOrProvisionalAction(context, toolCallId, {
        ...common,
        family,
        payload: payload as Extract<
          ToolActionLedgerEntry,
          { family: "interaction" }
        >["payload"],
      });
  }
}

function createToolOrProvisionalAction(
  context: LedgerContext,
  toolCallId: string,
  input: Parameters<typeof createProvisionalAction>[0],
): ToolActionLedgerEntry {
  const item = context.itemByToolCallId.get(toolCallId);
  return appendRecordedIntents(
    context,
    item
      ? createPlacedToolAction({ ...input, itemId: item.id })
      : createProvisionalAction(input),
  );
}

type EventWithoutIdentity =
  ToolActionEvent extends infer Event
    ? Event extends ToolActionEvent
      ? Omit<Event, "eventId" | "createdAt"> & { createdAt?: number }
      : never
    : never;

function append(
  context: LedgerContext,
  entry: ToolActionLedgerEntry,
  event: EventWithoutIdentity,
): ToolActionLedgerEntry {
  const previous = entry.events[entry.events.length - 1]?.createdAt ?? 0;
  const requested = event.createdAt ?? context.input.createdAt;
  const createdAt = Math.max(previous, requested, context.input.createdAt);
  return appendActionEvent(entry, {
    ...event,
    eventId: context.input.createEventId(),
    createdAt,
  });
}
