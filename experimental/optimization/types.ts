import type { SamplingParams } from "../../src/shared/types";
import type { LabCheck, LabRunProvenance } from "../lab/types";
import type { BehaviorDimension, BehaviorScenarioFamily } from "../behavior/types";
import type { SyntheticVaultFixture } from "../sandbox/types";

export const HELDOUT_PACK_SCHEMA_VERSION = 1;
export const OPTIMIZATION_EXPERIMENT_SCHEMA_VERSION = 1;

export interface HeldoutCasePublicDescriptor {
  opaqueId: string;
  family: BehaviorScenarioFamily;
  dimensions: BehaviorDimension[];
  qualitative: boolean;
}

export interface HeldoutPackPublicManifest {
  schemaVersion: typeof HELDOUT_PACK_SCHEMA_VERSION;
  kind: "sealed-heldout-pack";
  packId: string;
  caseCount: number;
  cases: HeldoutCasePublicDescriptor[];
  payloadSha256: string;
}

export interface HeldoutSandboxCase {
  schemaVersion: 1;
  opaqueId: string;
  family: BehaviorScenarioFamily;
  dimensions: BehaviorDimension[];
  qualitative: boolean;
  title: string;
  fixture: SyntheticVaultFixture;
  samplingParams: SamplingParams;
  request: {
    systemPrompt: string;
    userPrompt: string;
  };
  expected: {
    toolName: "read_file";
    path: string;
    finalTextIncludes: string[];
    forbidControlTokens: boolean;
  };
}

export interface SealedHeldoutPack {
  manifest: HeldoutPackPublicManifest;
  encryption: {
    algorithm: "aes-256-gcm";
    iv: string;
    authTag: string;
    ciphertext: string;
  };
}

export type OptimizationVisibility = "development" | "heldout";
export type OptimizationConditionRole = "baseline" | "candidate";

export interface OptimizationCaseDescriptor {
  id: string;
  visibility: OptimizationVisibility;
  family: BehaviorScenarioFamily;
  dimensions: BehaviorDimension[];
  qualitative: boolean;
  scenario?: { id: string; version: number };
}

export interface OptimizationCondition {
  id: string;
  role: OptimizationConditionRole;
  component: string;
  delta: string;
  responseNormalizerId?: string;
  compatibilityPolicyId?: string;
}

export type OptimizationGate =
  | {
    id: string;
    kind: "minimum-improvement";
    dimension: BehaviorDimension;
    minimumDelta: number;
    minimumPairs: number;
    requireCiLowerBound?: boolean;
    visibility: "all" | OptimizationVisibility;
  }
  | {
    id: string;
    kind: "maximum-regression";
    dimension: BehaviorDimension;
    maximumRegression: number;
    minimumPairs: number;
    visibility: "all" | OptimizationVisibility;
  }
  | {
    id: string;
    kind: "zero-candidate-failures";
    dimension: BehaviorDimension;
    visibility: "all" | OptimizationVisibility;
  }
  | {
    id: string;
    kind: "resource-ratio";
    resource: "durationMs" | "toolCalls" | "inputTokens" | "outputTokens";
    maximumRatio: number;
  }
  | {
    id: string;
    kind: "heldout-required";
    minimumCases: number;
  }
  | {
    id: string;
    kind: "evaluator-validity";
  }
  | {
    id: string;
    kind: "human-approval";
  };

export interface OptimizationScheduleItem {
  sequence: number;
  pairId: string;
  caseId: string;
  visibility: OptimizationVisibility;
  iteration: number;
  conditionId: string;
  role: OptimizationConditionRole;
}

export interface OptimizationExperimentManifest {
  schemaVersion: typeof OPTIMIZATION_EXPERIMENT_SCHEMA_VERSION;
  kind: "optimization-experiment";
  experimentId: string;
  startedAt: string;
  seed: number;
  iterations: number;
  bootstrapSamples: number;
  confidenceLevel: number;
  cases: OptimizationCaseDescriptor[];
  heldoutPack: HeldoutPackPublicManifest | null;
  conditions: [OptimizationCondition, OptimizationCondition];
  bounds: {
    timeoutMs: number;
    maxRounds: number;
    maxToolCalls: number;
    maxRepeatedToolCalls: number;
    maxTotalTokens: number;
    maxOutputChars: number;
  };
  gates: OptimizationGate[];
  schedule: OptimizationScheduleItem[];
  provenance: LabRunProvenance;
}

export interface OptimizationTrialObservation {
  experimentId: string;
  sequence: number;
  pairId: string;
  caseId: string;
  visibility: OptimizationVisibility;
  iteration: number;
  conditionId: string;
  role: OptimizationConditionRole;
  checks: Array<LabCheck & { dimensions: BehaviorDimension[] }>;
  evaluatorValid: boolean;
  resources: {
    durationMs: number;
    toolCalls: number;
    inputTokens: number | null;
    outputTokens: number | null;
  };
  qualitativeOutput: string | null;
  sealedEvidence: string | null;
  publicEvidence: unknown | null;
}

export interface OptimizationDimensionEffect {
  dimension: BehaviorDimension;
  visibility: "all" | OptimizationVisibility;
  pairCount: number;
  baselinePassRate: number | null;
  candidatePassRate: number | null;
  delta: number | null;
  confidenceInterval: { lower: number; upper: number } | null;
  classification: "improvement" | "regression" | "unchanged" | "inconclusive";
}

export interface OptimizationResourceComparison {
  resource: "durationMs" | "toolCalls" | "inputTokens" | "outputTokens";
  baselineMean: number | null;
  candidateMean: number | null;
  ratio: number | null;
  delta: number | null;
}

export interface OptimizationGateResult {
  id: string;
  passed: boolean;
  pendingHumanApproval: boolean;
  detail: string;
}

export interface BlindQualitativePacket {
  schemaVersion: 1;
  kind: "blind-qualitative-packet";
  experimentId: string;
  createdAt: string;
  rubric: string[];
  pairs: Array<{
    blindPairId: string;
    caseId: string;
    iteration: number;
    responseA: string;
    responseB: string;
  }>;
}

export interface OptimizationExperimentResult {
  manifest: OptimizationExperimentManifest;
  completedAt: string;
  trials: OptimizationTrialObservation[];
  effects: OptimizationDimensionEffect[];
  resources: OptimizationResourceComparison[];
  gates: OptimizationGateResult[];
  regressions: OptimizationDimensionEffect[];
  blindPacket: BlindQualitativePacket;
  blindAssignments: Array<{
    blindPairId: string;
    responseAConditionId: string;
    responseBConditionId: string;
  }>;
  recommendation: "rejected" | "awaiting-human-approval";
}

export interface BlindQualitativeJudgment {
  blindPairId: string;
  winner: "A" | "B" | "tie";
  rubric: Record<string, "A" | "B" | "tie">;
  rationale?: string;
}

export interface BlindQualitativeResult {
  experimentId: string;
  judgedPairs: number;
  candidateWins: number;
  baselineWins: number;
  ties: number;
  rubric: Record<string, {
    candidateWins: number;
    baselineWins: number;
    ties: number;
  }>;
  humanApproved: boolean;
  reviewer: string;
  reviewedAt: string;
}

export interface OptimizationArtifactSink {
  begin(manifest: OptimizationExperimentManifest): Promise<void>;
  write(trial: OptimizationTrialObservation): Promise<void>;
  finish(result: OptimizationExperimentResult): Promise<void>;
}

export interface OptimizationExperimentSpec {
  experimentId?: string;
  seed: number;
  iterations: number;
  bootstrapSamples: number;
  confidenceLevel: number;
  cases: OptimizationCaseDescriptor[];
  heldoutPack?: HeldoutPackPublicManifest;
  conditions: [OptimizationCondition, OptimizationCondition];
  bounds: OptimizationExperimentManifest["bounds"];
  gates: OptimizationGate[];
  provenance: LabRunProvenance;
  qualitativeRubric: string[];
}

export type OptimizationTrialExecutor = (
  item: OptimizationScheduleItem,
  manifest: OptimizationExperimentManifest,
) => Promise<OptimizationTrialObservation>;
