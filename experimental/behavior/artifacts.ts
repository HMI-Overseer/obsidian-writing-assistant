import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { LAB_ARTIFACT_ROOT } from "../lab/fileArtifactSink";
import { BEHAVIOR_DIMENSIONS } from "./types";
import type {
  BehaviorDifferentialResult,
  BehaviorDifferentialSink,
  BehaviorProfileResult,
  BehaviorProfileSink,
} from "./types";

export interface BehaviorArtifactIo {
  makeDirectory(directory: string): Promise<void>;
  writeExclusive(filePath: string, content: string): Promise<void>;
}

const nodeIo: BehaviorArtifactIo = {
  makeDirectory: async (directory) => mkdir(directory, { recursive: true }).then(() => undefined),
  writeExclusive: async (filePath, content) => {
    await writeFile(filePath, content, { encoding: "utf8", flag: "wx" });
  },
};

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function safeDirectory(kind: "profiles" | "differentials", id: string): string {
  if (!SAFE_ID.test(id)) throw new Error(`Behavior ${kind} ID contains unsafe path characters.`);
  return path.join(LAB_ARTIFACT_ROOT, kind, id);
}

export function behaviorProfileDirectory(profileId: string): string {
  return safeDirectory("profiles", profileId);
}

export function behaviorDifferentialDirectory(differentialId: string): string {
  return safeDirectory("differentials", differentialId);
}

function serialize(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function cell(value: string | number | null): string {
  return value === null ? "Missing" : String(value).replace(/\|/g, "\\|");
}

export function buildBehaviorProfileReport(result: BehaviorProfileResult): string {
  const subject = result.manifest.provenance.subject;
  const lines = [
    "# Behavioral model profile",
    "",
    `**Result: ${result.passed ? "Valid" : "Invalid"}**`,
    "",
    `Profile ID: ${result.manifest.profileId}`,
    "",
    `Subject: ${subject.provider} / ${subject.modelId}`,
    "",
    "## Dimensions",
    "",
    "| Dimension | Status | Evidence | Pass rate |",
    "| --- | --- | --- | --- |",
    ...BEHAVIOR_DIMENSIONS.map((dimension) => {
      const entry = result.dimensions[dimension];
      return `| ${dimension} | ${entry.status} | ${entry.evidenceCount} | ` +
        `${entry.passRate === null ? "Missing" : entry.passRate.toFixed(3)} |`;
    }),
    "",
    "## Scenario coverage",
    "",
    "| Scenario | Family | Traces | Passed | Mean duration | Mean tool calls |",
    "| --- | --- | --- | --- | --- | --- |",
    ...result.scenarios.map((scenario) =>
      `| ${scenario.scenario.id} v${scenario.scenario.version} | ${scenario.family} | ` +
      `${scenario.traceCount} | ${scenario.passedTraces} | ` +
      `${cell(scenario.resources.durationMs.mean)} ms | ` +
      `${cell(scenario.resources.toolCalls.mean)} |`),
    "",
    "## Metamorphic groups",
    "",
  ];
  if (result.metamorphicGroups.length === 0) {
    lines.push("No metamorphic group has enough registered input evidence.", "");
  } else {
    lines.push("| Group | Status | Result | Scenarios |", "| --- | --- | --- | --- |");
    for (const group of result.metamorphicGroups) {
      lines.push(
        `| ${group.id} | ${group.status} | ` +
        `${group.passed === null ? "Missing" : group.passed ? "Passed" : "Failed"} | ` +
        `${group.scenarioIds.join(", ")} |`,
      );
    }
    lines.push("");
  }
  lines.push(
    "## Interpretation limit",
    "",
    "This profile is a multidimensional description of its frozen input runs. Missing evidence is " +
      "not a failure or a zero. Deterministic writing constraints do not replace human judgment of " +
      "voice, taste, usefulness, or accessibility.",
    "",
    "Input run traces remain canonical. This profile is derived and append-only.",
    "",
  );
  return lines.join("\n");
}

export function buildBehaviorDifferentialReport(result: BehaviorDifferentialResult): string {
  return [
    "# Behavioral profile differential",
    "",
    `Differential ID: ${result.manifest.differentialId}`,
    "",
    `Left profile: ${result.manifest.leftProfileId}`,
    "",
    `Right profile: ${result.manifest.rightProfileId}`,
    "",
    "| Dimension | Status | Left | Right | Delta | Common scenarios |",
    "| --- | --- | --- | --- | --- | --- |",
    ...result.dimensions.map((entry) =>
      `| ${entry.dimension} | ${entry.status} | ${cell(entry.leftPassRate)} | ` +
      `${cell(entry.rightPassRate)} | ${cell(entry.delta)} | ${entry.commonScenarioCount} |`),
    "",
    result.interpretation,
    "",
    "The two input profiles and all of their run traces remain canonical.",
    "",
  ].join("\n");
}

export function createBehaviorProfileSink(io: BehaviorArtifactIo = nodeIo): BehaviorProfileSink {
  return {
    begin: async (manifest) => {
      const directory = behaviorProfileDirectory(manifest.profileId);
      await io.makeDirectory(directory);
      await io.writeExclusive(path.join(directory, "manifest.json"), serialize(manifest));
    },
    finish: async (result) => {
      const directory = behaviorProfileDirectory(result.manifest.profileId);
      await io.writeExclusive(path.join(directory, "profile.json"), serialize(result));
      await io.writeExclusive(path.join(directory, "report.md"), buildBehaviorProfileReport(result));
    },
  };
}

export function createBehaviorDifferentialSink(
  io: BehaviorArtifactIo = nodeIo,
): BehaviorDifferentialSink {
  return {
    begin: async (manifest) => {
      const directory = behaviorDifferentialDirectory(manifest.differentialId);
      await io.makeDirectory(directory);
      await io.writeExclusive(path.join(directory, "manifest.json"), serialize(manifest));
    },
    finish: async (result) => {
      const directory = behaviorDifferentialDirectory(result.manifest.differentialId);
      await io.writeExclusive(path.join(directory, "differential.json"), serialize(result));
      await io.writeExclusive(path.join(directory, "report.md"), buildBehaviorDifferentialReport(result));
    },
  };
}

export async function loadBehaviorProfile(profileId: string): Promise<BehaviorProfileResult> {
  const content = await readFile(
    path.join(behaviorProfileDirectory(profileId), "profile.json"),
    "utf8",
  );
  const result = JSON.parse(content) as BehaviorProfileResult;
  if (result.manifest.kind !== "behavior-profile" || result.manifest.profileId !== profileId) {
    throw new Error(`Artifact ${JSON.stringify(profileId)} is not the requested behavior profile.`);
  }
  return result;
}
