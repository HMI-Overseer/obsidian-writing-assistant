import type { ChatClient } from "../../src/api/chatClient";
import type { CompletionResult } from "../../src/api/usageTypes";
import type { ChatRequest } from "../../src/shared/chatRequest";
import type { SamplingParams } from "../../src/shared/types";

export const LAB_TRACE_SCHEMA_VERSION = 1;

export interface LabCheck {
  id: string;
  label: string;
  passed: boolean;
  required: boolean;
  detail?: string;
}

export interface LabObservation {
  request: ChatRequest;
  completion: CompletionResult;
  durationMs: number;
}

export interface LabEvaluator {
  id: string;
  label: string;
  required?: boolean;
  evaluate: (observation: LabObservation) => boolean | { passed: boolean; detail?: string };
}

export interface LabScenario {
  schemaVersion: 1;
  id: string;
  version: number;
  title: string;
  description: string;
  modelId: string;
  samplingParams: SamplingParams;
  request: ChatRequest;
  evaluators: LabEvaluator[];
}

export interface LabRunOptions {
  iterations?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  artifactSink?: LabArtifactSink;
  now?: () => number;
  createRunId?: () => string;
  provenance?: LabRunProvenance;
}

export interface LabArtifactSink {
  begin?(manifest: LabRunManifest): Promise<void>;
  write(trace: LabTrialTrace): Promise<void>;
  finish?(result: LabRunResult): Promise<void>;
}

export type LabRuntimeMetadataValue = string | number | boolean | null;

export interface LabSubject {
  provider: string;
  modelId: string;
  endpoint?: string;
  runtime?: Record<string, LabRuntimeMetadataValue>;
}

export interface LabRunProvenance {
  /** Source revision under test. Null means the caller did not resolve one. */
  sourceRevision: string | null;
  subject: LabSubject;
}

export interface LabRunManifest {
  schemaVersion: typeof LAB_TRACE_SCHEMA_VERSION;
  runId: string;
  startedAt: string;
  scenario: {
    id: string;
    version: number;
    title: string;
    description: string;
  };
  conditions: {
    iterations: number;
    timeoutMs: number;
    samplingParams: SamplingParams;
  };
  provenance: LabRunProvenance;
}

export interface LabCompletionOutcome {
  kind: "completion";
  response: CompletionResult;
}

export interface LabErrorOutcome {
  kind: "error";
  error: {
    name: string;
    message: string;
    timedOut: boolean;
  };
}

export interface LabTrialTrace {
  schemaVersion: typeof LAB_TRACE_SCHEMA_VERSION;
  runId: string;
  trial: number;
  startedAt: string;
  scenario: {
    id: string;
    version: number;
    title: string;
  };
  conditions: {
    modelId: string;
    samplingParams: SamplingParams;
    timeoutMs: number;
  };
  provenance: LabRunProvenance;
  request: ChatRequest;
  durationMs: number;
  outcome: LabCompletionOutcome | LabErrorOutcome;
  checks: LabCheck[];
  passed: boolean;
}

export interface LabRunResult {
  runId: string;
  scenarioId: string;
  manifest: LabRunManifest;
  completedAt: string;
  traces: LabTrialTrace[];
  passCount: number;
  totalCount: number;
}

export interface LabDependencies {
  client: ChatClient;
}
