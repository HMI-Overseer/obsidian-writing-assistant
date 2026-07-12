import type { LabCheck, LabRunProvenance } from "../lab/types";

export const BEHAVIOR_MAPPING_SCHEMA_VERSION = 1;
export const BEHAVIOR_PROFILE_SCHEMA_VERSION = 1;
export const BEHAVIOR_DIFFERENTIAL_SCHEMA_VERSION = 1;

export type BehaviorScenarioFamily =
  | "control"
  | "protocol"
  | "agentic"
  | "state-memory"
  | "writing";

export type BehaviorDimension =
  | "correctness"
  | "safety-scope"
  | "protocol-reliability"
  | "state-awareness"
  | "recovery"
  | "writing-quality"
  | "voice-preservation"
  | "user-effort"
  | "efficiency"
  | "robustness";

export const BEHAVIOR_DIMENSIONS: BehaviorDimension[] = [
  "correctness",
  "safety-scope",
  "protocol-reliability",
  "state-awareness",
  "recovery",
  "writing-quality",
  "voice-preservation",
  "user-effort",
  "efficiency",
  "robustness",
];

export interface BehaviorMapping {
  schemaVersion: typeof BEHAVIOR_MAPPING_SCHEMA_VERSION;
  scenario: { id: string; version: number };
  family: BehaviorScenarioFamily;
  checks: Record<string, BehaviorDimension[]>;
  metamorphicGroup?: {
    id: string;
    transformation: string;
  };
}

export interface BehaviorEvidenceTrace {
  runId: string;
  traceId: string;
  scenario: { id: string; version: number; title: string };
  provenance: LabRunProvenance;
  checks: LabCheck[];
  passed: boolean;
  durationMs: number;
  toolCalls: number;
  inputTokens: number | null;
  outputTokens: number | null;
}

export interface BehaviorRunInput {
  runId: string;
  scenario: { id: string; version: number; title: string };
  provenance: LabRunProvenance;
  traces: BehaviorEvidenceTrace[];
}

export interface BehaviorCheckAggregate {
  status: "observed" | "missing";
  evidenceCount: number;
  passCount: number;
  passRate: number | null;
}

export interface BehaviorResourceAggregate {
  traceCount: number;
  durationMs: { total: number; mean: number | null };
  toolCalls: { total: number; mean: number | null };
  inputTokens: { total: number; observedTraces: number };
  outputTokens: { total: number; observedTraces: number };
}

export interface BehaviorScenarioProfile {
  scenario: { id: string; version: number; title: string };
  family: BehaviorScenarioFamily;
  runIds: string[];
  traceCount: number;
  passedTraces: number;
  dimensions: Record<BehaviorDimension, BehaviorCheckAggregate>;
  resources: BehaviorResourceAggregate;
}

export interface BehaviorProfileManifest {
  schemaVersion: typeof BEHAVIOR_PROFILE_SCHEMA_VERSION;
  kind: "behavior-profile";
  profileId: string;
  createdAt: string;
  mappingSchemaVersion: typeof BEHAVIOR_MAPPING_SCHEMA_VERSION;
  runIds: string[];
  provenance: LabRunProvenance;
}

export interface BehaviorProfileResult {
  manifest: BehaviorProfileManifest;
  completedAt: string;
  checks: LabCheck[];
  dimensions: Record<BehaviorDimension, BehaviorCheckAggregate>;
  resources: BehaviorResourceAggregate;
  scenarios: BehaviorScenarioProfile[];
  metamorphicGroups: Array<{
    id: string;
    transformation: string;
    scenarioIds: string[];
    status: "observed" | "missing";
    passed: boolean | null;
  }>;
  passed: boolean;
}

export interface BehaviorProfileSink {
  begin(manifest: BehaviorProfileManifest): Promise<void>;
  finish(result: BehaviorProfileResult): Promise<void>;
}

export interface BehaviorDifferentialManifest {
  schemaVersion: typeof BEHAVIOR_DIFFERENTIAL_SCHEMA_VERSION;
  kind: "behavior-differential";
  differentialId: string;
  createdAt: string;
  leftProfileId: string;
  rightProfileId: string;
}

export interface BehaviorDifferentialResult {
  manifest: BehaviorDifferentialManifest;
  completedAt: string;
  dimensions: Array<{
    dimension: BehaviorDimension;
    status: "comparable" | "missing";
    leftPassRate: number | null;
    rightPassRate: number | null;
    delta: number | null;
    commonScenarioCount: number;
  }>;
  interpretation: string;
}

export interface BehaviorDifferentialSink {
  begin(manifest: BehaviorDifferentialManifest): Promise<void>;
  finish(result: BehaviorDifferentialResult): Promise<void>;
}
