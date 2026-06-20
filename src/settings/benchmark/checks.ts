import type { BenchmarkResult, EvaluationCheck } from "./types";

/** Creates a check. `required` defaults to true (a failure fails the test). */
export function check(
  id: string,
  label: string,
  passed: boolean,
  detail?: string,
  required = true
): EvaluationCheck {
  return { id, label, passed, required, ...(detail !== undefined ? { detail } : {}) };
}

/**
 * Derives the overall result from a list of checks: the test passes when every
 * required check passes. The reason summarizes the first failure, or the success.
 */
export function buildResultFromChecks(
  checks: EvaluationCheck[],
  evidence: string[],
  successReason: string
): BenchmarkResult {
  const firstFailure = checks.find((c) => c.required && !c.passed);

  if (!firstFailure) {
    return { passed: true, reason: successReason, evidence, checks };
  }

  const reason = firstFailure.detail
    ? `${firstFailure.label}, ${firstFailure.detail}`
    : firstFailure.label;

  return { passed: false, reason: `Failed: ${reason}`, evidence, checks };
}
