import { describe, it, expect } from "vitest";
import {
  evaluateBasicToolCall,
  evaluateCorrectToolSelection,
  evaluateSearchPrecision,
  evaluateMultipleEdits,
} from "../../../src/settings/benchmark/toolEvaluator";
import type { BenchmarkTestCase } from "../../../src/settings/benchmark/types";
import type { ToolCall } from "../../../src/tools/types";

const testCase = {} as BenchmarkTestCase;

function call(name: string, args: Record<string, unknown> = {}): ToolCall {
  return { id: `call-${name}`, name, arguments: args };
}

describe("evaluateBasicToolCall", () => {
  it("fails without tool calls", () => {
    const result = evaluateBasicToolCall("some prose", testCase, null);
    expect(result.passed).toBe(false);
  });

  it("fails when propose_edit is missing arguments", () => {
    const result = evaluateBasicToolCall("", testCase, [call("propose_edit", { search: "" })]);
    expect(result.passed).toBe(false);
  });

  it("passes with a valid propose_edit call", () => {
    const result = evaluateBasicToolCall("", testCase, [
      call("propose_edit", { search: "twelve feet tall", replace: "fourteen feet tall" }),
    ]);
    expect(result.passed).toBe(true);
  });
});

describe("evaluateCorrectToolSelection", () => {
  it("passes when only update_frontmatter is used", () => {
    const result = evaluateCorrectToolSelection("", testCase, [
      call("update_frontmatter", { key: "status", value: "complete" }),
    ]);
    expect(result.passed).toBe(true);
  });

  it("fails when propose_edit is used for frontmatter", () => {
    const result = evaluateCorrectToolSelection("", testCase, [
      call("propose_edit", { search: "status: in-progress", replace: "status: complete" }),
    ]);
    expect(result.passed).toBe(false);
  });

  it("fails when both tools are used", () => {
    const result = evaluateCorrectToolSelection("", testCase, [
      call("update_frontmatter", {}),
      call("propose_edit", {}),
    ]);
    expect(result.passed).toBe(false);
  });
});

describe("evaluateSearchPrecision", () => {
  it("passes when any propose_edit call is short and on target", () => {
    const result = evaluateSearchPrecision("", testCase, [
      call("propose_edit", { search: "x".repeat(300) }),
      call("propose_edit", { search: "above the thatched rooftops." }),
    ]);
    expect(result.passed).toBe(true);
  });

  it("fails when no search contains the target phrase", () => {
    const result = evaluateSearchPrecision("", testCase, [
      call("propose_edit", { search: "the quenching bucket" }),
    ]);
    expect(result.passed).toBe(false);
    expect(result.reason).toContain("thatched rooftops");
  });

  it("fails when all on-target searches are too long", () => {
    const result = evaluateSearchPrecision("", testCase, [
      call("propose_edit", { search: "thatched rooftops " + "x".repeat(300) }),
    ]);
    expect(result.passed).toBe(false);
    expect(result.reason).toContain("too long");
  });

  it("fails when search arguments are not strings", () => {
    const result = evaluateSearchPrecision("", testCase, [call("propose_edit", { search: 42 })]);
    expect(result.passed).toBe(false);
  });
});

describe("evaluateMultipleEdits", () => {
  it("passes with three or more edit calls", () => {
    const result = evaluateMultipleEdits("", testCase, [
      call("propose_edit", {}),
      call("propose_edit", {}),
      call("propose_edit", {}),
    ]);
    expect(result.passed).toBe(true);
  });

  it("fails with fewer than three calls", () => {
    const result = evaluateMultipleEdits("", testCase, [call("propose_edit", {})]);
    expect(result.passed).toBe(false);
  });
});
