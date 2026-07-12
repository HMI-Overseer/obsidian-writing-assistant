import { createHash } from "node:crypto";
import {
  calculateOptimizationEffects,
  compareOptimizationResources,
  evaluateOptimizationGates,
} from "./analysis";
import { createOptimizationSchedule } from "./schedule";
import {
  OPTIMIZATION_EXPERIMENT_SCHEMA_VERSION,
  type BlindQualitativePacket,
  type OptimizationExperimentManifest,
  type OptimizationExperimentResult,
  type OptimizationExperimentSpec,
  type OptimizationArtifactSink,
  type OptimizationTrialExecutor,
} from "./types";

function validateSpec(spec: OptimizationExperimentSpec): void {
  if (spec.cases.length === 0) throw new Error("Optimization requires at least one case.");
  if (!Number.isInteger(spec.bootstrapSamples) || spec.bootstrapSamples < 100) {
    throw new Error("Optimization bootstrap samples must be an integer of at least 100.");
  }
  if (!(spec.confidenceLevel > 0 && spec.confidenceLevel < 1)) {
    throw new Error("Optimization confidence level must be between zero and one.");
  }
  const ids = spec.cases.map((entry) => entry.id);
  if (new Set(ids).size !== ids.length) throw new Error("Optimization case IDs must be unique.");
  const heldout = spec.cases.filter((entry) => entry.visibility === "heldout");
  if (heldout.length > 0 && !spec.heldoutPack) {
    throw new Error("Held-out optimization cases require a frozen sealed-pack manifest.");
  }
  const publicIds = new Set(spec.heldoutPack?.cases.map((entry) => entry.opaqueId) ?? []);
  if (heldout.some((entry) => !publicIds.has(entry.id))) {
    throw new Error("Held-out optimization cases must exist in the sealed-pack public manifest.");
  }
  for (const [name, value] of Object.entries(spec.bounds)) {
    if (!Number.isInteger(value) || value < 1) {
      throw new Error(`Optimization bound ${name} must be a positive integer.`);
    }
  }
}

function createBlindPacket(
  manifest: OptimizationExperimentManifest,
  trials: OptimizationExperimentResult["trials"],
  rubric: string[],
): {
  packet: BlindQualitativePacket;
  assignments: OptimizationExperimentResult["blindAssignments"];
} {
  const pairs = new Map<string, typeof trials>();
  for (const trial of trials.filter((entry) =>
    entry.visibility === "development" && entry.qualitativeOutput !== null)) {
    pairs.set(trial.pairId, [...(pairs.get(trial.pairId) ?? []), trial]);
  }
  const assignments: OptimizationExperimentResult["blindAssignments"] = [];
  const packetPairs: BlindQualitativePacket["pairs"] = [];
  for (const [pairId, entries] of pairs) {
    const baseline = entries.find((entry) => entry.role === "baseline");
    const candidate = entries.find((entry) => entry.role === "candidate");
    if (!baseline?.qualitativeOutput || !candidate?.qualitativeOutput) continue;
    const baselineOutput = baseline.qualitativeOutput;
    const candidateOutput = candidate.qualitativeOutput;
    const digest = createHash("sha256").update(`${manifest.experimentId}:${pairId}`).digest();
    const blindPairId = digest.toString("hex").slice(0, 16);
    const candidateFirst = digest[0] % 2 === 0;
    const first = candidateFirst ? candidate : baseline;
    const second = candidateFirst ? baseline : candidate;
    assignments.push({
      blindPairId,
      responseAConditionId: first.conditionId,
      responseBConditionId: second.conditionId,
    });
    packetPairs.push({
      blindPairId,
      caseId: first.caseId,
      iteration: first.iteration,
      responseA: candidateFirst ? candidateOutput : baselineOutput,
      responseB: candidateFirst ? baselineOutput : candidateOutput,
    });
  }
  return {
    packet: {
      schemaVersion: 1,
      kind: "blind-qualitative-packet",
      experimentId: manifest.experimentId,
      createdAt: manifest.startedAt,
      rubric: [...rubric],
      pairs: packetPairs,
    },
    assignments,
  };
}

export async function runOptimizationExperiment(
  spec: OptimizationExperimentSpec,
  executor: OptimizationTrialExecutor,
  options: {
    artifactSink?: OptimizationArtifactSink;
    now?: () => number;
  } = {},
): Promise<OptimizationExperimentResult> {
  validateSpec(spec);
  const now = options.now ?? Date.now;
  const manifest: OptimizationExperimentManifest = {
    schemaVersion: OPTIMIZATION_EXPERIMENT_SCHEMA_VERSION,
    kind: "optimization-experiment",
    experimentId: spec.experimentId ?? globalThis.crypto.randomUUID(),
    startedAt: new Date(now()).toISOString(),
    seed: spec.seed,
    iterations: spec.iterations,
    bootstrapSamples: spec.bootstrapSamples,
    confidenceLevel: spec.confidenceLevel,
    cases: structuredClone(spec.cases),
    heldoutPack: spec.heldoutPack ? structuredClone(spec.heldoutPack) : null,
    conditions: structuredClone(spec.conditions),
    bounds: structuredClone(spec.bounds),
    gates: structuredClone(spec.gates),
    schedule: createOptimizationSchedule(spec.cases, spec.conditions, spec.iterations, spec.seed),
    provenance: structuredClone(spec.provenance),
  };
  await options.artifactSink?.begin(structuredClone(manifest));
  const trials = [];
  for (const item of manifest.schedule) {
    const trial = await executor(structuredClone(item), structuredClone(manifest));
    if (trial.experimentId !== manifest.experimentId ||
        trial.sequence !== item.sequence || trial.pairId !== item.pairId ||
        trial.caseId !== item.caseId || trial.conditionId !== item.conditionId ||
        trial.role !== item.role || trial.visibility !== item.visibility) {
      throw new Error(`Optimization executor returned mismatched evidence for sequence ${item.sequence}.`);
    }
    trials.push(trial);
    await options.artifactSink?.write(structuredClone(trial));
  }
  const effects = calculateOptimizationEffects(trials, manifest);
  const resources = compareOptimizationResources(trials);
  const gates = evaluateOptimizationGates(manifest, trials, effects, resources);
  const blind = createBlindPacket(manifest, trials, spec.qualitativeRubric);
  const nonHumanFailure = gates.some((gate) => !gate.passed && !gate.pendingHumanApproval);
  const result: OptimizationExperimentResult = {
    manifest,
    completedAt: new Date(now()).toISOString(),
    trials,
    effects,
    resources,
    gates,
    regressions: effects.filter((effect) => effect.classification === "regression"),
    blindPacket: blind.packet,
    blindAssignments: blind.assignments,
    recommendation: nonHumanFailure ? "rejected" : "awaiting-human-approval",
  };
  await options.artifactSink?.finish(structuredClone(result));
  return result;
}
