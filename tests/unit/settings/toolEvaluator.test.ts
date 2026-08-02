import { describe, it, expect } from "vitest";
import {
  evaluateBasicToolCall,
  evaluateCorrectToolSelection,
  evaluateSearchPrecision,
  evaluateMultipleEdits,
} from "../../../src/settings/benchmark/toolEvaluator";
import { TOOL_TEST_DOC } from "../../../src/settings/benchmark/toolTestCases";
import type { BenchmarkTestCase } from "../../../src/settings/benchmark/types";
import type { ToolCall } from "../../../src/tools/types";

const testCase = { document: TOOL_TEST_DOC } as BenchmarkTestCase;

function call(name: string, args: Record<string, unknown> = {}): ToolCall {
  return { id: `call-${name}`, name, arguments: args };
}

function failedCheckIds(result: { checks?: { id: string; passed: boolean; required: boolean }[] }): string[] {
  return (result.checks ?? []).filter((c) => !c.passed && c.required).map((c) => c.id);
}

describe("evaluateBasicToolCall", () => {
  it("fails without tool calls", () => {
    const result = evaluateBasicToolCall("some prose", testCase, null);
    expect(result.passed).toBe(false);
    expect(failedCheckIds(result)).toContain("produced-calls");
  });

  it("fails when edit is missing arguments", () => {
    const result = evaluateBasicToolCall("", testCase, [call("edit", { search: "" })]);
    expect(result.passed).toBe(false);
    expect(failedCheckIds(result)).toContain("valid-args");
  });

  it("passes with a valid edit call matching the document", () => {
    const result = evaluateBasicToolCall("", testCase, [
      call("edit", { search: "twelve feet tall", replace: "fourteen feet tall" }),
    ]);
    expect(result.passed).toBe(true);
  });

  it("fails when the search text paraphrases the document", () => {
    const result = evaluateBasicToolCall("", testCase, [
      call("edit", { search: "a gate that stood twelve feet in height", replace: "fourteen" }),
    ]);
    expect(result.passed).toBe(false);
    expect(failedCheckIds(result)).toContain("search-matches");
  });

  it("fails when the edit matches the document but misses the requested phrase", () => {
    const result = evaluateBasicToolCall("", testCase, [
      call("edit", { search: "Each day began before dawn.", replace: "x" }),
    ]);
    expect(result.passed).toBe(false);
    expect(failedCheckIds(result)).toContain("edits-target");
  });
});

describe("evaluateCorrectToolSelection", () => {
  it("passes when update_frontmatter performs both requested changes", () => {
    const result = evaluateCorrectToolSelection("", testCase, [
      call("update_frontmatter", {
        operations: [
          { key: "status", action: "set", value: "complete" },
          { key: "tags", action: "remove" },
        ],
      }),
    ]);
    expect(result.passed).toBe(true);
  });

  it("fails when edit is used for frontmatter", () => {
    const result = evaluateCorrectToolSelection("", testCase, [
      call("edit", { search: "status: in-progress", replace: "status: complete" }),
    ]);
    expect(result.passed).toBe(false);
    expect(failedCheckIds(result)).toContain("used-frontmatter-tool");
  });

  it("fails when both tools are used", () => {
    const result = evaluateCorrectToolSelection("", testCase, [
      call("update_frontmatter", { operations: [{ key: "status", action: "set", value: "complete" }] }),
      call("edit", {}),
    ]);
    expect(result.passed).toBe(false);
    expect(failedCheckIds(result)).toContain("no-edit");
  });

  it("fails when operations are malformed", () => {
    const result = evaluateCorrectToolSelection("", testCase, [
      call("update_frontmatter", { key: "status", value: "complete" }),
    ]);
    expect(result.passed).toBe(false);
    expect(failedCheckIds(result)).toContain("ops-well-formed");
  });

  it("fails when only one of the requested changes is performed", () => {
    const result = evaluateCorrectToolSelection("", testCase, [
      call("update_frontmatter", {
        operations: [{ key: "status", action: "set", value: "complete" }],
      }),
    ]);
    expect(result.passed).toBe(false);
    expect(failedCheckIds(result)).toContain("requested-changes");
    expect(result.reason).toContain("tags");
  });
});

describe("evaluateSearchPrecision", () => {
  // Exact substring of TOOL_TEST_DOC's evening section, longer than 200 chars.
  const EVENING_PARAGRAPH =
    "When the last light faded, Kael banked the fire and swept the floor. He hung his apron on the hook by the door and stepped into the cool evening air. The village was quiet. Stars emerged one by one above the thatched rooftops.";

  it("passes when any edit call is short, on target, and matches the document", () => {
    const result = evaluateSearchPrecision("", testCase, [
      call("edit", { search: "x".repeat(300) }),
      call("edit", { search: "above the thatched rooftops." }),
    ]);
    expect(result.passed).toBe(true);
  });

  it("fails when no search contains the target phrase", () => {
    const result = evaluateSearchPrecision("", testCase, [
      call("edit", { search: "the quenching bucket" }),
    ]);
    expect(result.passed).toBe(false);
    expect(result.reason).toContain("thatched rooftops");
  });

  it("fails when the on-target search does not match the document", () => {
    const result = evaluateSearchPrecision("", testCase, [
      call("edit", { search: "the thatched rooftops glowed crimson in the dusk" }),
    ]);
    expect(result.passed).toBe(false);
    expect(failedCheckIds(result)).toContain("search-matches");
  });

  it("fails when all matching on-target searches are too long", () => {
    const result = evaluateSearchPrecision("", testCase, [
      call("edit", { search: EVENING_PARAGRAPH }),
    ]);
    expect(result.passed).toBe(false);
    expect(failedCheckIds(result)).toContain("precise");
    expect(result.reason).toContain("too much context");
  });

  it("fails when search arguments are not strings", () => {
    const result = evaluateSearchPrecision("", testCase, [call("edit", { search: 42 })]);
    expect(result.passed).toBe(false);
    expect(failedCheckIds(result)).toContain("has-search");
  });
});

describe("evaluateMultipleEdits", () => {
  it("passes with three document-matching calls covering all replacements", () => {
    const result = evaluateMultipleEdits("", testCase, [
      call("edit", { search: "twelve feet tall", replace: "fourteen feet tall" }),
      call("edit", { search: "white-hot", replace: "cherry-red" }),
      call("edit", { search: "thatched rooftops", replace: "slate rooftops" }),
    ]);
    expect(result.passed).toBe(true);
  });

  it("fails with fewer than three calls", () => {
    const result = evaluateMultipleEdits("", testCase, [
      call("edit", { search: "twelve feet tall", replace: "fourteen feet tall" }),
    ]);
    expect(result.passed).toBe(false);
    expect(failedCheckIds(result)).toContain("three-calls");
  });

  it("fails when a requested replacement is missing", () => {
    const result = evaluateMultipleEdits("", testCase, [
      call("edit", { search: "twelve feet tall", replace: "fourteen feet tall" }),
      call("edit", { search: "white-hot", replace: "cherry-red" }),
      call("edit", { search: "thatched rooftops", replace: "tiled rooftops" }),
    ]);
    expect(result.passed).toBe(false);
    expect(failedCheckIds(result)).toContain("covers-changes");
    expect(result.reason).toContain("slate");
  });

  it("fails when a search does not match the document", () => {
    const result = evaluateMultipleEdits("", testCase, [
      call("edit", { search: "twelve feet tall", replace: "fourteen feet tall" }),
      call("edit", { search: "the fire burned white-hot all morning long", replace: "cherry-red" }),
      call("edit", { search: "thatched rooftops", replace: "slate rooftops" }),
    ]);
    expect(result.passed).toBe(false);
    expect(failedCheckIds(result)).toContain("search-matches");
  });
});
