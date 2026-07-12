import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { TOOL_RESULT_CONTROL_TOKEN_PREFIX_NORMALIZER } from "../../../experimental/candidates/toolResultControlTokenPrefix";
import { createReadMaraExplicitPathEpisode } from "../../../experimental/episodes/readMaraExplicitPath";
import { createToolSurfaceNoCallEpisode } from "../../../experimental/episodes/toolSurfaceNoCall";
import { createSandboxEpisodeArtifactSink } from "../../../experimental/sandbox/episodeArtifactSink";
import { buildSandboxEpisodeRunReport } from "../../../experimental/sandbox/episodeReport";
import { runSandboxEpisodeExperiment } from "../../../experimental/sandbox/episodeRun";
import type { SandboxEpisodeArtifactSink } from "../../../experimental/sandbox/types";
import type { ChatClient } from "../../../src/api/chatClient";
import type { ChatRequest } from "../../../src/shared/chatRequest";

function clientWithComplete(complete: ChatClient["complete"]): ChatClient {
  return {
    complete,
    stream: vi.fn(() => {
      throw new Error("Episode experiments use non-streaming completions.");
    }),
  };
}

function memorySink(events: string[] = []): {
  sink: SandboxEpisodeArtifactSink;
  manifests: unknown[];
  traces: unknown[];
  results: unknown[];
} {
  const manifests: unknown[] = [];
  const traces: unknown[] = [];
  const results: unknown[] = [];
  return {
    manifests,
    traces,
    results,
    sink: {
      begin: async (manifest) => {
        events.push("manifest");
        manifests.push(manifest);
      },
      write: async (trace) => {
        events.push(`trace-${trace.run?.iteration}`);
        traces.push(trace);
      },
      finish: async (result) => {
        events.push("summary");
        results.push(result);
      },
    },
  };
}

describe("sandbox episode experiment grouping", () => {
  it("freezes the manifest before execution and writes a separate trace per iteration", async () => {
    const events: string[] = [];
    const artifacts = memorySink(events);
    const client = clientWithComplete(async () => {
      events.push("complete");
      return {
        text: "LAB_READY",
        usage: { inputTokens: 7, outputTokens: 2 },
        toolCalls: null,
        stopReason: "end_turn",
      };
    });

    const result = await runSandboxEpisodeExperiment(
      client,
      createToolSurfaceNoCallEpisode("model"),
      {
        iterations: 2,
        timeoutMs: 5_000,
        maxRounds: 3,
        maxToolCalls: 4,
        createRunId: () => "run-1",
        createEpisodeId: (iteration) => `episode-${iteration}`,
        now: () => 1_000,
        provenance: {
          sourceRevision: "revision-1",
          subject: { provider: "test", modelId: "model" },
        },
        artifactSink: artifacts.sink,
      },
    );

    expect(events).toEqual(["manifest", "complete", "trace-1", "complete", "trace-2", "summary"]);
    expect(result.manifest).toMatchObject({
      runId: "run-1",
      scenario: { id: "tool-surface-no-call", version: 1 },
      conditions: {
        iterations: 2,
        timeoutMs: 5_000,
        maxRounds: 3,
        maxToolCalls: 4,
      },
      provenance: { sourceRevision: "revision-1" },
    });
    expect(result.traces.map((trace) => trace.episodeId)).toEqual(["episode-1", "episode-2"]);
    expect(result.traces.map((trace) => trace.run)).toEqual([
      { id: "run-1", iteration: 1 },
      { id: "run-1", iteration: 2 },
    ]);

    const files: string[] = [];
    const fileSink = createSandboxEpisodeArtifactSink({
      makeDirectory: async () => undefined,
      writeExclusive: async (filePath) => {
        files.push(filePath);
      },
    });
    await fileSink.begin(result.manifest);
    for (const trace of result.traces) await fileSink.write(trace);
    await fileSink.finish(result);
    expect(files.filter((file) => path.basename(file) === "episode.json")).toEqual([
      expect.stringContaining(path.join("episodes", "episode-1", "episode.json")),
      expect.stringContaining(path.join("episodes", "episode-2", "episode.json")),
    ]);
  });

  it("retains partial-run evidence and continues after one episode fails", async () => {
    let call = 0;
    const artifacts = memorySink();
    const client = clientWithComplete(async () => {
      call++;
      if (call === 1) throw new Error("temporary transport failure");
      return { text: "LAB_READY", usage: null, toolCalls: null, stopReason: "end_turn" };
    });

    const result = await runSandboxEpisodeExperiment(
      client,
      createToolSurfaceNoCallEpisode("model"),
      {
        iterations: 2,
        createRunId: () => "partial-run",
        createEpisodeId: (iteration) => `partial-${iteration}`,
        now: () => 2_000,
        artifactSink: artifacts.sink,
      },
    );

    expect(result.traces).toHaveLength(2);
    expect(result.traces[0]).toMatchObject({ passed: false, outcome: { kind: "error" } });
    expect(result.traces[1]).toMatchObject({ passed: true, outcome: { kind: "completed" } });
    expect(result.summary).toMatchObject({ completedCount: 2, passCount: 1 });
    expect(artifacts.traces).toHaveLength(2);
  });

  it("enforces the episode timeout even when the client ignores abort signals", async () => {
    const client = clientWithComplete(() => new Promise(() => undefined));

    const result = await runSandboxEpisodeExperiment(
      client,
      createToolSurfaceNoCallEpisode("model"),
      {
        iterations: 1,
        timeoutMs: 5,
        createRunId: () => "timeout-run",
        createEpisodeId: () => "timeout-episode",
      },
    );

    expect(result.traces[0]).toMatchObject({
      passed: false,
      outcome: {
        kind: "error",
        message: "Sandbox episode exceeded 5 ms.",
      },
    });
  });

  it("refuses duplicate episode IDs after retaining the first exclusive trace", async () => {
    const artifacts = memorySink();
    const client = clientWithComplete(async () => ({
      text: "LAB_READY",
      usage: null,
      toolCalls: null,
      stopReason: "end_turn",
    }));

    await expect(runSandboxEpisodeExperiment(
      client,
      createToolSurfaceNoCallEpisode("model"),
      {
        iterations: 2,
        createRunId: () => "duplicate-run",
        createEpisodeId: () => "same-episode",
        now: () => 3_000,
        artifactSink: artifacts.sink,
      },
    )).rejects.toThrow("not unique within the run");
    expect(artifacts.manifests).toHaveLength(1);
    expect(artifacts.traces).toHaveLength(1);
    expect(artifacts.results).toHaveLength(0);
  });

  it("records policy identity in the manifest and every trace", async () => {
    const policy = {
      id: "policy",
      version: 2,
      matchedBy: { kind: "model-id" as const, value: "model" },
    };
    const result = await runSandboxEpisodeExperiment(
      clientWithComplete(async () => ({
        text: "LAB_READY",
        usage: null,
        toolCalls: null,
        stopReason: "end_turn",
      })),
      createToolSurfaceNoCallEpisode("model"),
      {
        iterations: 2,
        createRunId: () => "policy-run",
        createEpisodeId: (iteration) => `policy-${iteration}`,
        now: () => 4_000,
        responseNormalizer: TOOL_RESULT_CONTROL_TOKEN_PREFIX_NORMALIZER,
        compatibilityPolicy: policy,
      },
    );

    expect(result.manifest.conditions.compatibilityPolicy).toEqual(policy);
    expect(result.manifest.conditions.responseNormalization).toEqual({
      id: "tool-result-control-token-prefix",
      version: 1,
    });
    expect(result.traces.every(
      (trace) => JSON.stringify(trace.conditions.compatibilityPolicy) === JSON.stringify(policy),
    )).toBe(true);
  });

  it("calculates clean and normalized incidence, timing, tools, usage, and failures", async () => {
    let call = 0;
    let clock = 0;
    const client = clientWithComplete(async (request: ChatRequest) => {
      call++;
      const firstRound = request.messages.at(-1)?.role !== "tool";
      if (firstRound) {
        return {
          text: "",
          usage: { inputTokens: 10, outputTokens: 3 },
          toolCalls: [{
            id: `read-${call}`,
            name: "read_file",
            arguments: { path: "Characters/Mara.md" },
          }],
          stopReason: "tool_use",
        };
      }
      return {
        text: call === 2
          ? "<|channel>thought\n<channel|>Mara carries a brass compass from her grandmother."
          : "Mara carries a brass compass from her grandmother.",
        usage: { inputTokens: 20, outputTokens: 5 },
        toolCalls: null,
        stopReason: "end_turn",
      };
    });

    const result = await runSandboxEpisodeExperiment(
      client,
      createReadMaraExplicitPathEpisode("model"),
      {
        iterations: 2,
        createRunId: () => "summary-run",
        createEpisodeId: (iteration) => `summary-${iteration}`,
        now: () => {
          clock += 10;
          return clock;
        },
        responseNormalizer: TOOL_RESULT_CONTROL_TOKEN_PREFIX_NORMALIZER,
      },
    );

    expect(result.summary).toMatchObject({
      completedCount: 2,
      passCount: 2,
      normalization: { episodeCount: 1, roundCount: 1 },
      rawLeakage: { episodeCount: 1, roundCount: 1 },
      timingMs: { total: 40, minimum: 20, maximum: 20, mean: 20 },
      toolCalls: { total: 2, minimum: 1, maximum: 1, mean: 1 },
      usage: {
        inputTokens: 60,
        outputTokens: 16,
        episodesWithInputUsage: 2,
        episodesWithOutputUsage: 2,
      },
      outcomes: { completed: 2 },
    });
    expect(result.summary.episodes.map((episode) => episode.rawLeakageRounds)).toEqual([1, 0]);
    expect(result.summary.episodes.every((episode) => episode.failedChecks.length === 0)).toBe(true);
    const report = buildSandboxEpisodeRunReport(result);
    expect(report).toContain("| Episodes with exact raw leakage | 1 |");
    expect(report).toContain("| Episodes with normalization | 1 |");
    expect(report).toContain("Stability and latency claims require");
    expect(report).toContain("canonical self-contained trace");
  });

  it("uses exclusive creation so a run-manifest collision is refused", async () => {
    const files = new Set<string>();
    const sink = createSandboxEpisodeArtifactSink({
      makeDirectory: async () => undefined,
      writeExclusive: async (filePath) => {
        if (files.has(filePath)) throw new Error("EEXIST");
        files.add(filePath);
      },
    });
    const scenario = createToolSurfaceNoCallEpisode("model");
    const manifest = {
      schemaVersion: 2 as const,
      kind: "sandbox-episode-run" as const,
      runId: "collision-run",
      startedAt: "2026-07-11T00:00:00.000Z",
      scenario: {
        id: scenario.id,
        version: scenario.version,
        title: scenario.title,
        description: scenario.description,
      },
      fixture: { id: scenario.fixture.id, version: scenario.fixture.version },
      conditions: {
        iterations: 1,
        timeoutMs: 1_000,
        maxRounds: 2,
        maxToolCalls: 2,
        maxRepeatedToolCalls: 3,
        maxTotalTokens: 100_000,
        maxOutputChars: 100_000,
        samplingParams: scenario.samplingParams,
        responseNormalization: null,
        compatibilityPolicy: null,
        writeReview: null,
      },
      provenance: {
        sourceRevision: "revision",
        subject: { provider: "test", modelId: "model" },
      },
    };

    await sink.begin(manifest);
    await expect(sink.begin(manifest)).rejects.toThrow("EEXIST");
    expect([...files].map((file) => path.basename(file))).toContain("manifest.json");
  });
});
