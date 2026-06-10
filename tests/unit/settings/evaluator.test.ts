import { describe, it, expect } from "vitest";
import { evaluateStateAwareness } from "../../../src/settings/benchmark/evaluator";
import type { BenchmarkTestCase, EvaluationCheck } from "../../../src/settings/benchmark/types";

const testCase = {} as BenchmarkTestCase;

function getCheck(checks: EvaluationCheck[] | undefined, id: string): EvaluationCheck {
  const c = checks?.find((x) => x.id === id);
  if (!c) throw new Error(`Missing check ${id}`);
  return c;
}

describe("evaluateStateAwareness", () => {
  it("passes when each change is paired with its outcome in a sentence", () => {
    const result = evaluateStateAwareness(
      "The first change to the opening paragraph was accepted and applied. " +
        "The fountain paragraph rewrite was rejected, so that paragraph is unchanged.",
      testCase
    );
    expect(result.passed).toBe(true);
  });

  it("passes for list-style summaries", () => {
    const result = evaluateStateAwareness(
      "Current state:\n- Opening paragraph: accepted and applied\n- Fountain paragraph: rejected, still original",
      testCase
    );
    expect(result.passed).toBe(true);
  });

  it("fails when outcome words appear but are never paired with the changes", () => {
    const result = evaluateStateAwareness(
      "I made changes to the opening and the fountain scene. Everything was accepted and applied beautifully.",
      testCase
    );
    expect(result.passed).toBe(false);
    expect(getCheck(result.checks, "identifies-rejected").passed).toBe(false);
  });

  it("fails when only the accepted change is acknowledged", () => {
    const result = evaluateStateAwareness(
      "The opening paragraph change was accepted and is now in the document.",
      testCase
    );
    expect(result.passed).toBe(false);
    expect(getCheck(result.checks, "identifies-accepted").passed).toBe(true);
    expect(getCheck(result.checks, "identifies-rejected").passed).toBe(false);
  });

  it("flags edit blocks informationally without failing the test", () => {
    const result = evaluateStateAwareness(
      "The opening change was accepted. The fountain change was rejected and remains original.\n\n" +
        "<<<<<<< SEARCH\nfoo\n=======\nbar\n>>>>>>> REPLACE",
      testCase
    );
    expect(result.passed).toBe(true);
    expect(getCheck(result.checks, "prose-only").passed).toBe(false);
    expect(getCheck(result.checks, "prose-only").required).toBe(false);
  });
});
