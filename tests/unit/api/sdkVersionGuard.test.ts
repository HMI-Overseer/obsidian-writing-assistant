import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, it, expect } from "vitest";
import {
  EXPECTED_CLAUDE_CLI_VERSION,
  isCliVersionCompatible,
  parseVersion,
} from "../../../src/api/sdkVersionGuard";

interface SdkPackageMetadata {
  version?: string;
  claudeCodeVersion?: string;
}

interface ProjectPackageMetadata {
  dependencies?: Record<string, string>;
}

function readJson<T>(filePath: string): T {
  return JSON.parse(readFileSync(filePath, "utf8")) as T;
}

describe("parseVersion", () => {
  it("parses a plain semver triple", () => {
    expect(parseVersion("2.1.177")).toEqual({ major: 2, minor: 1, patch: 177 });
  });

  it("extracts the triple from the CLI's decorated --version output", () => {
    expect(parseVersion("2.1.177 (Claude Code)")).toEqual({ major: 2, minor: 1, patch: 177 });
  });

  it("returns null for missing or non-version input", () => {
    expect(parseVersion(undefined)).toBeNull();
    expect(parseVersion("")).toBeNull();
    expect(parseVersion("not a version")).toBeNull();
  });
});

describe("isCliVersionCompatible", () => {
  it("accepts the exact pinned version", () => {
    expect(isCliVersionCompatible(EXPECTED_CLAUDE_CLI_VERSION)).toBe(true);
  });

  it("accepts patch drift within the same major.minor", () => {
    expect(isCliVersionCompatible("2.1.0", "2.1.177")).toBe(true);
    expect(isCliVersionCompatible("2.1.999", "2.1.177")).toBe(true);
  });

  it("rejects a minor or major mismatch", () => {
    expect(isCliVersionCompatible("2.2.0", "2.1.177")).toBe(false);
    expect(isCliVersionCompatible("3.1.177", "2.1.177")).toBe(false);
    expect(isCliVersionCompatible("1.1.177", "2.1.177")).toBe(false);
  });

  it("treats a missing or unparseable CLI version as incompatible", () => {
    expect(isCliVersionCompatible(undefined)).toBe(false);
    expect(isCliVersionCompatible("")).toBe(false);
    expect(isCliVersionCompatible("garbage")).toBe(false);
  });

  it("tolerates decorated CLI output", () => {
    expect(isCliVersionCompatible("2.1.177 (Claude Code)", "2.1.177")).toBe(true);
  });
});

describe("SDK version metadata", () => {
  it("keeps the dependency pin and CLI guard aligned with the installed SDK", () => {
    const require = createRequire(import.meta.url);
    const sdkEntry = require.resolve("@anthropic-ai/claude-agent-sdk");
    const sdkPackage = readJson<SdkPackageMetadata>(
      path.join(path.dirname(sdkEntry), "package.json"),
    );
    const projectPackage = readJson<ProjectPackageMetadata>(
      path.join(process.cwd(), "package.json"),
    );

    expect(projectPackage.dependencies?.["@anthropic-ai/claude-agent-sdk"]).toBe(
      sdkPackage.version,
    );
    expect(EXPECTED_CLAUDE_CLI_VERSION).toBe(sdkPackage.claudeCodeVersion);
  });
});
