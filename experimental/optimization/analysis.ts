import { createHash } from "node:crypto";
import { BEHAVIOR_DIMENSIONS } from "../behavior/types";
import type { BehaviorDimension } from "../behavior/types";
import type {
  BlindQualitativeJudgment,
  BlindQualitativeResult,
  OptimizationDimensionEffect,
  OptimizationExperimentManifest,
  OptimizationGate,
  OptimizationGateResult,
  OptimizationResourceComparison,
  OptimizationTrialObservation,
  OptimizationVisibility,
} from "./types";

function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_103_515_245) + 12_345) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function dimensionPassed(
  trial: OptimizationTrialObservation,
  dimension: BehaviorDimension,
): boolean | null {
  const checks = trial.checks.filter((entry) => entry.dimensions.includes(dimension));
  return checks.length === 0 ? null : checks.every((entry) => entry.passed);
}

function percentile(values: number[], position: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor(position * sorted.length)));
  return sorted[index];
}

function bootstrapInterval(
  differences: number[],
  samples: number,
  confidenceLevel: number,
  seed: number,
): { lower: number; upper: number } | null {
  if (differences.length === 0) return null;
  const next = random(seed);
  const means = Array.from({ length: samples }, () => {
    let total = 0;
    for (let index = 0; index < differences.length; index++) {
      total += differences[Math.floor(next() * differences.length)];
    }
    return total / differences.length;
  });
  const tail = (1 - confidenceLevel) / 2;
  return { lower: percentile(means, tail), upper: percentile(means, 1 - tail) };
}

function effectFor(
  trials: OptimizationTrialObservation[],
  dimension: BehaviorDimension,
  visibility: "all" | OptimizationVisibility,
  manifest: OptimizationExperimentManifest,
): OptimizationDimensionEffect {
  const selected = visibility === "all"
    ? trials
    : trials.filter((trial) => trial.visibility === visibility);
  const byPair = new Map<string, OptimizationTrialObservation[]>();
  for (const trial of selected) byPair.set(trial.pairId, [...(byPair.get(trial.pairId) ?? []), trial]);
  const paired = [...byPair.values()].flatMap((pair) => {
    const baseline = pair.find((trial) => trial.role === "baseline");
    const candidate = pair.find((trial) => trial.role === "candidate");
    if (!baseline || !candidate) return [];
    const baselinePassed = dimensionPassed(baseline, dimension);
    const candidatePassed = dimensionPassed(candidate, dimension);
    if (baselinePassed === null || candidatePassed === null) return [];
    return [{ baselinePassed, candidatePassed }];
  });
  if (paired.length === 0) {
    return {
      dimension,
      visibility,
      pairCount: 0,
      baselinePassRate: null,
      candidatePassRate: null,
      delta: null,
      confidenceInterval: null,
      classification: "inconclusive",
    };
  }
  const baselinePassRate = paired.filter((pair) => pair.baselinePassed).length / paired.length;
  const candidatePassRate = paired.filter((pair) => pair.candidatePassed).length / paired.length;
  const differences = paired.map((pair) => Number(pair.candidatePassed) - Number(pair.baselinePassed));
  const delta = candidatePassRate - baselinePassRate;
  const hash = createHash("sha256").update(`${dimension}:${visibility}`).digest().readUInt32LE(0);
  const confidenceInterval = bootstrapInterval(
    differences,
    manifest.bootstrapSamples,
    manifest.confidenceLevel,
    manifest.seed ^ hash,
  );
  const classification = confidenceInterval && confidenceInterval.lower > 0
    ? "improvement"
    : confidenceInterval && confidenceInterval.upper < 0
      ? "regression"
      : delta === 0
        ? "unchanged"
        : "inconclusive";
  return {
    dimension,
    visibility,
    pairCount: paired.length,
    baselinePassRate,
    candidatePassRate,
    delta,
    confidenceInterval,
    classification,
  };
}

export function calculateOptimizationEffects(
  trials: OptimizationTrialObservation[],
  manifest: OptimizationExperimentManifest,
): OptimizationDimensionEffect[] {
  return BEHAVIOR_DIMENSIONS.flatMap((dimension) => [
    effectFor(trials, dimension, "all", manifest),
    effectFor(trials, dimension, "development", manifest),
    effectFor(trials, dimension, "heldout", manifest),
  ]);
}

function numericResource(
  trial: OptimizationTrialObservation,
  resource: OptimizationResourceComparison["resource"],
): number | null {
  return trial.resources[resource];
}

export function compareOptimizationResources(
  trials: OptimizationTrialObservation[],
): OptimizationResourceComparison[] {
  const names: OptimizationResourceComparison["resource"][] = [
    "durationMs",
    "toolCalls",
    "inputTokens",
    "outputTokens",
  ];
  return names.map((resource) => {
    const values = (role: "baseline" | "candidate"): number[] => trials
      .filter((trial) => trial.role === role)
      .map((trial) => numericResource(trial, resource))
      .filter((value): value is number => value !== null);
    const baseline = values("baseline");
    const candidate = values("candidate");
    const mean = (entries: number[]): number | null => entries.length === 0
      ? null
      : entries.reduce((total, value) => total + value, 0) / entries.length;
    const baselineMean = mean(baseline);
    const candidateMean = mean(candidate);
    const ratio = baselineMean === null || candidateMean === null
      ? null
      : baselineMean === 0
        ? candidateMean === 0 ? 1 : null
        : candidateMean / baselineMean;
    return {
      resource,
      baselineMean,
      candidateMean,
      ratio,
      delta: baselineMean === null || candidateMean === null ? null : candidateMean - baselineMean,
    };
  });
}

function effectForGate(
  effects: OptimizationDimensionEffect[],
  gate: Extract<OptimizationGate, { dimension: BehaviorDimension }>,
): OptimizationDimensionEffect | undefined {
  return effects.find((effect) =>
    effect.dimension === gate.dimension && effect.visibility === gate.visibility);
}

export function evaluateOptimizationGates(
  manifest: OptimizationExperimentManifest,
  trials: OptimizationTrialObservation[],
  effects: OptimizationDimensionEffect[],
  resources: OptimizationResourceComparison[],
): OptimizationGateResult[] {
  return manifest.gates.map((gate): OptimizationGateResult => {
    if (gate.kind === "human-approval") {
      return {
        id: gate.id,
        passed: false,
        pendingHumanApproval: true,
        detail: "Explicit human approval has not been attached.",
      };
    }
    if (gate.kind === "heldout-required") {
      const cases = new Set(trials.filter((trial) => trial.visibility === "heldout")
        .map((trial) => trial.caseId));
      return {
        id: gate.id,
        passed: cases.size >= gate.minimumCases,
        pendingHumanApproval: false,
        detail: `${cases.size} held-out cases observed; ${gate.minimumCases} required.`,
      };
    }
    if (gate.kind === "evaluator-validity") {
      const invalid = trials.filter((trial) => !trial.evaluatorValid).length;
      return {
        id: gate.id,
        passed: invalid === 0,
        pendingHumanApproval: false,
        detail: `${invalid} trial evaluators were invalid.`,
      };
    }
    if (gate.kind === "resource-ratio") {
      const resource = resources.find((entry) => entry.resource === gate.resource);
      const passed = resource?.ratio !== null && resource?.ratio !== undefined &&
        resource.ratio <= gate.maximumRatio;
      return {
        id: gate.id,
        passed,
        pendingHumanApproval: false,
        detail: `Observed ratio ${resource?.ratio ?? "missing"}; maximum ${gate.maximumRatio}.`,
      };
    }
    if (gate.kind === "zero-candidate-failures") {
      const selected = trials.filter((trial) => trial.role === "candidate" &&
        (gate.visibility === "all" || trial.visibility === gate.visibility));
      const evidence = selected.map((trial) => dimensionPassed(trial, gate.dimension))
        .filter((value): value is boolean => value !== null);
      const failures = evidence.filter((passed) => !passed).length;
      return {
        id: gate.id,
        passed: evidence.length > 0 && failures === 0,
        pendingHumanApproval: false,
        detail: `${failures} failures across ${evidence.length} candidate observations.`,
      };
    }
    const effect = effectForGate(effects, gate);
    if (gate.kind === "minimum-improvement") {
      const observed = gate.requireCiLowerBound
        ? effect?.confidenceInterval?.lower ?? null
        : effect?.delta ?? null;
      const passed = effect !== undefined && effect.pairCount >= gate.minimumPairs &&
        observed !== null && observed >= gate.minimumDelta;
      return {
        id: gate.id,
        passed,
        pendingHumanApproval: false,
        detail: `Observed ${observed ?? "missing"} across ${effect?.pairCount ?? 0} pairs; ` +
          `minimum ${gate.minimumDelta} across ${gate.minimumPairs} pairs.`,
      };
    }
    const observed = effect?.delta ?? null;
    const passed = effect !== undefined && effect.pairCount >= gate.minimumPairs &&
      observed !== null && observed >= -gate.maximumRegression;
    return {
      id: gate.id,
      passed,
      pendingHumanApproval: false,
      detail: `Observed delta ${observed ?? "missing"} across ${effect?.pairCount ?? 0} pairs; ` +
        `maximum regression ${gate.maximumRegression}.`,
    };
  });
}

export function scoreBlindJudgments(args: {
  experimentId: string;
  judgments: BlindQualitativeJudgment[];
  assignments: Array<{
    blindPairId: string;
    responseAConditionId: string;
    responseBConditionId: string;
  }>;
  candidateConditionId: string;
  humanApproved: boolean;
  reviewer: string;
  reviewedAt: string;
}): BlindQualitativeResult {
  const assignments = new Map(args.assignments.map((entry) => [entry.blindPairId, entry]));
  const rubric: BlindQualitativeResult["rubric"] = {};
  let candidateWins = 0;
  let baselineWins = 0;
  let ties = 0;
  const classify = (blindPairId: string, winner: "A" | "B" | "tie"): "candidate" | "baseline" | "tie" => {
    if (winner === "tie") return "tie";
    const assignment = assignments.get(blindPairId);
    if (!assignment) throw new Error(`No blind assignment for ${JSON.stringify(blindPairId)}.`);
    const winnerCondition = winner === "A"
      ? assignment.responseAConditionId
      : assignment.responseBConditionId;
    return winnerCondition === args.candidateConditionId ? "candidate" : "baseline";
  };
  for (const judgment of args.judgments) {
    const result = classify(judgment.blindPairId, judgment.winner);
    if (result === "candidate") candidateWins++;
    else if (result === "baseline") baselineWins++;
    else ties++;
    for (const [name, winner] of Object.entries(judgment.rubric)) {
      const entry = rubric[name] ?? { candidateWins: 0, baselineWins: 0, ties: 0 };
      const rubricResult = classify(judgment.blindPairId, winner);
      if (rubricResult === "candidate") entry.candidateWins++;
      else if (rubricResult === "baseline") entry.baselineWins++;
      else entry.ties++;
      rubric[name] = entry;
    }
  }
  return {
    experimentId: args.experimentId,
    judgedPairs: args.judgments.length,
    candidateWins,
    baselineWins,
    ties,
    rubric,
    humanApproved: args.humanApproved,
    reviewer: args.reviewer,
    reviewedAt: args.reviewedAt,
  };
}
