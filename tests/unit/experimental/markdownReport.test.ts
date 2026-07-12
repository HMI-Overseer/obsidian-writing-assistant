import { describe, expect, it } from "vitest";
import { buildLabMarkdownReport } from "../../../experimental/lab/markdownReport";
import type { LabRunResult } from "../../../experimental/lab/types";

function result(): LabRunResult {
  const manifest = {
    schemaVersion: 1 as const,
    runId: "run-1",
    startedAt: "2026-07-11T00:00:00.000Z",
    scenario: { id: "control", version: 1, title: "Control", description: "Control run" },
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
      subject: {
        provider: "lmstudio",
        modelId: "model",
        endpoint: "http://localhost:1234/v1",
        runtime: { quantization: "Q4_K_M" },
      },
    },
  };
  return {
    runId: "run-1",
    scenarioId: "control",
    manifest,
    completedAt: "2026-07-11T00:00:01.000Z",
    traces: [
      {
        schemaVersion: 1,
        runId: "run-1",
        trial: 1,
        startedAt: manifest.startedAt,
        scenario: { id: "control", version: 1, title: "Control" },
        conditions: {
          modelId: "model",
          samplingParams: manifest.conditions.samplingParams,
          timeoutMs: 1_000,
        },
        provenance: manifest.provenance,
        request: { systemPrompt: "", documentContext: null, ragContext: null, messages: [] },
        durationMs: 250,
        outcome: {
          kind: "completion",
          response: {
            text: "wrong",
            usage: { inputTokens: 5, outputTokens: 1 },
            stopReason: "end_turn",
          },
        },
        checks: [
          {
            id: "sentinel",
            label: "Contains sentinel",
            passed: false,
            required: true,
            detail: "Sentinel absent",
          },
        ],
        passed: false,
      },
    ],
    passCount: 0,
    totalCount: 1,
  };
}

describe("buildLabMarkdownReport", () => {
  it("renders run identity, runtime metadata, trial usage, and failure evidence", () => {
    const report = buildLabMarkdownReport(result());

    expect(report).toContain("**Result: 0/1 trials passed**");
    expect(report).toContain("| Model | model |");
    expect(report).toContain("| quantization | Q4_K_M |");
    expect(report).toContain("| 1 | Failed | 250 ms | end_turn | 5 | 1 |");
    expect(report).toContain("- Contains sentinel: Sentinel absent");
    expect(report).toContain("canonical evidence");
  });
});
