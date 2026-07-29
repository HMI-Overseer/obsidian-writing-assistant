import { describe, expect, it } from "vitest";
import {
  APPROVAL_LIMITS,
  buildApprovalDecision,
  createApprovalDecisionState,
  reduceApprovalDecisionState,
  type ApprovalDecisionState,
} from "../../../../src/chat/composer/approvalDecisionState";

describe("approval decision state", () => {
  it("opens on Approve, so the enabled submit button never lies about what it does", () => {
    expect(createApprovalDecisionState()).toEqual({ choice: "approve", guidance: "" });
    expect(buildApprovalDecision(createApprovalDecisionState())).toEqual({ kind: "approve" });
  });

  it("moves between the three choices", () => {
    let state = createApprovalDecisionState();
    state = reduceApprovalDecisionState(state, {
      type: "set-choice",
      choice: "approve-session",
    });
    expect(state.choice).toBe("approve-session");
    state = reduceApprovalDecisionState(state, { type: "set-choice", choice: "decline" });
    expect(state.choice).toBe("decline");
    state = reduceApprovalDecisionState(state, { type: "set-choice", choice: "approve" });
    expect(state.choice).toBe("approve");
  });

  it("keeps the guidance draft when the user leaves Other and comes back", () => {
    let state = reduceApprovalDecisionState(createApprovalDecisionState(), {
      type: "set-choice",
      choice: "decline",
    });
    state = reduceApprovalDecisionState(state, {
      type: "set-guidance",
      text: "put it under Drafts/ instead",
    });
    state = reduceApprovalDecisionState(state, { type: "set-choice", choice: "approve" });
    expect(state.guidance).toBe("put it under Drafts/ instead");

    state = reduceApprovalDecisionState(state, { type: "set-choice", choice: "decline" });
    expect(state.guidance).toBe("put it under Drafts/ instead");
    expect(buildApprovalDecision(state)).toEqual({
      kind: "decline",
      guidance: "put it under Drafts/ instead",
    });
  });

  it("drops a typed draft from the decision whenever the choice is not a decline", () => {
    let state = reduceApprovalDecisionState(createApprovalDecisionState(), {
      type: "set-choice",
      choice: "decline",
    });
    state = reduceApprovalDecisionState(state, { type: "set-guidance", text: "not this way" });

    state = reduceApprovalDecisionState(state, { type: "set-choice", choice: "approve" });
    expect(buildApprovalDecision(state)).toEqual({ kind: "approve" });

    state = reduceApprovalDecisionState(state, {
      type: "set-choice",
      choice: "approve-session",
    });
    expect(buildApprovalDecision(state)).toEqual({ kind: "approve-session" });
  });

  it("emits an empty guidance for a plain decline, which is today's message unchanged", () => {
    const state = reduceApprovalDecisionState(createApprovalDecisionState(), {
      type: "set-choice",
      choice: "decline",
    });
    expect(buildApprovalDecision(state)).toEqual({ kind: "decline", guidance: "" });
  });

  it("trims the emitted guidance so whitespace alone never reads as a reason", () => {
    let state = reduceApprovalDecisionState(createApprovalDecisionState(), {
      type: "set-choice",
      choice: "decline",
    });
    state = reduceApprovalDecisionState(state, { type: "set-guidance", text: "   \n  " });
    expect(buildApprovalDecision(state)).toEqual({ kind: "decline", guidance: "" });
  });

  // RFC-0010: a bound on our own input field clamps at write time and never gates a read.
  it("clamps the draft as it is written, counting code points not UTF-16 units", () => {
    const overLong = "a".repeat(APPROVAL_LIMITS.guidance + 25);
    const clamped = reduceApprovalDecisionState(createApprovalDecisionState(), {
      type: "set-guidance",
      text: overLong,
    });
    expect([...clamped.guidance]).toHaveLength(APPROVAL_LIMITS.guidance);

    // Astral characters are two UTF-16 units each; the clamp must not split one.
    const astral = "🜁".repeat(APPROVAL_LIMITS.guidance + 10);
    const clampedAstral = reduceApprovalDecisionState(createApprovalDecisionState(), {
      type: "set-guidance",
      text: astral,
    });
    expect([...clampedAstral.guidance]).toHaveLength(APPROVAL_LIMITS.guidance);
    expect(clampedAstral.guidance.endsWith("🜁")).toBe(true);
  });

  it("leaves an at-limit draft byte-identical rather than rebuilding it", () => {
    const exact = "b".repeat(APPROVAL_LIMITS.guidance);
    const state = reduceApprovalDecisionState(createApprovalDecisionState(), {
      type: "set-guidance",
      text: exact,
    });
    expect(state.guidance).toBe(exact);
  });

  it("never re-applies the clamp when reading a stored value back", () => {
    const stored: ApprovalDecisionState = {
      choice: "decline",
      guidance: "c".repeat(APPROVAL_LIMITS.guidance + 40),
    };
    const decision = buildApprovalDecision(stored);
    expect(decision).toEqual({
      kind: "decline",
      guidance: "c".repeat(APPROVAL_LIMITS.guidance + 40),
    });
  });
});
