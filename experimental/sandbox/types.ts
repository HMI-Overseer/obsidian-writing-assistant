import type { CompletionResult } from "../../src/api/usageTypes";
import type { ChatRequest } from "../../src/shared/chatRequest";
import type { SamplingParams } from "../../src/shared/types";
import type { ToolCall, ToolResult } from "../../src/tools/types";
import type { LabCheck } from "../lab/types";
import type { LabRunProvenance } from "../lab/types";

export const SANDBOX_FIXTURE_SCHEMA_VERSION = 1;
export const SANDBOX_EPISODE_TRACE_SCHEMA_VERSION = 5;
export const SANDBOX_EPISODE_RUN_SCHEMA_VERSION = 2;

export interface SyntheticVaultFile {
  path: string;
  content: string;
}

export interface SyntheticVaultFixture {
  schemaVersion: typeof SANDBOX_FIXTURE_SCHEMA_VERSION;
  id: string;
  version: number;
  description: string;
  files: SyntheticVaultFile[];
}

export interface SyntheticVaultSnapshotFile {
  path: string;
  content: string;
  sha256: string;
}

export interface SyntheticVaultSnapshot {
  fixtureId: string;
  fixtureVersion: number;
  files: SyntheticVaultSnapshotFile[];
}

export interface SandboxToolExecution {
  call: ToolCall;
  result: ToolResult;
  snapshotBefore: SyntheticVaultSnapshot;
  snapshotAfter: SyntheticVaultSnapshot;
  review: SandboxMutationReview | null;
}

export type SandboxWriteDisposition = "applied" | "declined" | "failed";

export interface SandboxWriteReviewPolicy {
  disposition: SandboxWriteDisposition;
  reason: string;
}

export interface SandboxMutationReview {
  proposal: {
    kind: "write-file";
    path: string;
    content: string;
    previousContent: string | null;
  };
  disposition: SandboxWriteDisposition;
  reason: string;
  applied: boolean;
}

export interface SyntheticVaultDiff {
  created: SyntheticVaultSnapshotFile[];
  modified: Array<{ before: SyntheticVaultSnapshotFile; after: SyntheticVaultSnapshotFile }>;
  deleted: SyntheticVaultSnapshotFile[];
}

export interface SandboxEpisodeRound {
  round: number;
  request: ChatRequest;
  rawResponse: CompletionResult;
  response: CompletionResult;
  durationMs: number;
  normalization: {
    changed: boolean;
  };
  toolExecutions: SandboxToolExecution[];
}

export interface SandboxResponseNormalizer {
  id: string;
  version: number;
  normalize(request: ChatRequest, response: CompletionResult): CompletionResult;
}

export type SandboxEpisodeOutcome =
  | { kind: "completed" }
  | { kind: "round-limit"; limit: number }
  | { kind: "tool-call-limit"; limit: number }
  | { kind: "repeated-tool-call-limit"; limit: number }
  | { kind: "token-limit"; limit: number }
  | { kind: "output-limit"; limit: number }
  | { kind: "error"; name: string; message: string };

export interface SandboxStateEvaluator {
  id: string;
  label: string;
  required?: boolean;
  evaluate: (
    initial: SyntheticVaultSnapshot,
    final: SyntheticVaultSnapshot,
  ) => boolean | { passed: boolean; detail?: string };
}

export interface SandboxEpisodeEvaluationContext {
  rounds: SandboxEpisodeRound[];
  finalText: string;
  initialSnapshot: SyntheticVaultSnapshot;
  finalSnapshot: SyntheticVaultSnapshot;
  outcome: SandboxEpisodeOutcome;
}

export interface SandboxEpisodeEvaluator {
  id: string;
  label: string;
  required?: boolean;
  evaluate: (
    context: SandboxEpisodeEvaluationContext,
  ) => boolean | { passed: boolean; detail?: string };
}

export interface SandboxEpisodeScenario {
  schemaVersion: 1;
  id: string;
  version: number;
  title: string;
  description: string;
  modelId: string;
  samplingParams: SamplingParams;
  fixture: SyntheticVaultFixture;
  request: ChatRequest;
  writeReview?: SandboxWriteReviewPolicy;
  stateEvaluators?: SandboxStateEvaluator[];
  evaluators?: SandboxEpisodeEvaluator[];
}

export interface SandboxEpisodeOptions {
  maxRounds?: number;
  maxToolCalls?: number;
  maxRepeatedToolCalls?: number;
  maxTotalTokens?: number;
  maxOutputChars?: number;
  signal?: AbortSignal;
  createEpisodeId?: () => string;
  now?: () => number;
  provenance?: LabRunProvenance;
  responseNormalizer?: SandboxResponseNormalizer;
  compatibilityPolicy?: {
    id: string;
    version: number;
    matchedBy: { kind: "model-id" | "chat-template"; value: string };
  };
  run?: {
    id: string;
    iteration: number;
  };
}

export interface SandboxEpisodeTrace {
  schemaVersion: typeof SANDBOX_EPISODE_TRACE_SCHEMA_VERSION;
  kind: "sandbox-episode";
  episodeId: string;
  run: {
    id: string;
    iteration: number;
  } | null;
  startedAt: string;
  completedAt: string;
  scenario: {
    id: string;
    version: number;
    title: string;
  };
  conditions: {
    modelId: string;
    samplingParams: SamplingParams;
    maxRounds: number;
    maxToolCalls: number;
    maxRepeatedToolCalls: number;
    maxTotalTokens: number;
    maxOutputChars: number;
    responseNormalization: { id: string; version: number } | null;
    compatibilityPolicy: {
      id: string;
      version: number;
      matchedBy: { kind: "model-id" | "chat-template"; value: string };
    } | null;
    writeReview: SandboxWriteReviewPolicy | null;
  };
  provenance: LabRunProvenance;
  fixture: {
    id: string;
    version: number;
  };
  initialSnapshot: SyntheticVaultSnapshot;
  rounds: SandboxEpisodeRound[];
  finalSnapshot: SyntheticVaultSnapshot;
  stateDiff: SyntheticVaultDiff;
  finalText: string;
  outcome: SandboxEpisodeOutcome;
  checks: LabCheck[];
  passed: boolean;
}

export interface SandboxEpisodeRunManifest {
  schemaVersion: typeof SANDBOX_EPISODE_RUN_SCHEMA_VERSION;
  kind: "sandbox-episode-run";
  runId: string;
  startedAt: string;
  scenario: {
    id: string;
    version: number;
    title: string;
    description: string;
  };
  fixture: {
    id: string;
    version: number;
  };
  conditions: {
    iterations: number;
    timeoutMs: number;
    maxRounds: number;
    maxToolCalls: number;
    maxRepeatedToolCalls: number;
    maxTotalTokens: number;
    maxOutputChars: number;
    samplingParams: SamplingParams;
    responseNormalization: { id: string; version: number } | null;
    compatibilityPolicy: {
      id: string;
      version: number;
      matchedBy: { kind: "model-id" | "chat-template"; value: string };
    } | null;
    writeReview: SandboxWriteReviewPolicy | null;
  };
  provenance: LabRunProvenance;
}

export interface SandboxEpisodeRunSummary {
  schemaVersion: typeof SANDBOX_EPISODE_RUN_SCHEMA_VERSION;
  kind: "sandbox-episode-run-summary";
  runId: string;
  completedAt: string;
  requestedCount: number;
  completedCount: number;
  passCount: number;
  normalization: { episodeCount: number; roundCount: number };
  rawLeakage: { episodeCount: number; roundCount: number };
  timingMs: {
    total: number;
    minimum: number | null;
    maximum: number | null;
    mean: number | null;
  };
  toolCalls: { total: number; minimum: number | null; maximum: number | null; mean: number | null };
  usage: {
    inputTokens: number;
    outputTokens: number;
    episodesWithInputUsage: number;
    episodesWithOutputUsage: number;
  };
  outcomes: Record<string, number>;
  episodes: Array<{
    iteration: number;
    episodeId: string;
    passed: boolean;
    outcome: SandboxEpisodeOutcome["kind"];
    durationMs: number;
    toolCalls: number;
    inputTokens: number | null;
    outputTokens: number | null;
    normalizedRounds: number;
    rawLeakageRounds: number;
    failedChecks: Array<{ id: string; label: string; detail?: string }>;
  }>;
}

export interface SandboxEpisodeRunResult {
  runId: string;
  manifest: SandboxEpisodeRunManifest;
  traces: SandboxEpisodeTrace[];
  summary: SandboxEpisodeRunSummary;
}

export interface SandboxEpisodeArtifactSink {
  begin(manifest: SandboxEpisodeRunManifest): Promise<void>;
  write(trace: SandboxEpisodeTrace): Promise<void>;
  finish(result: SandboxEpisodeRunResult): Promise<void>;
}

export interface SandboxEpisodeRunOptions {
  iterations?: number;
  timeoutMs?: number;
  maxRounds?: number;
  maxToolCalls?: number;
  maxRepeatedToolCalls?: number;
  maxTotalTokens?: number;
  maxOutputChars?: number;
  signal?: AbortSignal;
  artifactSink?: SandboxEpisodeArtifactSink;
  createRunId?: () => string;
  createEpisodeId?: (iteration: number) => string;
  now?: () => number;
  provenance?: LabRunProvenance;
  responseNormalizer?: SandboxResponseNormalizer;
  compatibilityPolicy?: SandboxEpisodeOptions["compatibilityPolicy"];
}
