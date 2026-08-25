import { describe, expect, it } from "vitest";
import {
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

  // The guidance field is deliberately uncapped, matching the ask window's Other. A
  // ceiling here named no failure and only truncated the reasoning that makes a
  // decline useful to the model.
  it("carries a long draft through write and read without truncating it", () => {
    const essay = "a".repeat(5_000);
    const state = reduceApprovalDecisionState(createApprovalDecisionState(), {
      type: "set-guidance",
      text: essay,
    });
    expect(state.guidance).toBe(essay);
    expect(buildApprovalDecision({ ...state, choice: "decline" })).toEqual({
      kind: "decline",
      guidance: essay,
    });
  });

  it("keeps astral text intact instead of splitting a surrogate pair", () => {
    const astral = "\u{1F701}".repeat(2_000);
    const state = reduceApprovalDecisionState(createApprovalDecisionState(), {
      type: "set-guidance",
      text: astral,
    });
    expect(state.guidance).toBe(astral);
    expect([...state.guidance]).toHaveLength(2_000);
  });

  it("never re-applies a bound when reading a stored value back", () => {
    const stored: ApprovalDecisionState = {
      choice: "decline",
      guidance: "c".repeat(4_000),
    };
    expect(buildApprovalDecision(stored)).toEqual({
      kind: "decline",
      guidance: "c".repeat(4_000),
    });
  });
});
