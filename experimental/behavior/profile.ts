import { readFile } from "node:fs/promises";
import path from "node:path";
import { labRunArtifactDirectory } from "../lab/fileArtifactSink";
import type { LabCheck, LabRunManifest, LabTrialTrace } from "../lab/types";
import type { SandboxEpisodeRunManifest, SandboxEpisodeRunSummary, SandboxEpisodeTrace } from "../sandbox/types";
import { resolveBehaviorCheckDimensions, resolveBehaviorMapping } from "./registry";
import {
  BEHAVIOR_DIFFERENTIAL_SCHEMA_VERSION,
  BEHAVIOR_DIMENSIONS,
  BEHAVIOR_MAPPING_SCHEMA_VERSION,
  BEHAVIOR_PROFILE_SCHEMA_VERSION,
  type BehaviorCheckAggregate,
  type BehaviorDifferentialResult,
  type BehaviorDifferentialManifest,
  type BehaviorDifferentialSink,
  type BehaviorDimension,
  type BehaviorEvidenceTrace,
  type BehaviorProfileResult,
  type BehaviorProfileManifest,
  type BehaviorProfileSink,
  type BehaviorResourceAggregate,
  type BehaviorRunInput,
  type BehaviorScenarioProfile,
} from "./types";

function emptyAggregate(): BehaviorCheckAggregate {
  return { status: "missing", evidenceCount: 0, passCount: 0, passRate: null };
}

function emptyDimensions(): Record<BehaviorDimension, BehaviorCheckAggregate> {
  return Object.fromEntries(BEHAVIOR_DIMENSIONS.map((dimension) => [
    dimension,
    emptyAggregate(),
  ])) as Record<BehaviorDimension, BehaviorCheckAggregate>;
}

function addEvidence(aggregate: BehaviorCheckAggregate, passed: boolean): void {
  aggregate.status = "observed";
  aggregate.evidenceCount++;
  if (passed) aggregate.passCount++;
  aggregate.passRate = aggregate.passCount / aggregate.evidenceCount;
}

function resources(traces: BehaviorEvidenceTrace[]): BehaviorResourceAggregate {
  const count = traces.length;
  const duration = traces.reduce((total, trace) => total + trace.durationMs, 0);
  const tools = traces.reduce((total, trace) => total + trace.toolCalls, 0);
  const input = traces.filter((trace) => trace.inputTokens !== null);
  const output = traces.filter((trace) => trace.outputTokens !== null);
  return {
    traceCount: count,
    durationMs: { total: duration, mean: count > 0 ? duration / count : null },
    toolCalls: { total: tools, mean: count > 0 ? tools / count : null },
    inputTokens: {
      total: input.reduce((total, trace) => total + (trace.inputTokens ?? 0), 0),
      observedTraces: input.length,
    },
    outputTokens: {
      total: output.reduce((total, trace) => total + (trace.outputTokens ?? 0), 0),
      observedTraces: output.length,
    },
  };
}

function checkDimensions(scenarioId: string, version: number, checkId: string): BehaviorDimension[] {
  return resolveBehaviorCheckDimensions(scenarioId, version, checkId);
}

function scenarioProfile(traces: BehaviorEvidenceTrace[]): BehaviorScenarioProfile {
  const first = traces[0];
  const mapping = resolveBehaviorMapping(first.scenario.id, first.scenario.version);
  const dimensions = emptyDimensions();
  for (const trace of traces) {
    for (const check of trace.checks) {
      for (const dimension of checkDimensions(trace.scenario.id, trace.scenario.version, check.id)) {
        addEvidence(dimensions[dimension], check.passed);
      }
    }
  }
  if (traces.length > 0 && dimensions.efficiency.status === "missing") {
    dimensions.efficiency = {
      status: "observed",
      evidenceCount: traces.length,
      passCount: 0,
      passRate: null,
    };
  }
  if (traces.length >= 2) {
    addEvidence(dimensions.robustness, traces.every((trace) => trace.passed));
  }
  return {
    scenario: structuredClone(first.scenario),
    family: mapping.family,
    runIds: [...new Set(traces.map((trace) => trace.runId))],
    traceCount: traces.length,
    passedTraces: traces.filter((trace) => trace.passed).length,
    dimensions,
    resources: resources(traces),
  };
}

function combineDimensions(
  scenarios: BehaviorScenarioProfile[],
): Record<BehaviorDimension, BehaviorCheckAggregate> {
  const dimensions = emptyDimensions();
  for (const dimension of BEHAVIOR_DIMENSIONS) {
    const observed = scenarios
      .map((scenario) => scenario.dimensions[dimension])
      .filter((entry) => entry.status === "observed");
    if (observed.length === 0) continue;
    const evidenceCount = observed.reduce((total, entry) => total + entry.evidenceCount, 0);
    const passCount = observed.reduce((total, entry) => total + entry.passCount, 0);
    dimensions[dimension] = {
      status: "observed",
      evidenceCount,
      passCount,
      passRate: observed.some((entry) => entry.passRate === null)
        ? null
        : passCount / evidenceCount,
    };
  }
  return dimensions;
}

function sameSubject(inputs: BehaviorRunInput[]): boolean {
  const identity = (input: BehaviorRunInput): string => JSON.stringify({
    provider: input.provenance.subject.provider,
    modelId: input.provenance.subject.modelId,
    chatTemplate: input.provenance.subject.runtime?.chatTemplate ?? null,
  });
  return inputs.every((input) => identity(input) === identity(inputs[0]));
}

function profileChecks(inputs: BehaviorRunInput[]): LabCheck[] {
  const runIds = inputs.map((input) => input.runId);
  const mappingsPresent = inputs.every((input) => {
    try {
      resolveBehaviorMapping(input.scenario.id, input.scenario.version);
      return true;
    } catch {
      return false;
    }
  });
  const requiredChecksMapped = inputs.flatMap((input) => input.traces).every((trace) =>
    trace.checks.every((entry) => !entry.required ||
      checkDimensions(trace.scenario.id, trace.scenario.version, entry.id).length > 0));
  return [
    {
      id: "unique-profile-runs",
      label: "Every profile input run is unique",
      passed: new Set(runIds).size === runIds.length,
      required: true,
    },
    {
      id: "same-profile-subject",
      label: "Every profile run records the same provider, model, and chat template",
      passed: sameSubject(inputs),
      required: true,
    },
    {
      id: "same-profile-source-revision",
      label: "Every profile run records the same source revision",
      passed: inputs.every((input) =>
        input.provenance.sourceRevision === inputs[0].provenance.sourceRevision),
      required: true,
    },
    {
      id: "registered-profile-scenarios",
      label: "Every profile scenario has a versioned behavior mapping",
      passed: mappingsPresent,
      required: true,
    },
    {
      id: "mapped-required-checks",
      label: "Every required evaluator check maps to at least one behavior dimension",
      passed: requiredChecksMapped,
      required: true,
    },
  ];
}

function metamorphicGroups(scenarios: BehaviorScenarioProfile[]): BehaviorProfileResult["metamorphicGroups"] {
  const groups = new Map<string, {
    transformation: string;
    scenarioIds: string[];
    observed: BehaviorScenarioProfile[];
  }>();
  for (const scenario of scenarios) {
    const mapping = resolveBehaviorMapping(scenario.scenario.id, scenario.scenario.version);
    if (!mapping.metamorphicGroup) continue;
    const existing = groups.get(mapping.metamorphicGroup.id) ?? {
      transformation: mapping.metamorphicGroup.transformation,
      scenarioIds: [],
      observed: [],
    };
    existing.scenarioIds.push(scenario.scenario.id);
    existing.observed.push(scenario);
    groups.set(mapping.metamorphicGroup.id, existing);
  }
  return [...groups.entries()].map(([id, group]) => ({
    id,
    transformation: group.transformation,
    scenarioIds: group.scenarioIds.sort(),
    status: group.observed.length >= 2 ? "observed" as const : "missing" as const,
    passed: group.observed.length >= 2
      ? group.observed.every((scenario) => scenario.passedTraces === scenario.traceCount)
      : null,
  }));
}

export async function createBehaviorProfile(
  inputs: BehaviorRunInput[],
  options: { profileId?: string; now?: () => number; sink?: BehaviorProfileSink } = {},
): Promise<BehaviorProfileResult> {
  if (inputs.length === 0) throw new Error("A behavior profile requires at least one run.");
  const now = options.now ?? Date.now;
  const manifest: BehaviorProfileManifest = {
    schemaVersion: BEHAVIOR_PROFILE_SCHEMA_VERSION,
    kind: "behavior-profile" as const,
    profileId: options.profileId ?? globalThis.crypto.randomUUID(),
    createdAt: new Date(now()).toISOString(),
    mappingSchemaVersion: BEHAVIOR_MAPPING_SCHEMA_VERSION,
    runIds: inputs.map((input) => input.runId),
    provenance: structuredClone(inputs[0].provenance),
  };
  await options.sink?.begin(structuredClone(manifest));
  const traces = inputs.flatMap((input) => input.traces);
  const grouped = new Map<string, BehaviorEvidenceTrace[]>();
  for (const trace of traces) {
    const key = `${trace.scenario.id}@${trace.scenario.version}`;
    grouped.set(key, [...(grouped.get(key) ?? []), trace]);
  }
  const scenarios = [...grouped.values()].map(scenarioProfile)
    .sort((left, right) => left.scenario.id.localeCompare(right.scenario.id));
  const checks = profileChecks(inputs);
  const result: BehaviorProfileResult = {
    manifest,
    completedAt: new Date(now()).toISOString(),
    checks,
    dimensions: combineDimensions(scenarios),
    resources: resources(traces),
    scenarios,
    metamorphicGroups: metamorphicGroups(scenarios),
    passed: checks.every((entry) => entry.passed),
  };
  await options.sink?.finish(structuredClone(result));
  return result;
}

function completionEvidence(trace: LabTrialTrace): BehaviorEvidenceTrace {
  const usage = trace.outcome.kind === "completion" ? trace.outcome.response.usage : null;
  return {
    runId: trace.runId,
    traceId: String(trace.trial),
    scenario: structuredClone(trace.scenario),
    provenance: structuredClone(trace.provenance),
    checks: structuredClone(trace.checks),
    passed: trace.passed,
    durationMs: trace.durationMs,
    toolCalls: trace.outcome.kind === "completion" ? trace.outcome.response.toolCalls?.length ?? 0 : 0,
    inputTokens: usage?.inputTokens ?? null,
    outputTokens: usage?.outputTokens ?? null,
  };
}

function episodeEvidence(trace: SandboxEpisodeTrace): BehaviorEvidenceTrace {
  const inputUsage = trace.rounds.map((round) => round.response.usage?.inputTokens);
  const outputUsage = trace.rounds.map((round) => round.response.usage?.outputTokens);
  return {
    runId: trace.run?.id ?? trace.episodeId,
    traceId: trace.episodeId,
    scenario: structuredClone(trace.scenario),
    provenance: structuredClone(trace.provenance),
    checks: structuredClone(trace.checks),
    passed: trace.passed,
    durationMs: trace.rounds.reduce((total, round) => total + round.durationMs, 0),
    toolCalls: trace.rounds.reduce((total, round) => total + round.toolExecutions.length, 0),
    inputTokens: inputUsage.every((value) => value === undefined)
      ? null
      : inputUsage.reduce<number>((total, value) => total + (value ?? 0), 0),
    outputTokens: outputUsage.every((value) => value === undefined)
      ? null
      : outputUsage.reduce<number>((total, value) => total + (value ?? 0), 0),
  };
}

export async function loadBehaviorRunInput(runId: string): Promise<BehaviorRunInput> {
  const directory = labRunArtifactDirectory(runId);
  const manifest = JSON.parse(await readFile(path.join(directory, "manifest.json"), "utf8")) as
    LabRunManifest | SandboxEpisodeRunManifest;
  if ((manifest as SandboxEpisodeRunManifest).kind === "sandbox-episode-run") {
    const episodeManifest = manifest as SandboxEpisodeRunManifest;
    const summary = JSON.parse(await readFile(path.join(directory, "summary.json"), "utf8")) as
      SandboxEpisodeRunSummary;
    const traces = await Promise.all(summary.episodes.map(async (episode) => {
      const content = await readFile(
        path.join(directory, "episodes", episode.episodeId, "episode.json"),
        "utf8",
      );
      return episodeEvidence(JSON.parse(content) as SandboxEpisodeTrace);
    }));
    return {
      runId,
      scenario: structuredClone(episodeManifest.scenario),
      provenance: structuredClone(episodeManifest.provenance),
      traces,
    };
  }
  const completionManifest = manifest as LabRunManifest;
  const summary = JSON.parse(await readFile(path.join(directory, "summary.json"), "utf8")) as {
    totalCount: number;
  };
  const traces = await Promise.all(Array.from({ length: summary.totalCount }, async (_, index) => {
    const fileName = `${String(index + 1).padStart(4, "0")}.json`;
    return completionEvidence(JSON.parse(
      await readFile(path.join(directory, "trials", fileName), "utf8"),
    ) as LabTrialTrace);
  }));
  return {
    runId,
    scenario: structuredClone(completionManifest.scenario),
    provenance: structuredClone(completionManifest.provenance),
    traces,
  };
}

function scenarioDimensionRates(
  profile: BehaviorProfileResult,
  dimension: BehaviorDimension,
): Map<string, number> {
  return new Map(profile.scenarios.flatMap((scenario) => {
    const value = scenario.dimensions[dimension];
    return value.passRate === null ? [] : [[
      `${scenario.scenario.id}@${scenario.scenario.version}`,
      value.passRate,
    ] as const];
  }));
}

export async function createBehaviorDifferential(
  left: BehaviorProfileResult,
  right: BehaviorProfileResult,
  options: { differentialId?: string; now?: () => number; sink?: BehaviorDifferentialSink } = {},
): Promise<BehaviorDifferentialResult> {
  const now = options.now ?? Date.now;
  const manifest: BehaviorDifferentialManifest = {
    schemaVersion: BEHAVIOR_DIFFERENTIAL_SCHEMA_VERSION,
    kind: "behavior-differential" as const,
    differentialId: options.differentialId ?? globalThis.crypto.randomUUID(),
    createdAt: new Date(now()).toISOString(),
    leftProfileId: left.manifest.profileId,
    rightProfileId: right.manifest.profileId,
  };
  await options.sink?.begin(structuredClone(manifest));
  const dimensions = BEHAVIOR_DIMENSIONS.map((dimension) => {
    const leftRates = scenarioDimensionRates(left, dimension);
    const rightRates = scenarioDimensionRates(right, dimension);
    const common = [...leftRates.keys()].filter((key) => rightRates.has(key));
    if (common.length === 0) {
      return {
        dimension,
        status: "missing" as const,
        leftPassRate: null,
        rightPassRate: null,
        delta: null,
        commonScenarioCount: 0,
      };
    }
    const leftPassRate = common.reduce((total, key) => total + (leftRates.get(key) ?? 0), 0) /
      common.length;
    const rightPassRate = common.reduce((total, key) => total + (rightRates.get(key) ?? 0), 0) /
      common.length;
    return {
      dimension,
      status: "comparable" as const,
      leftPassRate,
      rightPassRate,
      delta: rightPassRate - leftPassRate,
      commonScenarioCount: common.length,
    };
  });
  const result: BehaviorDifferentialResult = {
    manifest,
    completedAt: new Date(now()).toISOString(),
    dimensions,
    interpretation:
      "Descriptive paired-scenario differences only. Missing dimensions remain missing, and no " +
      "statistical, causal, stability, or product-ranking claim is implied.",
  };
  await options.sink?.finish(structuredClone(result));
  return result;
}
