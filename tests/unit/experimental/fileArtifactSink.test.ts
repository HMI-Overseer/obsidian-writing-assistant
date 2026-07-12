import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createFileArtifactSink,
  LAB_ARTIFACT_ROOT,
  type LabArtifactIo,
} from "../../../experimental/lab/fileArtifactSink";
import type { LabRunManifest, LabRunResult, LabTrialTrace } from "../../../experimental/lab/types";

const manifest: LabRunManifest = {
  schemaVersion: 1,
  runId: "safe-run-1",
  startedAt: "2026-07-11T00:00:00.000Z",
  scenario: {
    id: "scenario",
    version: 1,
    title: "Scenario",
    description: "Fixture",
  },
  conditions: {
    iterations: 1,
    timeoutMs: 1_000,
    samplingParams: {
      temperature: 0,
      maxTokens: 10,
      topP: null,
      topK: null,
      minP: null,
      repeatPenalty: null,
      reasoning: null,
    },
  },
  provenance: {
    sourceRevision: "revision",
    subject: { provider: "lmstudio", modelId: "model" },
  },
};

const trace: LabTrialTrace = {
  schemaVersion: 1,
  runId: manifest.runId,
  trial: 1,
  startedAt: manifest.startedAt,
  scenario: { id: "scenario", version: 1, title: "Scenario" },
  conditions: {
    modelId: "model",
    samplingParams: manifest.conditions.samplingParams,
    timeoutMs: 1_000,
  },
  provenance: manifest.provenance,
  request: {
    systemPrompt: "",
    documentContext: null,
    ragContext: null,
    messages: [],
  },
  durationMs: 5,
  outcome: { kind: "completion", response: { text: "ok", usage: null } },
  checks: [],
  passed: true,
};

function runResult(): LabRunResult {
  return {
    runId: manifest.runId,
    scenarioId: "scenario",
    manifest,
    completedAt: "2026-07-11T00:00:01.000Z",
    traces: [trace],
    passCount: 1,
    totalCount: 1,
  };
}

describe("createFileArtifactSink", () => {
  it("writes the manifest, numbered trial, and summary below the fixed artifact root", async () => {
    const directories: string[] = [];
    const files: Array<{ filePath: string; content: string }> = [];
    const io: LabArtifactIo = {
      makeDirectory: async (directory) => {
        directories.push(directory);
      },
      writeExclusive: async (filePath, content) => {
        files.push({ filePath, content });
      },
    };
    const sink = createFileArtifactSink(io);

    await sink.begin?.(manifest);
    await sink.write(trace);
    await sink.finish?.(runResult());

    const runRoot = path.join(LAB_ARTIFACT_ROOT, "safe-run-1");
    expect(directories).toEqual([path.join(runRoot, "trials")]);
    expect(files.map((file) => file.filePath)).toEqual([
      path.join(runRoot, "manifest.json"),
      path.join(runRoot, "trials", "0001.json"),
      path.join(runRoot, "summary.json"),
      path.join(runRoot, "report.md"),
    ]);
    expect(JSON.parse(files[0].content)).toMatchObject({
      runId: "safe-run-1",
      provenance: { subject: { provider: "lmstudio" } },
    });
  });

  it("rejects unsafe run identifiers before performing IO", async () => {
    const writes: string[] = [];
    const sink = createFileArtifactSink({
      makeDirectory: async (directory) => {
        writes.push(directory);
      },
      writeExclusive: async (filePath) => {
        writes.push(filePath);
      },
    });

    await expect(sink.begin?.({ ...manifest, runId: "../escape" })).rejects.toThrow(
      "unsafe path characters",
    );
    expect(writes).toEqual([]);
  });
});
