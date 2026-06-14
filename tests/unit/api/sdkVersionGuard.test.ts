import { describe, it, expect } from "vitest";
import {
  EXPECTED_CLAUDE_CLI_VERSION,
  isCliVersionCompatible,
  parseVersion,
} from "../../../src/api/sdkVersionGuard";

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
