import { readFile } from "node:fs/promises";
import type { ChatClient } from "../../src/api/chatClient";
import type { LabRunProvenance } from "../lab/types";
import { resolveBehaviorCheckDimensions } from "../behavior/registry";
import { resolveResponseNormalizer } from "../candidates/registry";
import { applyCompatibilityPolicy } from "../candidates/compatibilityPolicy";
import { resolveCompatibilityPolicy } from "../candidates/compatibilityRegistry";
import { resolveEpisode } from "../episodes/registry";
import { normalizeSyntheticPath } from "../sandbox/syntheticVault";
import { runSandboxEpisode } from "../sandbox/episodeRunner";
import type { SandboxEpisodeScenario, SandboxEpisodeTrace } from "../sandbox/types";
import { openHeldoutPack, sealHeldoutEvidence } from "./heldout";
import { runOptimizationExperiment } from "./runner";
import type {
  HeldoutSandboxCase,
  OptimizationArtifactSink,
  OptimizationCaseDescriptor,
  OptimizationCondition,
  OptimizationExperimentResult,
  OptimizationExperimentSpec,
  OptimizationGate,
  OptimizationScheduleItem,
  OptimizationTrialObservation,
  SealedHeldoutPack,
} from "./types";

export interface OptimizationFileConfig {
  schemaVersion: 1;
  seed: number;
  iterations: number;
  bootstrapSamples: number;
  confidenceLevel: number;
  developmentEpisodes: Array<{ id: string; qualitative: boolean }>;
  heldoutPackPath: string;
  conditions: [OptimizationCondition, OptimizationCondition];
  bounds: OptimizationExperimentSpec["bounds"];
  gates: OptimizationGate[];
  qualitativeRubric: string[];
}

export async function loadOptimizationFileConfig(filePath: string): Promise<OptimizationFileConfig> {
  const config = JSON.parse(await readFile(filePath, "utf8")) as OptimizationFileConfig;
  if (config.schemaVersion !== 1) {
    throw new Error(`Unsupported optimization configuration schema ${config.schemaVersion}.`);
  }
  return config;
}

export async function loadSealedHeldoutPack(filePath: string): Promise<SealedHeldoutPack> {
  const pack = JSON.parse(await readFile(filePath, "utf8")) as SealedHeldoutPack;
  if (pack.manifest.kind !== "sealed-heldout-pack") {
    throw new Error("Optimization held-out input is not a sealed pack.");
  }
  return pack;
}

function heldoutScenario(entry: HeldoutSandboxCase, modelId: string): SandboxEpisodeScenario {
  return {
    schemaVersion: 1,
    id: `heldout-${entry.opaqueId}`,
    version: 1,
    title: entry.title,
    description: "Protected held-out optimization case.",
    modelId,
    samplingParams: structuredClone(entry.samplingParams),
    fixture: structuredClone(entry.fixture),
    request: {
      systemPrompt: entry.request.systemPrompt,
      documentContext: null,
      ragContext: null,
      messages: [{ role: "user", content: entry.request.userPrompt }],
    },
    evaluators: [
      {
        id: "heldout-tool-use",
        label: "The required sealed-case tool target was used",
        evaluate: ({ rounds }) => rounds.some((round) => round.toolExecutions.some(({ call }) => {
          if (call.name !== entry.expected.toolName || typeof call.arguments.path !== "string") {
            return false;
          }
          const actual = normalizeSyntheticPath(call.arguments.path);
          const expected = normalizeSyntheticPath(entry.expected.path);
          return actual.ok && expected.ok && actual.path === expected.path;
        })),
      },
      {
        id: "heldout-grounded-answer",
        label: "The answer contains every sealed expected term",
        evaluate: ({ finalText }) => entry.expected.finalTextIncludes.every((term) =>
          finalText.toLocaleLowerCase().includes(term.toLocaleLowerCase())),
      },
      {
        id: "heldout-control-cleanliness",
        label: "The response satisfies the sealed protocol-cleanliness invariant",
        evaluate: ({ rounds }) => !entry.expected.forbidControlTokens || !rounds.some((round) =>
          round.response.text.includes("<|channel>") ||
          round.response.text.includes("<channel|>")),
      },
    ],
  };
}

function totalUsage(
  trace: SandboxEpisodeTrace,
  key: "inputTokens" | "outputTokens",
): number | null {
  const values = trace.rounds.map((round) => round.response.usage?.[key]);
  return values.every((value) => value === undefined)
    ? null
    : values.reduce<number>((total, value) => total + (value ?? 0), 0);
}

function heldoutDimensions(checkId: string): import("../behavior/types").BehaviorDimension[] {
  switch (checkId) {
    case "heldout-tool-use":
      return ["protocol-reliability"];
    case "heldout-grounded-answer":
      return ["correctness", "state-awareness"];
    case "heldout-control-cleanliness":
      return ["protocol-reliability"];
    case "read-only-state-unchanged":
      return ["safety-scope"];
    case "episode-completed":
      return ["protocol-reliability", "efficiency"];
    default:
      return [];
  }
}

function trialObservation(args: {
  experimentId: string;
  item: OptimizationScheduleItem;
  trace: SandboxEpisodeTrace;
  heldoutKey: string;
  qualitative: boolean;
}): OptimizationTrialObservation {
  const heldout = args.item.visibility === "heldout";
  const checks = args.trace.checks.map((check) => ({
    ...structuredClone(check),
    ...(heldout ? { detail: undefined } : {}),
    dimensions: heldout
      ? heldoutDimensions(check.id)
      : resolveBehaviorCheckDimensions(
        args.trace.scenario.id,
        args.trace.scenario.version,
        check.id,
      ),
  }));
  const evaluatorValid = checks.every((check) =>
    (!check.required || check.dimensions.length > 0) &&
    !check.detail?.startsWith("Episode evaluator failed") &&
    !check.detail?.startsWith("State evaluator failed"));
  return {
    experimentId: args.experimentId,
    ...structuredClone(args.item),
    checks,
    evaluatorValid,
    resources: {
      durationMs: args.trace.rounds.reduce((total, round) => total + round.durationMs, 0),
      toolCalls: args.trace.rounds.reduce(
        (total, round) => total + round.toolExecutions.length,
        0,
      ),
      inputTokens: totalUsage(args.trace, "inputTokens"),
      outputTokens: totalUsage(args.trace, "outputTokens"),
    },
    qualitativeOutput: !heldout && args.qualitative ? args.trace.finalText : null,
    sealedEvidence: heldout ? sealHeldoutEvidence(args.trace, args.heldoutKey) : null,
    publicEvidence: heldout ? null : structuredClone(args.trace),
  };
}

function resolveNormalizer(
  condition: OptimizationCondition,
  provenance: LabRunProvenance,
): import("../sandbox/types").SandboxResponseNormalizer | undefined {
  if (condition.responseNormalizerId && condition.compatibilityPolicyId) {
    throw new Error(`Condition ${JSON.stringify(condition.id)} selects two normalizer paths.`);
  }
  if (condition.responseNormalizerId) {
    return resolveResponseNormalizer(condition.responseNormalizerId);
  }
  if (condition.compatibilityPolicyId) {
    return applyCompatibilityPolicy(
      resolveCompatibilityPolicy(condition.compatibilityPolicyId),
      provenance,
    ).responseNormalizer;
  }
  return undefined;
}

export async function runConfiguredOptimization(args: {
  config: OptimizationFileConfig;
  pack: SealedHeldoutPack;
  heldoutKey: string;
  client: ChatClient;
  provenance: LabRunProvenance;
  artifactSink?: OptimizationArtifactSink;
}): Promise<OptimizationExperimentResult> {
  const modelId = args.provenance.subject.modelId;
  const heldoutCases = openHeldoutPack(args.pack, args.heldoutKey);
  const scenarios = new Map<string, { scenario: SandboxEpisodeScenario; qualitative: boolean }>();
  const cases: OptimizationCaseDescriptor[] = [];
  for (const configured of args.config.developmentEpisodes) {
    const scenario = resolveEpisode(configured.id, modelId);
    scenarios.set(configured.id, { scenario, qualitative: configured.qualitative });
    cases.push({
      id: configured.id,
      visibility: "development",
      family: "agentic",
      dimensions: [],
      qualitative: configured.qualitative,
      scenario: { id: scenario.id, version: scenario.version },
    });
  }
  for (const entry of heldoutCases) {
    scenarios.set(entry.opaqueId, {
      scenario: heldoutScenario(entry, modelId),
      qualitative: false,
    });
    cases.push({
      id: entry.opaqueId,
      visibility: "heldout",
      family: entry.family,
      dimensions: structuredClone(entry.dimensions),
      qualitative: false,
    });
  }
  const normalizers = new Map(args.config.conditions.map((condition) => [
    condition.id,
    resolveNormalizer(condition, args.provenance),
  ]));
  const spec: OptimizationExperimentSpec = {
    seed: args.config.seed,
    iterations: args.config.iterations,
    bootstrapSamples: args.config.bootstrapSamples,
    confidenceLevel: args.config.confidenceLevel,
    cases,
    heldoutPack: structuredClone(args.pack.manifest),
    conditions: structuredClone(args.config.conditions),
    bounds: structuredClone(args.config.bounds),
    gates: structuredClone(args.config.gates),
    provenance: structuredClone(args.provenance),
    qualitativeRubric: structuredClone(args.config.qualitativeRubric),
  };
  return runOptimizationExperiment(spec, async (item, manifest) => {
    const configured = scenarios.get(item.caseId);
    if (!configured) throw new Error(`No optimization scenario for ${JSON.stringify(item.caseId)}.`);
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort(new Error(`Optimization trial exceeded ${manifest.bounds.timeoutMs} ms.`));
    }, manifest.bounds.timeoutMs);
    try {
      const trace = await runSandboxEpisode(args.client, configured.scenario, {
        ...manifest.bounds,
        signal: controller.signal,
        provenance: args.provenance,
        responseNormalizer: normalizers.get(item.conditionId),
        createEpisodeId: () => `${manifest.experimentId}-${String(item.sequence).padStart(4, "0")}`,
        run: { id: manifest.experimentId, iteration: item.sequence },
      });
      return trialObservation({
        experimentId: manifest.experimentId,
        item,
        trace,
        heldoutKey: args.heldoutKey,
        qualitative: configured.qualitative,
      });
    } finally {
      clearTimeout(timer);
    }
  }, { artifactSink: args.artifactSink });
}
