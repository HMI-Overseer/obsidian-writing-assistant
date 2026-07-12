import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildBehaviorDifferentialReport,
  buildBehaviorProfileReport,
  createBehaviorDifferentialSink,
  createBehaviorProfileSink,
} from "../../../experimental/behavior/artifacts";
import {
  createBehaviorDifferential,
  createBehaviorProfile,
} from "../../../experimental/behavior/profile";
import {
  listBehaviorMappings,
  resolveBehaviorMapping,
} from "../../../experimental/behavior/registry";
import type {
  BehaviorEvidenceTrace,
  BehaviorRunInput,
} from "../../../experimental/behavior/types";

const provenance = {
  sourceRevision: "phase-4",
  subject: {
    provider: "lmstudio",
    modelId: "model",
    runtime: { chatTemplate: "template" },
  },
};

function evidence(args: {
  runId: string;
  scenarioId: string;
  version: number;
  checks: Array<{ id: string; passed: boolean; required?: boolean }>;
  passed?: boolean;
  traceId?: string;
}): BehaviorEvidenceTrace {
  return {
    runId: args.runId,
    traceId: args.traceId ?? "1",
    scenario: { id: args.scenarioId, version: args.version, title: args.scenarioId },
    provenance,
    checks: args.checks.map((check) => ({
      id: check.id,
      label: check.id,
      passed: check.passed,
      required: check.required ?? true,
    })),
    passed: args.passed ?? args.checks.every((check) => check.passed),
    durationMs: 100,
    toolCalls: args.scenarioId.startsWith("read-") ? 1 : 0,
    inputTokens: 10,
    outputTokens: 2,
  };
}

function run(
  runId: string,
  scenarioId: string,
  version: number,
  traces: BehaviorEvidenceTrace[],
): BehaviorRunInput {
  return {
    runId,
    scenario: { id: scenarioId, version, title: scenarioId },
    provenance,
    traces,
  };
}

function groundedRuns(variantPassed = true): BehaviorRunInput[] {
  const baselineChecks = [
    { id: "read-only-state-unchanged", passed: true },
    { id: "read-target-note", passed: true },
    { id: "grounded-answer", passed: true },
    { id: "no-control-token-leak", passed: true },
    { id: "target-path-first-attempt", passed: true, required: false },
  ];
  const variantChecks = [
    { id: "read-only-state-unchanged", passed: true },
    { id: "read-variant-target", passed: variantPassed },
    { id: "grounded-variant-answer", passed: variantPassed },
    { id: "no-control-token-leak", passed: true },
  ];
  return [
    run("base-run", "read-mara-explicit-path", 1, [
      evidence({
        runId: "base-run",
        scenarioId: "read-mara-explicit-path",
        version: 1,
        checks: baselineChecks,
      }),
      evidence({
        runId: "base-run",
        scenarioId: "read-mara-explicit-path",
        version: 1,
        checks: baselineChecks,
        traceId: "2",
      }),
    ]),
    run("variant-run", "read-metamorphic-variant", 1, [
      evidence({
        runId: "variant-run",
        scenarioId: "read-metamorphic-variant",
        version: 1,
        checks: variantChecks,
      }),
      evidence({
        runId: "variant-run",
        scenarioId: "read-metamorphic-variant",
        version: 1,
        checks: variantChecks,
        traceId: "2",
      }),
    ]),
  ];
}

describe("Phase 4 behavior mapping", () => {
  it("uses a closed, versioned registry covering every current scenario family", () => {
    const mappings = listBehaviorMappings();
    expect(new Set(mappings.map((entry) => entry.family))).toEqual(new Set([
      "control",
      "protocol",
      "agentic",
      "state-memory",
      "writing",
    ]));
    expect(resolveBehaviorMapping("reviewed-write", 2).checks).toHaveProperty(
      "reviewed-write-applied",
    );
    expect(() => resolveBehaviorMapping("unknown", 1)).toThrow("No behavior mapping");
  });

  it("freezes inputs before deriving a profile and preserves missing dimensions", async () => {
    const events: string[] = [];
    const result = await createBehaviorProfile(groundedRuns(), {
      profileId: "profile-1",
      now: () => 1_000,
      sink: {
        begin: async () => { events.push("manifest"); },
        finish: async () => { events.push("profile"); },
      },
    });

    expect(events).toEqual(["manifest", "profile"]);
    expect(result.passed).toBe(true);
    expect(result.dimensions.correctness).toMatchObject({
      status: "observed",
      passRate: 1,
    });
    expect(result.dimensions["user-effort"]).toEqual({
      status: "missing",
      evidenceCount: 0,
      passCount: 0,
      passRate: null,
    });
    expect(result.resources).toMatchObject({
      traceCount: 4,
      durationMs: { total: 400, mean: 100 },
      toolCalls: { total: 4, mean: 1 },
    });
    expect(result.metamorphicGroups).toContainEqual(expect.objectContaining({
      id: "grounded-read-path-and-noun-substitution",
      status: "observed",
      passed: true,
    }));
    expect(buildBehaviorProfileReport(result)).toContain("Missing evidence is not a failure");
  });

  it("invalidates a profile whose required evaluator is not dimension-mapped", async () => {
    const input = groundedRuns()[0];
    input.traces[0].checks.push({
      id: "unmapped-required",
      label: "Unmapped",
      passed: true,
      required: true,
    });

    const result = await createBehaviorProfile([input], { profileId: "invalid", now: () => 0 });

    expect(result.passed).toBe(false);
    expect(result.checks).toContainEqual(expect.objectContaining({
      id: "mapped-required-checks",
      passed: false,
    }));
  });

  it("compares only dimensions backed by common scenarios", async () => {
    const left = await createBehaviorProfile(groundedRuns(), {
      profileId: "left",
      now: () => 0,
    });
    const right = await createBehaviorProfile(groundedRuns(false), {
      profileId: "right",
      now: () => 0,
    });
    const differential = await createBehaviorDifferential(left, right, {
      differentialId: "diff",
      now: () => 0,
    });

    expect(differential.dimensions).toContainEqual(expect.objectContaining({
      dimension: "correctness",
      status: "comparable",
      delta: -0.5,
      commonScenarioCount: 2,
    }));
    expect(differential.dimensions).toContainEqual(expect.objectContaining({
      dimension: "user-effort",
      status: "missing",
      delta: null,
    }));
    expect(buildBehaviorDifferentialReport(differential)).toContain(
      "no statistical, causal, stability, or product-ranking claim",
    );
  });

  it("writes append-only profile and differential artifacts", async () => {
    const profileFiles: string[] = [];
    const differentialFiles: string[] = [];
    const profile = await createBehaviorProfile(groundedRuns(), {
      profileId: "files-profile",
      now: () => 0,
    });
    const differential = await createBehaviorDifferential(profile, profile, {
      differentialId: "files-diff",
      now: () => 0,
    });
    const profileSink = createBehaviorProfileSink({
      makeDirectory: async () => undefined,
      writeExclusive: async (filePath) => { profileFiles.push(path.basename(filePath)); },
    });
    const differentialSink = createBehaviorDifferentialSink({
      makeDirectory: async () => undefined,
      writeExclusive: async (filePath) => { differentialFiles.push(path.basename(filePath)); },
    });

    await profileSink.begin(profile.manifest);
    await profileSink.finish(profile);
    await differentialSink.begin(differential.manifest);
    await differentialSink.finish(differential);

    expect(profileFiles).toEqual(["manifest.json", "profile.json", "report.md"]);
    expect(differentialFiles).toEqual(["manifest.json", "differential.json", "report.md"]);
  });
});
