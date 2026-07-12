import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { labRunArtifactDirectory } from "../lab/fileArtifactSink";
import { buildSandboxEpisodeReport, buildSandboxEpisodeRunReport } from "./episodeReport";
import type {
  SandboxEpisodeArtifactSink,
  SandboxEpisodeRunResult,
  SandboxEpisodeTrace,
} from "./types";

export interface SandboxEpisodeArtifactIo {
  makeDirectory(directory: string): Promise<void>;
  writeExclusive(filePath: string, content: string): Promise<void>;
}

const nodeIo: SandboxEpisodeArtifactIo = {
  makeDirectory: async (directory) => {
    await mkdir(directory, { recursive: true });
  },
  writeExclusive: async (filePath, content) => {
    await writeFile(filePath, content, { encoding: "utf8", flag: "wx" });
  },
};

const SAFE_EPISODE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function episodeDirectory(runId: string, episodeId: string): string {
  if (!SAFE_EPISODE_ID.test(episodeId)) {
    throw new Error("Sandbox episode ID contains unsafe path characters.");
  }
  return path.join(labRunArtifactDirectory(runId), "episodes", episodeId);
}

function serialize(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function createSandboxEpisodeArtifactSink(
  io: SandboxEpisodeArtifactIo = nodeIo,
): SandboxEpisodeArtifactSink {
  return {
    begin: async (manifest) => {
      const directory = labRunArtifactDirectory(manifest.runId);
      await io.makeDirectory(path.join(directory, "episodes"));
      await io.writeExclusive(path.join(directory, "manifest.json"), serialize(manifest));
    },
    write: async (trace) => {
      if (!trace.run) throw new Error("Grouped sandbox episode trace is missing run identity.");
      const directory = episodeDirectory(trace.run.id, trace.episodeId);
      await io.makeDirectory(directory);
      await io.writeExclusive(path.join(directory, "episode.json"), serialize(trace));
    },
    finish: async (result: SandboxEpisodeRunResult) => {
      const directory = labRunArtifactDirectory(result.runId);
      await io.writeExclusive(path.join(directory, "summary.json"), serialize(result.summary));
      await io.writeExclusive(path.join(directory, "report.md"), buildSandboxEpisodeRunReport(result));
    },
  };
}

export async function writeSandboxEpisodeArtifacts(
  trace: SandboxEpisodeTrace,
  io: SandboxEpisodeArtifactIo = nodeIo,
): Promise<string> {
  const directory = labRunArtifactDirectory(trace.episodeId);
  await io.makeDirectory(directory);
  await io.writeExclusive(
    path.join(directory, "episode.json"),
    serialize(trace),
  );
  await io.writeExclusive(path.join(directory, "report.md"), buildSandboxEpisodeReport(trace));
  return directory;
}
