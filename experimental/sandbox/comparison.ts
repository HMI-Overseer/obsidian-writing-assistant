import { readFile } from "node:fs/promises";
import path from "node:path";
import { labRunArtifactDirectory } from "../lab/fileArtifactSink";
import type { LabCheck } from "../lab/types";
import type { SandboxEpisodeRunManifest, SandboxEpisodeRunSummary } from "./types";

export const SANDBOX_COMPARISON_SCHEMA_VERSION = 1;

export type SandboxComparisonRole =
  | "baseline"
  | "direct-candidate"
  | "policy-candidate"
  | "clean-canary";

export const SANDBOX_COMPARISON_ROLES: SandboxComparisonRole[] = [
  "baseline",
  "direct-candidate",
  "policy-candidate",
  "clean-canary",
];

export interface SandboxComparisonInput {
  role: SandboxComparisonRole;
  manifest: SandboxEpisodeRunManifest;
  summary: SandboxEpisodeRunSummary;
}

export interface SandboxComparisonManifest {
  schemaVersion: typeof SANDBOX_COMPARISON_SCHEMA_VERSION;
  kind: "sandbox-episode-comparison";
  comparisonId: string;
  createdAt: string;
  inputs: Array<{
    role: SandboxComparisonRole;
    runId: string;
    scenario: SandboxEpisodeRunManifest["scenario"];
    fixture: SandboxEpisodeRunManifest["fixture"];
    conditions: SandboxEpisodeRunManifest["conditions"];
    provenance: SandboxEpisodeRunManifest["provenance"];
  }>;
}

export interface SandboxComparisonResult {
  manifest: SandboxComparisonManifest;
  completedAt: string;
  checks: LabCheck[];
  observations: Array<{
    role: SandboxComparisonRole;
    runId: string;
    passCount: number;
    completedCount: number;
    rawLeakageEpisodes: number;
    normalizedEpisodes: number;
    interpretation: "measured" | "expected-diagnostic";
  }>;
  passed: boolean;
}

export interface SandboxComparisonSink {
  begin(manifest: SandboxComparisonManifest): Promise<void>;
  finish(result: SandboxComparisonResult): Promise<void>;
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stable(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function check(id: string, label: string, passed: boolean, detail?: string): LabCheck {
  return { id, label, passed, required: true, ...(detail ? { detail } : {}) };
}

function sameDeclaredBounds(inputs: SandboxComparisonInput[]): boolean {
  const bounds = inputs.map(({ manifest }) => ({
    iterations: manifest.conditions.iterations,
    timeoutMs: manifest.conditions.timeoutMs,
    maxRounds: manifest.conditions.maxRounds,
    maxToolCalls: manifest.conditions.maxToolCalls,
    maxRepeatedToolCalls: manifest.conditions.maxRepeatedToolCalls,
    maxTotalTokens: manifest.conditions.maxTotalTokens,
    maxOutputChars: manifest.conditions.maxOutputChars,
    samplingParams: manifest.conditions.samplingParams,
  }));
  return bounds.every((entry) => stable(entry) === stable(bounds[0]));
}

function roleConfiguration(input: SandboxComparisonInput): boolean {
  const normalization = input.manifest.conditions.responseNormalization;
  const policy = input.manifest.conditions.compatibilityPolicy;
  switch (input.role) {
    case "baseline":
      return input.manifest.scenario.id === "read-mara-explicit-path" &&
        normalization === null && policy === null;
    case "direct-candidate":
      return input.manifest.scenario.id === "read-mara-explicit-path" &&
        normalization !== null && policy === null;
    case "policy-candidate":
      return input.manifest.scenario.id === "read-mara-explicit-path" &&
        normalization !== null && policy !== null;
    case "clean-canary":
      return input.manifest.scenario.id === "read-clean-canary" && normalization !== null;
  }
}

function buildChecks(inputs: SandboxComparisonInput[]): LabCheck[] {
  const subjects = inputs.map(({ manifest }) => ({
    provider: manifest.provenance.subject.provider,
    modelId: manifest.provenance.subject.modelId,
    chatTemplate: manifest.provenance.subject.runtime?.chatTemplate ?? null,
  }));
  const fixtures = inputs.map(({ manifest }) => manifest.fixture);
  const sourceRevisions = inputs.map(({ manifest }) => manifest.provenance.sourceRevision);
  const uniqueRunIds = new Set(inputs.map(({ manifest }) => manifest.runId)).size === inputs.length;
  const requiredRoles = SANDBOX_COMPARISON_ROLES.every(
    (role) => inputs.filter((input) => input.role === role).length === 1,
  );
  return [
    check("required-roles", "Each frozen comparison role is present exactly once", requiredRoles),
    check("unique-runs", "Each comparison role references a separate run", uniqueRunIds),
    check(
      "same-subject",
      "Every run records the same provider, model, and chat template",
      subjects.every((subject) => stable(subject) === stable(subjects[0])),
    ),
    check(
      "same-fixture",
      "Every run uses the same versioned synthetic fixture",
      fixtures.every((fixture) => stable(fixture) === stable(fixtures[0])),
    ),
    check(
      "same-source-revision",
      "Every run records the same source revision",
      sourceRevisions.every((revision) => revision === sourceRevisions[0]),
    ),
    check(
      "same-declared-bounds",
      "Every run uses identical repetitions, limits, and sampling bounds",
      sameDeclaredBounds(inputs),
    ),
    check(
      "frozen-role-configurations",
      "Every role has the required baseline, candidate, policy, or canary configuration",
      inputs.every(roleConfiguration),
    ),
    check(
      "summaries-match-manifests",
      "Every summary belongs to its frozen input manifest",
      inputs.every((input) => input.summary.runId === input.manifest.runId),
    ),
  ];
}

function manifestFor(
  comparisonId: string,
  createdAt: string,
  inputs: SandboxComparisonInput[],
): SandboxComparisonManifest {
  return {
    schemaVersion: SANDBOX_COMPARISON_SCHEMA_VERSION,
    kind: "sandbox-episode-comparison",
    comparisonId,
    createdAt,
    inputs: inputs.map(({ role, manifest }) => ({
      role,
      runId: manifest.runId,
      scenario: structuredClone(manifest.scenario),
      fixture: structuredClone(manifest.fixture),
      conditions: structuredClone(manifest.conditions),
      provenance: structuredClone(manifest.provenance),
    })),
  };
}

export async function compareSandboxEpisodeRuns(
  inputs: SandboxComparisonInput[],
  options: {
    comparisonId?: string;
    now?: () => number;
    sink?: SandboxComparisonSink;
  } = {},
): Promise<SandboxComparisonResult> {
  const now = options.now ?? Date.now;
  const comparisonId = options.comparisonId ?? globalThis.crypto.randomUUID();
  const manifest = manifestFor(comparisonId, new Date(now()).toISOString(), inputs);
  await options.sink?.begin(structuredClone(manifest));
  const checks = buildChecks(inputs);
  const observations = inputs.map(({ role, manifest, summary }) => ({
    role,
    runId: manifest.runId,
    passCount: summary.passCount,
    completedCount: summary.completedCount,
    rawLeakageEpisodes: summary.rawLeakage.episodeCount,
    normalizedEpisodes: summary.normalization.episodeCount,
    interpretation: role === "clean-canary" && summary.passCount < summary.completedCount
      ? "expected-diagnostic" as const
      : "measured" as const,
  }));
  const candidateRunsPass = observations
    .filter((entry) => entry.role !== "baseline" && entry.role !== "clean-canary")
    .every((entry) => entry.completedCount > 0 && entry.passCount === entry.completedCount);
  checks.push(check(
    "candidate-runs-pass",
    "Direct and policy candidate runs pass all completed episodes",
    candidateRunsPass,
  ));
  const result: SandboxComparisonResult = {
    manifest,
    completedAt: new Date(now()).toISOString(),
    checks,
    observations,
    passed: checks.every((entry) => entry.passed),
  };
  await options.sink?.finish(structuredClone(result));
  return result;
}

export async function loadSandboxComparisonInput(
  role: SandboxComparisonRole,
  runId: string,
): Promise<SandboxComparisonInput> {
  const directory = labRunArtifactDirectory(runId);
  const [manifestText, summaryText] = await Promise.all([
    readFile(path.join(directory, "manifest.json"), "utf8"),
    readFile(path.join(directory, "summary.json"), "utf8"),
  ]);
  const manifest = JSON.parse(manifestText) as SandboxEpisodeRunManifest;
  const summary = JSON.parse(summaryText) as SandboxEpisodeRunSummary;
  if (manifest.kind !== "sandbox-episode-run") {
    throw new Error(`Run ${JSON.stringify(runId)} is not a sandbox episode run.`);
  }
  return { role, manifest, summary };
}
