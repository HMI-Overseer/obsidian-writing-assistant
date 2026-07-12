import path from "node:path";
import { describe, expect, it } from "vitest";
import { createReadMaraEpisode } from "../../../experimental/episodes/readMara";
import { listEpisodeIds, resolveEpisode } from "../../../experimental/episodes/registry";
import { LAB_ARTIFACT_ROOT } from "../../../experimental/lab/fileArtifactSink";
import { writeSandboxEpisodeArtifacts } from "../../../experimental/sandbox/episodeArtifactSink";
import { buildSandboxEpisodeReport } from "../../../experimental/sandbox/episodeReport";
import type { SandboxEpisodeTrace } from "../../../experimental/sandbox/types";

function trace(): SandboxEpisodeTrace {
  const episode = createReadMaraEpisode("model");
  const snapshot = {
    fixtureId: episode.fixture.id,
    fixtureVersion: episode.fixture.version,
    files: [],
  };
  return {
    schemaVersion: 5,
    kind: "sandbox-episode",
    episodeId: "episode-1",
    run: null,
    startedAt: "2026-07-11T00:00:00.000Z",
    completedAt: "2026-07-11T00:00:01.000Z",
    scenario: { id: episode.id, version: episode.version, title: episode.title },
    conditions: {
      modelId: "model",
      samplingParams: episode.samplingParams,
      maxRounds: 4,
      maxToolCalls: 10,
      maxRepeatedToolCalls: 3,
      maxTotalTokens: 100_000,
      maxOutputChars: 100_000,
      responseNormalization: null,
      compatibilityPolicy: null,
      writeReview: null,
    },
    provenance: {
      sourceRevision: "revision",
      subject: { provider: "lmstudio", modelId: "model", endpoint: "http://localhost/v1" },
    },
    fixture: { id: episode.fixture.id, version: episode.fixture.version },
    initialSnapshot: snapshot,
    rounds: [],
    finalSnapshot: snapshot,
    stateDiff: { created: [], modified: [], deleted: [] },
    finalText: "Mara carries a brass compass from her grandmother.",
    outcome: { kind: "completed" },
    checks: [{ id: "check", label: "Check", passed: true, required: true }],
    passed: true,
  };
}

describe("sandbox episode evidence", () => {
  it("resolves registered episodes with runtime model identity", () => {
    expect(listEpisodeIds()).toEqual([
      "read-clean-canary",
      "read-mara",
      "read-mara-explicit-path",
      "read-mara-recovery",
      "read-metamorphic-variant",
      "reviewed-write",
      "tool-surface-no-call",
    ]);
    expect(resolveEpisode("read-mara", "selected-model").modelId).toBe("selected-model");
    expect(resolveEpisode("read-mara-explicit-path", "selected-model").version).toBe(1);
    expect(() => resolveEpisode("unknown", "model")).toThrow("Unknown sandbox episode");
  });

  it("writes append-only JSON evidence and a readable report", async () => {
    const files: Array<{ filePath: string; content: string }> = [];
    const directory = await writeSandboxEpisodeArtifacts(trace(), {
      makeDirectory: async () => undefined,
      writeExclusive: async (filePath, content) => {
        files.push({ filePath, content });
      },
    });

    expect(directory).toBe(path.join(LAB_ARTIFACT_ROOT, "episode-1"));
    expect(files.map((file) => path.basename(file.filePath))).toEqual(["episode.json", "report.md"]);
    expect(JSON.parse(files[0].content)).toMatchObject({ kind: "sandbox-episode", passed: true });
    expect(files[1].content).toContain("**Result: Passed**");
  });

  it("reports checks and final answers", () => {
    const report = buildSandboxEpisodeReport(trace());
    expect(report).toContain("| Check | Yes | Passed |");
    expect(report).toContain("Mara carries a brass compass");
    expect(report).toContain("| Compatibility policy | None |");
    expect(report).toContain("canonical episode trace");
  });
});
