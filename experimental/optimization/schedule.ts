import type {
  OptimizationCondition,
  OptimizationScheduleItem,
  OptimizationCaseDescriptor,
} from "./types";

function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function shuffled<T>(values: T[], next: () => number): T[] {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index--) {
    const target = Math.floor(next() * (index + 1));
    [result[index], result[target]] = [result[target], result[index]];
  }
  return result;
}

export function createOptimizationSchedule(
  cases: OptimizationCaseDescriptor[],
  conditions: [OptimizationCondition, OptimizationCondition],
  iterations: number,
  seed: number,
): OptimizationScheduleItem[] {
  if (!Number.isInteger(iterations) || iterations < 1) {
    throw new Error("Optimization iterations must be a positive integer.");
  }
  if (!Number.isInteger(seed)) throw new Error("Optimization seed must be an integer.");
  const baseline = conditions.find((condition) => condition.role === "baseline");
  const candidate = conditions.find((condition) => condition.role === "candidate");
  if (!baseline || !candidate || baseline.id === candidate.id) {
    throw new Error("Optimization conditions require distinct baseline and candidate identities.");
  }
  const next = random(seed);
  const pairs = cases.flatMap((entry) => Array.from({ length: iterations }, (_, index) => ({
    entry,
    iteration: index + 1,
    pairId: `${entry.id}:${index + 1}`,
  })));
  const result: OptimizationScheduleItem[] = [];
  for (const pair of shuffled(pairs, next)) {
    const ordered = next() < 0.5 ? [baseline, candidate] : [candidate, baseline];
    for (const condition of ordered) {
      result.push({
        sequence: result.length + 1,
        pairId: pair.pairId,
        caseId: pair.entry.id,
        visibility: pair.entry.visibility,
        iteration: pair.iteration,
        conditionId: condition.id,
        role: condition.role,
      });
    }
  }
  return result;
}
