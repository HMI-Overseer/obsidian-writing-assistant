import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { LAB_ARTIFACT_ROOT } from "../lab/fileArtifactSink";
import type { SandboxComparisonResult, SandboxComparisonSink } from "./comparison";

export interface SandboxComparisonArtifactIo {
  makeDirectory(directory: string): Promise<void>;
  writeExclusive(filePath: string, content: string): Promise<void>;
}

const nodeIo: SandboxComparisonArtifactIo = {
  makeDirectory: async (directory) => mkdir(directory, { recursive: true }).then(() => undefined),
  writeExclusive: async (filePath, content) => {
    await writeFile(filePath, content, { encoding: "utf8", flag: "wx" });
  },
};

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function sandboxComparisonDirectory(comparisonId: string): string {
  if (!SAFE_ID.test(comparisonId)) throw new Error("Comparison ID contains unsafe path characters.");
  return path.join(LAB_ARTIFACT_ROOT, "comparisons", comparisonId);
}

function serialize(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function buildSandboxComparisonReport(result: SandboxComparisonResult): string {
  const lines = [
    "# Sandbox episode comparison",
    "",
    `**Result: ${result.passed ? "Passed" : "Failed"}**`,
    "",
    `Comparison ID: ${result.manifest.comparisonId}`,
    "",
    "## Frozen inputs",
    "",
    "| Role | Run ID | Scenario |",
    "| --- | --- | --- |",
    ...result.manifest.inputs.map((input) =>
      `| ${input.role} | ${input.runId} | ${input.scenario.id} v${input.scenario.version} |`),
    "",
    "## Compatibility checks",
    "",
    "| Check | Result |",
    "| --- | --- |",
    ...result.checks.map((entry) => `| ${entry.label} | ${entry.passed ? "Passed" : "Failed"} |`),
    "",
    "## Derived observations",
    "",
    "| Role | Passed | Raw leakage episodes | Normalized episodes | Interpretation |",
    "| --- | --- | --- | --- | --- |",
    ...result.observations.map((entry) =>
      `| ${entry.role} | ${entry.passCount}/${entry.completedCount} | ` +
      `${entry.rawLeakageEpisodes} | ${entry.normalizedEpisodes} | ${entry.interpretation} |`),
    "",
    "The clean-canary failure is diagnostic when the affected subject emits the frozen raw prefix. " +
      "It is not counted as a normalizer regression.",
    "",
    "This is a derived comparison. The input run manifests, summaries, and episode traces remain canonical.",
    "",
  ];
  return lines.join("\n");
}

export function createSandboxComparisonSink(
  io: SandboxComparisonArtifactIo = nodeIo,
): SandboxComparisonSink {
  return {
    begin: async (manifest) => {
      const directory = sandboxComparisonDirectory(manifest.comparisonId);
      await io.makeDirectory(directory);
      await io.writeExclusive(path.join(directory, "manifest.json"), serialize(manifest));
    },
    finish: async (result) => {
      const directory = sandboxComparisonDirectory(result.manifest.comparisonId);
      await io.writeExclusive(path.join(directory, "comparison.json"), serialize(result));
      await io.writeExclusive(path.join(directory, "report.md"), buildSandboxComparisonReport(result));
    },
  };
}
