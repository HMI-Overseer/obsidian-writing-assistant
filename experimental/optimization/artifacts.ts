import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { LAB_ARTIFACT_ROOT } from "../lab/fileArtifactSink";
import type {
  OptimizationArtifactSink,
  OptimizationExperimentResult,
  SealedHeldoutPack,
} from "./types";

export interface OptimizationArtifactIo {
  makeDirectory(directory: string): Promise<void>;
  writeExclusive(filePath: string, content: string): Promise<void>;
}

const nodeIo: OptimizationArtifactIo = {
  makeDirectory: async (directory) => mkdir(directory, { recursive: true }).then(() => undefined),
  writeExclusive: async (filePath, content) => {
    await writeFile(filePath, content, { encoding: "utf8", flag: "wx" });
  },
};

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function optimizationArtifactDirectory(experimentId: string): string {
  if (!SAFE_ID.test(experimentId)) throw new Error("Optimization ID contains unsafe path characters.");
  return path.join(LAB_ARTIFACT_ROOT, "optimizations", experimentId);
}

export function heldoutPackArtifactPath(packId: string): string {
  if (!SAFE_ID.test(packId)) throw new Error("Held-out pack ID contains unsafe path characters.");
  return path.join(LAB_ARTIFACT_ROOT, "heldout-packs", `${packId}.json`);
}

function serialize(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export async function writeSealedHeldoutPack(
  pack: SealedHeldoutPack,
  io: OptimizationArtifactIo = nodeIo,
): Promise<string> {
  const filePath = heldoutPackArtifactPath(pack.manifest.packId);
  await io.makeDirectory(path.dirname(filePath));
  await io.writeExclusive(filePath, serialize(pack));
  return filePath;
}

export function buildOptimizationReport(result: OptimizationExperimentResult): string {
  const allEffects = result.effects.filter((effect) => effect.visibility === "all");
  const lines = [
    "# Candidate optimization experiment",
    "",
    `Experiment ID: ${result.manifest.experimentId}`,
    "",
    `Recommendation: ${result.recommendation}`,
    "",
    "## Frozen conditions",
    "",
    "| Role | ID | Component | Delta |",
    "| --- | --- | --- | --- |",
    ...result.manifest.conditions.map((condition) =>
      `| ${condition.role} | ${condition.id} | ${condition.component} | ${condition.delta} |`),
    "",
    "## Paired dimension effects",
    "",
    "| Dimension | Pairs | Baseline | Candidate | Delta | Interval | Classification |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...allEffects.map((effect) =>
      `| ${effect.dimension} | ${effect.pairCount} | ${effect.baselinePassRate ?? "Missing"} | ` +
      `${effect.candidatePassRate ?? "Missing"} | ${effect.delta ?? "Missing"} | ` +
      `${effect.confidenceInterval
        ? `[${effect.confidenceInterval.lower}, ${effect.confidenceInterval.upper}]`
        : "Missing"} | ${effect.classification} |`),
    "",
    "## Resource comparison",
    "",
    "| Resource | Baseline mean | Candidate mean | Delta | Ratio |",
    "| --- | --- | --- | --- | --- |",
    ...result.resources.map((entry) =>
      `| ${entry.resource} | ${entry.baselineMean ?? "Missing"} | ` +
      `${entry.candidateMean ?? "Missing"} | ${entry.delta ?? "Missing"} | ` +
      `${entry.ratio ?? "Missing"} |`),
    "",
    "## Acceptance gates",
    "",
    "| Gate | Result | Detail |",
    "| --- | --- | --- |",
    ...result.gates.map((gate) =>
      `| ${gate.id} | ${gate.pendingHumanApproval ? "Pending human approval" : gate.passed ? "Passed" : "Failed"} | ` +
      `${gate.detail.replace(/\|/g, "\\|")} |`),
    "",
    "## Interpretation limit",
    "",
    "Effects use paired binary observations and a deterministic bootstrap interval. They remain " +
      "bounded to the frozen cases, subject, candidate delta, and resource limits. The laboratory " +
      "never accepts a candidate automatically; a passing experiment remains awaiting human approval.",
    "",
    "Held-out prompts, fixtures, expected answers, and raw traces remain encrypted.",
    "",
  ];
  return lines.join("\n");
}

export function createOptimizationArtifactSink(
  io: OptimizationArtifactIo = nodeIo,
): OptimizationArtifactSink {
  return {
    begin: async (manifest) => {
      const directory = optimizationArtifactDirectory(manifest.experimentId);
      await io.makeDirectory(path.join(directory, "trials"));
      await io.writeExclusive(path.join(directory, "manifest.json"), serialize(manifest));
    },
    write: async (trial) => {
      const directory = optimizationArtifactDirectory(trial.experimentId);
      const fileName = `${String(trial.sequence).padStart(4, "0")}.json`;
      await io.writeExclusive(path.join(directory, "trials", fileName), serialize(trial));
    },
    finish: async (result) => {
      const directory = optimizationArtifactDirectory(result.manifest.experimentId);
      await io.writeExclusive(path.join(directory, "summary.json"), serialize(result));
      await io.writeExclusive(path.join(directory, "report.md"), buildOptimizationReport(result));
      await io.writeExclusive(
        path.join(directory, "blind-packet.json"),
        serialize(result.blindPacket),
      );
      await io.writeExclusive(
        path.join(directory, "blind-assignments.json"),
        serialize(result.blindAssignments),
      );
    },
  };
}
