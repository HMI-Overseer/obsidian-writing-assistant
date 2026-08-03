import type { ToolActionLedgerEntry } from "../../shared/types";
import type { EditStatus, ResolvedEdit } from "../../editing/editTypes";
import {
  deriveActionLedgerState,
  type DerivedActionTargetState,
} from "../conversation/actionLedger";

/**
 * What a finished action still shows about the change it made.
 *
 * The live review renders a diff under every mutating step, and that diff is the most
 * valuable thing on the timeline: it is the only place the reader ever sees *what*
 * changed. It used to end with the generation, because the live views own DOM the loop
 * tears down at finalization, and the durable renderer offered controls only.
 *
 * The action ledger already carries every fact those diffs were built from: an edit's
 * {@link ResolvedEdit}, a write's operation and its recorded inverse, a replace's
 * per-file targets, a memory's record. This projects that payload back into the same
 * evidence the live views rendered, so the diff survives the turn, a reload, and a
 * conversation switch. Pure: no Obsidian, no disk, so the projection is unit-testable
 * and the view stays a renderer.
 */

interface ActionEvidenceBase {
  targetId: string;
  /** Card tint: the change is in the vault, was declined, or is neither yet. */
  status: EditStatus;
}

export type ActionEvidence =
  | (ActionEvidenceBase & {
      kind: "edit_diff";
      resolvedEdit: ResolvedEdit;
      filePath: string;
    })
  | (ActionEvidenceBase & {
      kind: "write_diff";
      path: string;
      /** The content the operation writes. */
      content: string;
      /** The pre-write content, or null for a create (an all-add preview). */
      before: string | null;
      /**
       * Whether `before` is recorded fact. A create has none to record and an applied
       * overwrite keeps its old content in the undo inverse (ADR-0005), so both are
       * exact. An overwrite that never applied recorded nothing, and the file on disk
       * still holds what it would have replaced, so the renderer reads it there.
       */
      beforeIsRecorded: boolean;
    })
  | (ActionEvidenceBase & {
      kind: "replace_files";
      files: Array<{ path: string; count?: number }>;
    })
  | (ActionEvidenceBase & {
      kind: "memory_record";
      description: string;
      content?: string;
    });

/** Project one ledger entry's payload into the evidence its steps should show. */
export function buildActionEvidence(
  entry: ToolActionLedgerEntry,
): ActionEvidence[] {
  const derived = deriveActionLedgerState(entry).targets;
  switch (entry.family) {
    case "edit":
      return entry.payload.targets.map((target) => ({
        kind: "edit_diff",
        targetId: target.targetId,
        status: evidenceStatus(derived[target.targetId]),
        resolvedEdit: structuredClone(target.resolvedEdit),
        filePath: target.targetFilePath,
      }));
    case "vault_op":
      return entry.payload.targets.flatMap((target) =>
        vaultOpEvidence(
          target.targetId,
          target.operation,
          derived[target.targetId],
        ),
      );
    case "memory":
      return entry.payload.targets.flatMap((target) =>
        target.mutation.kind === "add"
          ? [
              {
                kind: "memory_record" as const,
                targetId: target.targetId,
                status: evidenceStatus(derived[target.targetId]),
                description: target.mutation.memory.description,
                ...(target.mutation.memory.content === undefined
                  ? {}
                  : { content: target.mutation.memory.content }),
              },
            ]
          : [],
      );
    // A question and its answers are already written out on the step itself.
    case "interaction":
      return [];
  }
}

/**
 * A vault operation's evidence is whatever the path in the step detail cannot say.
 *
 * A write is its content, a vault-wide replace is the list of notes it rewrites. A
 * move, trash, or folder operation is fully described by the paths already on the
 * step, so it contributes nothing rather than an empty card.
 */
function vaultOpEvidence(
  targetId: string,
  operation: Extract<
    ToolActionLedgerEntry,
    { family: "vault_op" }
  >["payload"]["targets"][number]["operation"],
  target: DerivedActionTargetState | undefined,
): ActionEvidence[] {
  const status = evidenceStatus(target);
  if (operation.kind === "create") {
    return [
      {
        kind: "write_diff",
        targetId,
        status,
        path: operation.path,
        content: operation.content,
        before: null,
        beforeIsRecorded: true,
      },
    ];
  }
  if (operation.kind === "overwrite") {
    const recorded = recordedOverwriteBefore(target);
    return [
      {
        kind: "write_diff",
        targetId,
        status,
        path: operation.path,
        content: operation.content,
        before: recorded,
        beforeIsRecorded: recorded !== null,
      },
    ];
  }
  if (operation.kind === "replaceInVault") {
    return [
      {
        kind: "replace_files",
        targetId,
        status,
        files: operation.targets.map((file) => ({
          path: file.path,
          ...(file.count === undefined ? {} : { count: file.count }),
        })),
      },
    ];
  }
  return [];
}

/**
 * The pre-apply content of an applied overwrite, from its undo record: the inverse of
 * an `overwrite` is itself an `overwrite` carrying the old content (ADR-0005). Null
 * when the operation never applied, or when its effect was already undone (the file
 * holds that content again, so disk is once more the honest source).
 */
function recordedOverwriteBefore(
  target: DerivedActionTargetState | undefined,
): string | null {
  const effect = target?.latestEffect;
  if (
    target?.effect !== "applied" ||
    effect?.family !== "vault_op" ||
    effect.inverse?.kind !== "overwrite"
  ) {
    return null;
  }
  return effect.inverse.content;
}

/**
 * How the card reads. Only two things are worth tinting: the change is in the vault,
 * or the reader turned it down. Everything else, still pending, failed, undone, is a
 * proposal that is not in the file, which is what `pending` already means to the card.
 * The step row beside it carries the exact lifecycle state.
 */
function evidenceStatus(
  target: DerivedActionTargetState | undefined,
): EditStatus {
  if (target?.effect === "applied") return "accepted";
  if (target?.approval === "declined") return "rejected";
  return "pending";
}
