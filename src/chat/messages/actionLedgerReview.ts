import type { ToolActionLedgerEntry } from "../../shared/types";
import type { ActionControlEligibility } from "../conversation/actionLedger";

export type ActionReviewControl =
  | "approve"
  | "decline"
  | "apply"
  | "undo";

export interface ActionLedgerReviewBinding {
  actionRef: string;
  placement: ToolActionLedgerEntry["placement"]["state"];
  itemId?: string;
}

/**
 * One reviewable target, as the transcript offers it: what it is, and what the
 * reader can still do about it.
 *
 * Deliberately carries no lifecycle state and no failure text. A step's own
 * marker already shows whether its tool succeeded, and the model that made the
 * call reads the failure and speaks to it in prose. Repeating either as a word
 * beside the step was internal bookkeeping shown to the reader, and the exact
 * error stays one disclosure away on the step it belongs to.
 */
export interface ActionLedgerReviewTarget {
  targetId: string;
  label: string;
  controls: ActionReviewControl[];
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
    targets: entry.payload.targets.map((target) => ({
      targetId: target.targetId,
      label: targetLabel(entry, target.targetId),
      controls: controlsFor(getEligibility(target.targetId)),
    })),
  };
}

function controlsFor(
  eligibility: ActionControlEligibility,
): ActionReviewControl[] {
  const controls: ActionReviewControl[] = [];
  if (eligibility.canApprove) controls.push("approve");
  if (eligibility.canDecline) controls.push("decline");
  if (eligibility.canApply) controls.push("apply");
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
