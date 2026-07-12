import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  LabArtifactSink,
  LabRunManifest,
  LabRunResult,
  LabTrialTrace,
} from "./types";
import { buildLabMarkdownReport } from "./markdownReport";

const EXPERIMENTAL_ROOT = fileURLToPath(new URL("../", import.meta.url));
export const LAB_ARTIFACT_ROOT = path.join(EXPERIMENTAL_ROOT, "artifacts");
const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export interface LabArtifactIo {
  makeDirectory(directory: string): Promise<void>;
  writeExclusive(filePath: string, content: string): Promise<void>;
}

const nodeArtifactIo: LabArtifactIo = {
  makeDirectory: async (directory) => {
    await mkdir(directory, { recursive: true });
  },
  writeExclusive: async (filePath, content) => {
    await writeFile(filePath, content, { encoding: "utf8", flag: "wx" });
  },
};

export function labRunArtifactDirectory(runId: string): string {
  if (!SAFE_RUN_ID.test(runId)) {
    throw new Error("Laboratory run ID contains unsafe path characters.");
  }
  return path.join(LAB_ARTIFACT_ROOT, runId);
}

function serialize(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function createFileArtifactSink(io: LabArtifactIo = nodeArtifactIo): LabArtifactSink {
  return {
    begin: async (manifest: LabRunManifest) => {
      const directory = labRunArtifactDirectory(manifest.runId);
      await io.makeDirectory(path.join(directory, "trials"));
      await io.writeExclusive(path.join(directory, "manifest.json"), serialize(manifest));
    },
    write: async (trace: LabTrialTrace) => {
      const directory = labRunArtifactDirectory(trace.runId);
      const trialName = `${String(trace.trial).padStart(4, "0")}.json`;
      await io.writeExclusive(path.join(directory, "trials", trialName), serialize(trace));
    },
    finish: async (result: LabRunResult) => {
      const directory = labRunArtifactDirectory(result.runId);
      const summary = {
        schemaVersion: result.manifest.schemaVersion,
        runId: result.runId,
        scenarioId: result.scenarioId,
        completedAt: result.completedAt,
        passCount: result.passCount,
        totalCount: result.totalCount,
      };
      await io.writeExclusive(path.join(directory, "summary.json"), serialize(summary));
      await io.writeExclusive(path.join(directory, "report.md"), buildLabMarkdownReport(result));
    },
  };
}
