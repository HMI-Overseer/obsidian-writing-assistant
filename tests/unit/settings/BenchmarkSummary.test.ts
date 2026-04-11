import { describe, it, expect } from "vitest";
import { computeSummaryStats, computeSuiteSummary } from "../../../src/settings/benchmark/BenchmarkSummary";
import type { BenchmarkTestCase, BenchmarkRunResult } from "../../../src/settings/benchmark/types";

function makeTestCase(id: string, isControl = false): BenchmarkTestCase {
  return {
    id,
    name: `Test ${id}`,
    description: "",
    document: "",
    systemPromptSuffix: "",
    messages: [],
    evaluate: () => ({ passed: true, reason: "", evidence: [] }),
    isControl,
  };
}

function makeResult(testId: string, passCount: number, totalCount: number): BenchmarkRunResult {
  return {
    testId,
    testName: `Test ${testId}`,
    modelId: "model-1",
    iterations: [],
    passCount,
    totalCount,
    avgDurationMs: 1000,
  };
}

describe("computeSummaryStats", () => {
  it("returns zeros when no tests have run", () => {
    const tests = [makeTestCase("t1"), makeTestCase("t2")];
    const results = new Map<string, BenchmarkRunResult>();

    const stats = computeSummaryStats(tests, results);
    expect(stats.totalTests).toBe(0);
    expect(stats.totalPassed).toBe(0);
    expect(stats.totalIterations).toBe(0);
    expect(stats.allTestsPerfect).toBe(true);
  });

  it("counts passed tests correctly", () => {
    const tests = [makeTestCase("t1"), makeTestCase("t2"), makeTestCase("t3")];
    const results = new Map<string, BenchmarkRunResult>([
      ["t1", makeResult("t1", 3, 3)],
      ["t2", makeResult("t2", 1, 3)],
    ]);

    const stats = computeSummaryStats(tests, results);
    expect(stats.totalTests).toBe(2);
    expect(stats.testsFullyPassed).toBe(1);
    expect(stats.totalPassed).toBe(4);
    expect(stats.totalIterations).toBe(6);
    expect(stats.allTestsPerfect).toBe(false);
  });

  it("marks allTestsPerfect when all pass", () => {
    const tests = [makeTestCase("t1"), makeTestCase("t2")];
    const results = new Map<string, BenchmarkRunResult>([
      ["t1", makeResult("t1", 3, 3)],
      ["t2", makeResult("t2", 3, 3)],
    ]);

    const stats = computeSummaryStats(tests, results);
    expect(stats.allTestsPerfect).toBe(true);
    expect(stats.testsFullyPassed).toBe(2);
  });

  it("excludes control tests from counts", () => {
    const tests = [
      makeTestCase("t1"),
      makeTestCase("control", true),
    ];
    const results = new Map<string, BenchmarkRunResult>([
      ["t1", makeResult("t1", 3, 3)],
      ["control", makeResult("control", 0, 3)],
    ]);

    const stats = computeSummaryStats(tests, results);
    expect(stats.totalTests).toBe(1);
    expect(stats.testsFullyPassed).toBe(1);
    expect(stats.totalPassed).toBe(3);
    expect(stats.totalIterations).toBe(3);
  });
});

describe("computeSuiteSummary", () => {
  it("includes control result when present", () => {
    const tests = [
      makeTestCase("t1"),
      makeTestCase("control", true),
    ];
    const results = new Map<string, BenchmarkRunResult>([
      ["t1", makeResult("t1", 2, 3)],
      ["control", makeResult("control", 1, 3)],
    ]);

    const stats = computeSuiteSummary(tests, results);
    expect(stats.controlResult).toEqual({ passCount: 1, totalCount: 3 });
    expect(stats.totalTests).toBe(1);
  });

  it("returns null controlResult when no control test", () => {
    const tests = [makeTestCase("t1")];
    const results = new Map<string, BenchmarkRunResult>([
      ["t1", makeResult("t1", 3, 3)],
    ]);

    const stats = computeSuiteSummary(tests, results);
    expect(stats.controlResult).toBeNull();
  });

  it("returns null controlResult when control hasn't run", () => {
    const tests = [
      makeTestCase("t1"),
      makeTestCase("control", true),
    ];
    const results = new Map<string, BenchmarkRunResult>([
      ["t1", makeResult("t1", 3, 3)],
    ]);

    const stats = computeSuiteSummary(tests, results);
    expect(stats.controlResult).toBeNull();
  });
});
