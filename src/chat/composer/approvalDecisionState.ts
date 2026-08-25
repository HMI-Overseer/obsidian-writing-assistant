import type { ApprovalDecision } from "../interactions/approvalTypes";

export type ApprovalChoice = ApprovalDecision["kind"];

export interface ApprovalDecisionState {
  choice: ApprovalChoice;
  /**
   * The Other draft. Kept across choice changes, so a user who types a reason,
   * reconsiders, and comes back does not retype it. It reaches the model only on a
   * `decline`.
   *
   * Deliberately unbounded, matching the ask window's Other. This once clamped at 500
   * code points, a number that named no failure and only truncated the reasoning that
   * made declining useful in the first place.
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

export function reduceApprovalDecisionState(
  state: ApprovalDecisionState,
  action: ApprovalDecisionAction,
): ApprovalDecisionState {
  if (action.type === "set-choice") {
    if (action.choice === state.choice) return state;
    return { ...state, choice: action.choice };
  }
  return { ...state, guidance: action.text };
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
