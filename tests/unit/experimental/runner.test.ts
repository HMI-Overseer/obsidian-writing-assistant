import { describe, expect, it, vi } from "vitest";
import { runLabScenario } from "../../../experimental/lab/runner";
import type {
  LabArtifactSink,
  LabEvaluator,
  LabScenario,
  LabTrialTrace,
} from "../../../experimental/lab/types";
import type { ChatClient } from "../../../src/api/chatClient";
import type { ChatRequest } from "../../../src/shared/chatRequest";

function scenario(evaluators: LabEvaluator[] = []): LabScenario {
  return {
    schemaVersion: 1,
    id: "test-scenario",
    version: 1,
    title: "Test scenario",
    description: "A laboratory runner fixture.",
    modelId: "test-model",
    samplingParams: {
      temperature: 0,
      maxTokens: 32,
      topP: null,
      topK: null,
      minP: null,
      repeatPenalty: null,
      reasoning: null,
    },
    request: {
      systemPrompt: "Test prompt",
      documentContext: null,
      ragContext: null,
      messages: [{ role: "user", content: "Respond." }],
    },
    evaluators,
  };
}

function clientWithComplete(complete: ChatClient["complete"]): ChatClient {
  return {
    complete,
    stream: vi.fn(() => {
      throw new Error("Streaming is outside this laboratory slice.");
    }),
  };
}

describe("runLabScenario", () => {
  it("captures an immutable request, response, and deterministic verdict", async () => {
    const testScenario = scenario([
      {
        id: "expected-response",
        label: "Response is correct",
        evaluate: ({ completion }) => completion.text === "done",
      },
    ]);
    const complete = vi.fn(async (request: ChatRequest) => {
      request.systemPrompt = "mutated by client";
      return {
        text: "done",
        usage: { inputTokens: 5, outputTokens: 1 },
        toolCalls: [{ id: "call-1", name: "propose_edit", arguments: { path: "note.md" } }],
        stopReason: "tool_use" as const,
      };
    });

    const result = await runLabScenario(
      { client: clientWithComplete(complete) },
      testScenario,
      { createRunId: () => "run-1", now: () => 1_000 },
    );

    expect(result).toMatchObject({ runId: "run-1", passCount: 1, totalCount: 1 });
    expect(result.traces[0].request.systemPrompt).toBe("Test prompt");
    expect(testScenario.request.systemPrompt).toBe("Test prompt");
    expect(result.traces[0].outcome).toMatchObject({
      kind: "completion",
      response: { text: "done", toolCalls: [{ name: "propose_edit" }] },
    });
    expect(result.traces[0].checks).toEqual([
      { id: "expected-response", label: "Response is correct", passed: true, required: true },
    ]);
  });

  it("records transport failures and continues repeated trials", async () => {
    let calls = 0;
    const complete = vi.fn(async () => {
      calls++;
      if (calls === 1) throw new Error("model unavailable");
      return { text: "recovered", usage: null };
    });

    const result = await runLabScenario(
      { client: clientWithComplete(complete) },
      scenario(),
      { iterations: 2, createRunId: () => "run-2", now: () => 2_000 },
    );

    expect(result.totalCount).toBe(2);
    expect(result.passCount).toBe(1);
    expect(result.traces[0].outcome).toMatchObject({
      kind: "error",
      error: { name: "Error", message: "model unavailable", timedOut: false },
    });
    expect(result.traces[1].outcome.kind).toBe("completion");
  });

  it("turns evaluator exceptions into visible validator failures", async () => {
    const result = await runLabScenario(
      {
        client: clientWithComplete(async () => ({ text: "response", usage: null })),
      },
      scenario([
        {
          id: "broken-evaluator",
          label: "Evaluator works",
          evaluate: () => {
            throw new Error("bad rubric");
          },
        },
      ]),
      { createRunId: () => "run-3", now: () => 3_000 },
    );

    expect(result.passCount).toBe(0);
    expect(result.traces[0].checks[0]).toMatchObject({
      id: "broken-evaluator",
      passed: false,
      required: true,
      detail: "Evaluator failed with Error: bad rubric",
    });
  });

  it("emits cloned traces through an injected artifact sink", async () => {
    const written: LabTrialTrace[] = [];
    const sink: LabArtifactSink = {
      write: async (trace) => {
        written.push(trace);
        trace.request.systemPrompt = "sink mutation";
      },
    };

    const result = await runLabScenario(
      {
        client: clientWithComplete(async () => ({ text: "response", usage: null })),
      },
      scenario(),
      { artifactSink: sink, createRunId: () => "run-4", now: () => 4_000 },
    );

    expect(written).toHaveLength(1);
    expect(result.traces[0].request.systemPrompt).toBe("Test prompt");
  });

  it("emits a provenance manifest before traces and a summary after them", async () => {
    const events: string[] = [];
    const sink: LabArtifactSink = {
      begin: async (manifest) => {
        events.push(`begin:${manifest.provenance.subject.provider}`);
      },
      write: async (trace) => {
        events.push(`trial:${trace.trial}:${trace.provenance.sourceRevision}`);
      },
      finish: async (result) => {
        events.push(`finish:${result.totalCount}`);
      },
    };

    const result = await runLabScenario(
      {
        client: clientWithComplete(async () => ({ text: "response", usage: null })),
      },
      scenario(),
      {
        artifactSink: sink,
        createRunId: () => "run-5",
        now: () => 5_000,
        provenance: {
          sourceRevision: "revision-1",
          subject: { provider: "lmstudio", modelId: "test-model" },
        },
      },
    );

    expect(events).toEqual(["begin:lmstudio", "trial:1:revision-1", "finish:1"]);
    expect(result.manifest.provenance.subject.modelId).toBe("test-model");
  });

  it("rejects provenance for a different model", async () => {
    await expect(runLabScenario(
      {
        client: clientWithComplete(async () => ({ text: "response", usage: null })),
      },
      scenario(),
      {
        provenance: {
          sourceRevision: null,
          subject: { provider: "lmstudio", modelId: "different-model" },
        },
      },
    )).rejects.toThrow("provenance model ID must match");
  });
});
