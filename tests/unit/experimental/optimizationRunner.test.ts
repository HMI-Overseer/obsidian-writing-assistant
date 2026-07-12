import { describe, expect, it } from "vitest";
import { scoreBlindJudgments } from "../../../experimental/optimization/analysis";
import { runOptimizationExperiment } from "../../../experimental/optimization/runner";
import { createOptimizationSchedule } from "../../../experimental/optimization/schedule";
import type {
  OptimizationExperimentSpec,
  OptimizationScheduleItem,
  OptimizationTrialObservation,
} from "../../../experimental/optimization/types";

const conditions: OptimizationExperimentSpec["conditions"] = [
  { id: "raw", role: "baseline", component: "response-normalizer", delta: "None." },
  {
    id: "exact-policy",
    role: "candidate",
    component: "response-normalizer",
    delta: "Remove one frozen prefix after a tool result under an exact model match.",
  },
];

function spec(): OptimizationExperimentSpec {
  return {
    experimentId: "experiment-1",
    seed: 42,
    iterations: 3,
    bootstrapSamples: 500,
    confidenceLevel: 0.95,
    cases: [
      {
        id: "visible-case",
        visibility: "development",
        family: "agentic",
        dimensions: ["correctness", "protocol-reliability", "safety-scope"],
        qualitative: true,
        scenario: { id: "read-mara-explicit-path", version: 1 },
      },
      {
        id: "hidden-alpha",
        visibility: "heldout",
        family: "agentic",
        dimensions: ["correctness", "protocol-reliability", "safety-scope"],
        qualitative: false,
      },
    ],
    heldoutPack: {
      schemaVersion: 1,
      kind: "sealed-heldout-pack",
      packId: "pack",
      caseCount: 1,
      cases: [{
        opaqueId: "hidden-alpha",
        family: "agentic",
        dimensions: ["correctness", "protocol-reliability", "safety-scope"],
        qualitative: false,
      }],
      payloadSha256: "a".repeat(64),
    },
    conditions,
    bounds: {
      timeoutMs: 60_000,
      maxRounds: 5,
      maxToolCalls: 10,
      maxRepeatedToolCalls: 3,
      maxTotalTokens: 100_000,
      maxOutputChars: 100_000,
    },
    gates: [
      {
        id: "protocol-improves",
        kind: "minimum-improvement",
        dimension: "protocol-reliability",
        minimumDelta: 1,
        minimumPairs: 6,
        requireCiLowerBound: true,
        visibility: "all",
      },
      {
        id: "correctness-preserved",
        kind: "maximum-regression",
        dimension: "correctness",
        maximumRegression: 0,
        minimumPairs: 6,
        visibility: "all",
      },
      {
        id: "heldout-safety",
        kind: "zero-candidate-failures",
        dimension: "safety-scope",
        visibility: "heldout",
      },
      { id: "duration-bound", kind: "resource-ratio", resource: "durationMs", maximumRatio: 1.2 },
      { id: "heldout-present", kind: "heldout-required", minimumCases: 1 },
      { id: "evaluators-valid", kind: "evaluator-validity" },
      { id: "human-review", kind: "human-approval" },
    ],
    provenance: {
      sourceRevision: "revision",
      subject: { provider: "test", modelId: "model" },
    },
    qualitativeRubric: ["clarity", "usefulness"],
  };
}

function observation(item: OptimizationScheduleItem): OptimizationTrialObservation {
  const candidate = item.role === "candidate";
  return {
    experimentId: "experiment-1",
    ...item,
    checks: [
      {
        id: "correct",
        label: "Correct",
        passed: true,
        required: true,
        dimensions: ["correctness"],
      },
      {
        id: "protocol",
        label: "Protocol",
        passed: candidate,
        required: true,
        dimensions: ["protocol-reliability"],
      },
      {
        id: "safe",
        label: "Safe",
        passed: true,
        required: true,
        dimensions: ["safety-scope"],
      },
    ],
    evaluatorValid: true,
    resources: {
      durationMs: candidate ? 110 : 100,
      toolCalls: 1,
      inputTokens: 20,
      outputTokens: 5,
    },
    qualitativeOutput: item.visibility === "development"
      ? candidate ? "Candidate answer" : "Baseline answer"
      : null,
    sealedEvidence: item.visibility === "heldout" ? "encrypted-evidence" : null,
    publicEvidence: item.visibility === "development" ? { trace: item.sequence } : null,
  };
}

describe("Phase 5 optimization runner", () => {
  it("creates a deterministic balanced schedule with adjacent interleaved pairs", () => {
    const first = createOptimizationSchedule(spec().cases, conditions, 3, 42);
    const second = createOptimizationSchedule(spec().cases, conditions, 3, 42);

    expect(first).toEqual(second);
    expect(first).toHaveLength(12);
    for (let index = 0; index < first.length; index += 2) {
      expect(first[index].pairId).toBe(first[index + 1].pairId);
      expect(new Set([first[index].role, first[index + 1].role])).toEqual(
        new Set(["baseline", "candidate"]),
      );
    }
    expect(first.some((entry, index) => index % 2 === 0 && entry.role === "candidate")).toBe(true);
    expect(first.some((entry, index) => index % 2 === 0 && entry.role === "baseline")).toBe(true);
  });

  it("freezes the manifest before trials and reports effects, uncertainty, gates, and resources", async () => {
    const events: string[] = [];
    const result = await runOptimizationExperiment(spec(), async (item) => {
      events.push(`trial-${item.sequence}`);
      return observation(item);
    }, {
      now: () => 1_000,
      artifactSink: {
        begin: async () => { events.push("manifest"); },
        write: async () => undefined,
        finish: async () => { events.push("summary"); },
      },
    });

    expect(events[0]).toBe("manifest");
    expect(events.at(-1)).toBe("summary");
    expect(result.effects).toContainEqual(expect.objectContaining({
      dimension: "protocol-reliability",
      visibility: "all",
      pairCount: 6,
      delta: 1,
      confidenceInterval: { lower: 1, upper: 1 },
      classification: "improvement",
    }));
    expect(result.effects).toContainEqual(expect.objectContaining({
      dimension: "correctness",
      visibility: "all",
      delta: 0,
      classification: "unchanged",
    }));
    expect(result.resources).toContainEqual(expect.objectContaining({
      resource: "durationMs",
      baselineMean: 100,
      candidateMean: 110,
      ratio: 1.1,
      delta: 10,
    }));
    expect(result.gates.filter((gate) => gate.id !== "human-review")
      .every((gate) => gate.passed)).toBe(true);
    expect(result.gates).toContainEqual(expect.objectContaining({
      id: "human-review",
      passed: false,
      pendingHumanApproval: true,
    }));
    expect(result.recommendation).toBe("awaiting-human-approval");
    expect(result.blindPacket.pairs).toHaveLength(3);
    expect(JSON.stringify(result.blindPacket)).not.toContain("conditionId");
    expect(JSON.stringify(result.blindPacket)).not.toContain("candidate");
    expect(result.blindAssignments).toHaveLength(3);
  });

  it("rejects a candidate when a predeclared non-human gate fails", async () => {
    const result = await runOptimizationExperiment(spec(), async (item) => {
      const trial = observation(item);
      if (item.role === "candidate" && item.visibility === "heldout") {
        trial.checks.find((check) => check.id === "safe")!.passed = false;
      }
      return trial;
    }, { now: () => 0 });

    expect(result.gates).toContainEqual(expect.objectContaining({
      id: "heldout-safety",
      passed: false,
    }));
    expect(result.recommendation).toBe("rejected");
  });

  it("scores human judgments only after revealing the separate assignment map", async () => {
    const result = await runOptimizationExperiment(spec(), async (item) => observation(item), {
      now: () => 0,
    });
    const first = result.blindPacket.pairs[0];
    const scored = scoreBlindJudgments({
      experimentId: result.manifest.experimentId,
      judgments: [{
        blindPairId: first.blindPairId,
        winner: "A",
        rubric: { clarity: "A", usefulness: "tie" },
      }],
      assignments: result.blindAssignments,
      candidateConditionId: "exact-policy",
      humanApproved: true,
      reviewer: "reviewer",
      reviewedAt: "2026-07-12T00:00:00.000Z",
    });
    const assignment = result.blindAssignments.find((entry) =>
      entry.blindPairId === first.blindPairId)!;

    expect(scored.candidateWins).toBe(assignment.responseAConditionId === "exact-policy" ? 1 : 0);
    expect(scored.baselineWins).toBe(assignment.responseAConditionId === "raw" ? 1 : 0);
    expect(scored.rubric.usefulness.ties).toBe(1);
    expect(scored.humanApproved).toBe(true);
  });
});
