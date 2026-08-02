/**
 * Derive an {@link ApprovalRequest} from what each channel already holds (RFC-0012).
 *
 * `summary` and `detail` are *derived, never authored*: the vault channel reuses the
 * same {@link summarizeOp} / {@link opDetailLine} helpers the review panel renders, and
 * the edit and memory channels reuse the vocabulary their disposition builders already
 * speak. So the drawer can never name a change in words the timeline does not.
 *
 * The drawer is not a review surface: no diffs, no hunk navigation, no op detail beyond
 * these two lines.
 */

import type { ResolvedEdit } from "../../editing/editTypes";
import type { MemoryMutation } from "../../tools/memory/handlers";
import type { EditOpKind } from "../../vault-ops/disposition";
import { opDetailLine, summarizeOp } from "../../vault-ops/summary";
import type { VaultOperation } from "../../vault-ops/types";
import type { ApprovalRequest } from "./approvalTypes";

export function vaultOpApprovalRequest(input: {
  approvalId: string;
  toolCallId: string;
  op: VaultOperation;
}): ApprovalRequest {
  return {
    approvalId: input.approvalId,
    channel: "vault-op",
    toolCallId: input.toolCallId,
    summary: summarizeOp(input.op),
    detail: opDetailLine(input.op),
  };
}

/** Present-tense label per edit tool, matching `editDispositionMessage`'s vocabulary. */
function editVerb(kind: EditOpKind): string {
  switch (kind) {
    case "frontmatter":
      return "Frontmatter update";
    case "insert":
      return "Insert into";
    case "edit":
      return "Edit";
  }
}

export function editApprovalRequest(input: {
  approvalId: string;
  toolCallId: string;
  kind: EditOpKind;
  filePath: string;
  resolvedEdit: ResolvedEdit;
}): ApprovalRequest {
  return {
    approvalId: input.approvalId,
    channel: "edit",
    toolCallId: input.toolCallId,
    summary: `${editVerb(input.kind)} ${input.filePath}`,
    detail: `Line ${input.resolvedEdit.startLine}`,
  };
}

export function memoryApprovalRequest(input: {
  approvalId: string;
  toolCallId: string;
  mutation: MemoryMutation;
}): ApprovalRequest {
  const mutation = input.mutation;
  const name = mutation.kind === "add" ? mutation.memory.name : mutation.name;
  return {
    approvalId: input.approvalId,
    channel: "memory",
    toolCallId: input.toolCallId,
    summary: `${mutation.kind === "add" ? "Remember" : "Forget"} "${name}"`,
    // The model's own reason, which is the one thing the reviewer cannot read off the
    // record itself: a memory's name and description say what it is, never why it earns
    // a place. Derived like every other line here, never authored.
    ...(mutation.explanation ? { detail: mutation.explanation } : {}),
  };
}
