import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  compareSandboxEpisodeRuns,
  type SandboxComparisonInput,
  type SandboxComparisonRole,
} from "../../../experimental/sandbox/comparison";
import {
  buildSandboxComparisonReport,
  createSandboxComparisonSink,
} from "../../../experimental/sandbox/comparisonArtifacts";
import type {
  SandboxEpisodeRunManifest,
  SandboxEpisodeRunSummary,
} from "../../../experimental/sandbox/types";

function manifest(role: SandboxComparisonRole): SandboxEpisodeRunManifest {
  const candidate = role !== "baseline";
  const policy = role === "policy-candidate";
  const canary = role === "clean-canary";
  return {
    schemaVersion: 2,
    kind: "sandbox-episode-run",
    runId: `${role}-run`,
    startedAt: "2026-07-12T00:00:00.000Z",
    scenario: {
      id: canary ? "read-clean-canary" : "read-mara-explicit-path",
      version: 1,
      title: role,
      description: role,
    },
    fixture: { id: "read-control-vault", version: 1 },
    conditions: {
      iterations: 3,
      timeoutMs: 60_000,
      maxRounds: 5,
      maxToolCalls: 10,
      maxRepeatedToolCalls: 3,
      maxTotalTokens: 100_000,
      maxOutputChars: 100_000,
      samplingParams: {
        temperature: 0,
        maxTokens: 128,
        topP: null,
        topK: null,
        minP: null,
        repeatPenalty: null,
        reasoning: null,
      },
      responseNormalization: candidate
        ? { id: "tool-result-control-token-prefix", version: 1 }
        : null,
      compatibilityPolicy: policy
        ? {
          id: "gemma4-tool-result-control-token-prefix",
          version: 1,
          matchedBy: { kind: "model-id", value: "model" },
        }
        : null,
      writeReview: null,
    },
    provenance: {
      sourceRevision: "revision",
      subject: {
        provider: "lmstudio",
        modelId: "model",
        runtime: { chatTemplate: "template" },
      },
    },
  };
}

function summary(runId: string, passCount: number): SandboxEpisodeRunSummary {
  return {
    schemaVersion: 2,
    kind: "sandbox-episode-run-summary",
    runId,
    completedAt: "2026-07-12T00:01:00.000Z",
    requestedCount: 3,
    completedCount: 3,
    passCount,
    normalization: { episodeCount: runId === "baseline-run" ? 0 : 3, roundCount: 3 },
    rawLeakage: { episodeCount: 3, roundCount: 3 },
    timingMs: { total: 3_000, minimum: 900, maximum: 1_100, mean: 1_000 },
    toolCalls: { total: 3, minimum: 1, maximum: 1, mean: 1 },
    usage: {
      inputTokens: 300,
      outputTokens: 30,
      episodesWithInputUsage: 3,
      episodesWithOutputUsage: 3,
    },
    outcomes: { completed: 3 },
    episodes: [],
  };
}

function inputs(): SandboxComparisonInput[] {
  return (["baseline", "direct-candidate", "policy-candidate", "clean-canary"] as const)
    .map((role) => {
      const runManifest = manifest(role);
      return {
        role,
        manifest: runManifest,
        summary: summary(runManifest.runId, role === "baseline" || role === "clean-canary" ? 0 : 3),
      };
    });
}

describe("sandbox cross-run comparison", () => {
  it("freezes inputs before comparison and treats the affected canary as diagnostic", async () => {
    const events: string[] = [];
    const result = await compareSandboxEpisodeRuns(inputs(), {
      comparisonId: "comparison-1",
      now: () => Date.parse("2026-07-12T00:02:00.000Z"),
      sink: {
        begin: async () => { events.push("manifest"); },
        finish: async () => { events.push("comparison"); },
      },
    });

    expect(events).toEqual(["manifest", "comparison"]);
    expect(result.passed).toBe(true);
    expect(result.manifest.inputs.map((input) => input.runId)).toEqual([
      "baseline-run",
      "direct-candidate-run",
      "policy-candidate-run",
      "clean-canary-run",
    ]);
    expect(result.observations.at(-1)).toMatchObject({
      role: "clean-canary",
      passCount: 0,
      interpretation: "expected-diagnostic",
    });
    expect(buildSandboxComparisonReport(result)).toContain("not counted as a normalizer regression");
  });

  it("fails compatibility when declared bounds differ", async () => {
    const compared = inputs();
    compared[3].manifest.conditions.maxRounds = 4;

    const result = await compareSandboxEpisodeRuns(compared, {
      comparisonId: "comparison-2",
      now: () => 0,
    });

    expect(result.passed).toBe(false);
    expect(result.checks).toContainEqual(expect.objectContaining({
      id: "same-declared-bounds",
      passed: false,
    }));
  });

  it("writes an append-only manifest, JSON comparison, and Markdown report", async () => {
    const files: string[] = [];
    const sink = createSandboxComparisonSink({
      makeDirectory: async () => undefined,
      writeExclusive: async (filePath) => { files.push(filePath); },
    });
    const result = await compareSandboxEpisodeRuns(inputs(), {
      comparisonId: "comparison-3",
      now: () => 0,
    });

    await sink.begin(result.manifest);
    await sink.finish(result);
    expect(files.map((file) => path.basename(file))).toEqual([
      "manifest.json",
      "comparison.json",
      "report.md",
    ]);
  });
});
