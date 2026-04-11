import type { BenchmarkTestCase, BenchmarkRunResult } from "./types";

export interface SummaryStats {
  testsFullyPassed: number;
  totalTests: number;
  totalPassed: number;
  totalIterations: number;
  allTestsPerfect: boolean;
}

export interface SuiteSummaryStats extends SummaryStats {
  controlResult: { passCount: number; totalCount: number } | null;
}

/**
 * Compute aggregate summary statistics for a set of test results.
 * Excludes control test cases from the counts.
 */
export function computeSummaryStats(
  testCases: BenchmarkTestCase[],
  results: Map<string, BenchmarkRunResult>,
): SummaryStats {
  const nonControl = testCases.filter((tc) => !tc.isControl);
  const ranTests = nonControl.filter((tc) => results.has(tc.id));

  if (ranTests.length === 0) {
    return {
      testsFullyPassed: 0,
      totalTests: 0,
      totalPassed: 0,
      totalIterations: 0,
      allTestsPerfect: true,
    };
  }

  let totalPassed = 0;
  let totalIterations = 0;
  let allTestsPerfect = true;

  for (const tc of ranTests) {
    const r = results.get(tc.id);
    if (!r) continue;
    totalPassed += r.passCount;
    totalIterations += r.totalCount;
    if (r.passCount < r.totalCount) allTestsPerfect = false;
  }

  const testsFullyPassed = ranTests.filter((tc) => {
    const r = results.get(tc.id);
    return r && r.passCount === r.totalCount;
  }).length;

  return {
    testsFullyPassed,
    totalTests: ranTests.length,
    totalPassed,
    totalIterations,
    allTestsPerfect,
  };
}

/**
 * Compute suite-level summary stats including control result.
 */
export function computeSuiteSummary(
  testCases: BenchmarkTestCase[],
  results: Map<string, BenchmarkRunResult>,
): SuiteSummaryStats {
  const stats = computeSummaryStats(testCases, results);

  const controlCase = testCases.find((tc) => tc.isControl);
  let controlResult: SuiteSummaryStats["controlResult"] = null;

  if (controlCase) {
    const cr = results.get(controlCase.id);
    if (cr) {
      controlResult = { passCount: cr.passCount, totalCount: cr.totalCount };
    }
  }

  return { ...stats, controlResult };
}
