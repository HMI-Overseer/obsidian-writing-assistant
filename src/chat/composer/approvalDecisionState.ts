import type { ApprovalDecision } from "../interactions/approvalTypes";

/**
 * Bounds on the drawer's own guidance field (RFC-0010): a write-time clamp on text
 * *we* collect, never a counted cap on anything the model does. Deliberately its own
 * constant rather than a reach into `ASK_USER_LIMITS`: that one is part of the
 * `ask_user` tool contract and is validated as such, while this one bounds a plain
 * input with no tool contract behind it. Sharing the number would couple two things
 * that only happen to agree.
 */
export const APPROVAL_LIMITS = {
  guidance: 500,
} as const;

export type ApprovalChoice = ApprovalDecision["kind"];

export interface ApprovalDecisionState {
  choice: ApprovalChoice;
  /**
   * The Other draft. Kept across choice changes, so a user who types a reason,
   * reconsiders, and comes back does not retype it. It reaches the model only on a
   * `decline`.
   */
  guidance: string;
}

export type ApprovalDecisionAction =
  | { type: "set-choice"; choice: ApprovalChoice }
  | { type: "set-guidance"; text: string };

/**
 * Opens on Approve. The submit button is enabled from mount (a decision is always
 * submittable and the guidance is optional), so the form has to start on a choice it
 * would actually perform rather than on an empty state a click would misreport.
 */
export function createApprovalDecisionState(): ApprovalDecisionState {
  return { choice: "approve", guidance: "" };
}

/** Clamp at the field, by code point, so an astral character is never split in half. */
export function clampGuidance(text: string): string {
  const points = [...text];
  if (points.length <= APPROVAL_LIMITS.guidance) return text;
  return points.slice(0, APPROVAL_LIMITS.guidance).join("");
}

export function reduceApprovalDecisionState(
  state: ApprovalDecisionState,
  action: ApprovalDecisionAction,
): ApprovalDecisionState {
  if (action.type === "set-choice") {
    if (action.choice === state.choice) return state;
    return { ...state, choice: action.choice };
  }
  return { ...state, guidance: clampGuidance(action.text) };
}

/**
 * The decision this state would submit. Guidance rides only the decline branch, and is
 * trimmed so a field holding nothing but whitespace produces today's plain decline
 * message byte for byte. The clamp is *not* re-applied here: it belongs at the input
 * (RFC-0010), and a read that re-clamps would silently truncate a stored value.
 */
export function buildApprovalDecision(
  state: ApprovalDecisionState,
): ApprovalDecision {
  if (state.choice === "decline") {
    return { kind: "decline", guidance: state.guidance.trim() };
  }
  return { kind: state.choice };
}
