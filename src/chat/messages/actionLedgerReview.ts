import type { ToolActionLedgerEntry } from "../../shared/types";
import {
  deriveActionLedgerState,
  type ActionControlEligibility,
  type ActionEffectState,
} from "../conversation/actionLedger";

export type ActionReviewControl =
  | "approve"
  | "decline"
  | "apply"
  | "retry"
  | "undo";

export type ActionReviewTargetState =
  | "pending"
  | "approved"
  | "declined"
  | "superseded"
  | ActionEffectState;

export interface ActionLedgerReviewBinding {
  actionRef: string;
  placement: ToolActionLedgerEntry["placement"]["state"];
  itemId?: string;
}

export interface ActionLedgerReviewTarget {
  targetId: string;
  label: string;
  state: ActionReviewTargetState;
  controls: ActionReviewControl[];
  error?: string;
  undoRefusal?: string;
}

export interface ActionLedgerReviewModel {
  family: ToolActionLedgerEntry["family"];
  binding: ActionLedgerReviewBinding;
  targets: ActionLedgerReviewTarget[];
}

/**
 * The original edit review renderer owns edit controls and hunk presentation.
 * Generic ledger summaries cover only the remaining action families.
 */
export function actionLedgerSummaryEntries(
  entries: readonly ToolActionLedgerEntry[],
): ToolActionLedgerEntry[] {
  return entries.filter((entry) => entry.family !== "edit");
}

export function buildActionLedgerReviewModel(
  entry: ToolActionLedgerEntry,
  getEligibility: (targetId: string) => ActionControlEligibility,
): ActionLedgerReviewModel {
  const derived = deriveActionLedgerState(entry);
  const placement = entry.placement;
  return {
    family: entry.family,
    binding: {
      actionRef: entry.actionRef,
      placement: placement.state,
      ...(placement.state === "placed"
        ? { itemId: placement.itemId }
        : {}),
    },
    targets: entry.payload.targets.map((target) => {
      const state = derived.targets[target.targetId];
      return {
        targetId: target.targetId,
        label: targetLabel(entry, target.targetId),
        state: visibleState(state.approval, state.effect),
        controls: controlsFor(getEligibility(target.targetId)),
        ...(state.lastApplyError === undefined
          ? {}
          : { error: state.lastApplyError }),
        ...(state.lastUndoRefusal === undefined
          ? {}
          : { undoRefusal: state.lastUndoRefusal }),
      };
    }),
  };
}

function visibleState(
  approval: ReturnType<typeof deriveActionLedgerState>["targets"][string]["approval"],
  effect: ActionEffectState,
): ActionReviewTargetState {
  if (effect !== "none") return effect;
  return approval === "unproposed" ? "pending" : approval;
}

function controlsFor(
  eligibility: ActionControlEligibility,
): ActionReviewControl[] {
  const controls: ActionReviewControl[] = [];
  if (eligibility.canApprove) controls.push("approve");
  if (eligibility.canDecline) controls.push("decline");
  if (eligibility.canApply) controls.push("apply");
  if (eligibility.canRetry) controls.push("retry");
  if (eligibility.canUndo) controls.push("undo");
  return controls;
}

function targetLabel(
  entry: ToolActionLedgerEntry,
  targetId: string,
): string {
  switch (entry.family) {
    case "edit":
      return (
        entry.payload.targets.find((target) => target.targetId === targetId)
          ?.targetFilePath ?? targetId
      );
    case "vault_op":
      return (
        entry.payload.targets.find((target) => target.targetId === targetId)
          ?.summary ?? targetId
      );
    case "memory": {
      const mutation = entry.payload.targets.find(
        (target) => target.targetId === targetId,
      )?.mutation;
      return mutation?.kind === "add"
        ? mutation.memory.name
        : mutation?.name ?? targetId;
    }
    case "interaction": {
      const target = entry.payload.targets.find(
        (candidate) => candidate.targetId === targetId,
      );
      return target
        ? `${target.header}: ${target.question}`
        : targetId;
    }
  }
}
