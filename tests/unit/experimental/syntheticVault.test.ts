import { describe, expect, it } from "vitest";
import {
  normalizeSyntheticPath,
  SyntheticVault,
} from "../../../experimental/sandbox/syntheticVault";
import type { SyntheticVaultFixture } from "../../../experimental/sandbox/types";

function fixture(files: SyntheticVaultFixture["files"]): SyntheticVaultFixture {
  return {
    schemaVersion: 1,
    id: "fixture",
    version: 1,
    description: "Test fixture",
    files,
  };
}

describe("normalizeSyntheticPath", () => {
  it("normalizes safe relative paths without filesystem access", () => {
    expect(normalizeSyntheticPath("/Notes\\Drafts/../Final.md")).toEqual({
      ok: true,
      path: "Notes/Final.md",
    });
  });

  it("rejects traversal, drive paths, empty targets, and null characters", () => {
    expect(normalizeSyntheticPath("../../outside.md")).toMatchObject({ ok: false });
    expect(normalizeSyntheticPath("C:\\outside.md")).toMatchObject({ ok: false });
    expect(normalizeSyntheticPath("/")).toMatchObject({ ok: false });
    expect(normalizeSyntheticPath("bad\0path.md")).toMatchObject({ ok: false });
  });
});

describe("SyntheticVault", () => {
  it("materializes deterministic, content-addressed snapshots", () => {
    const vault = new SyntheticVault(fixture([
      { path: "B.md", content: "second" },
      { path: "Folder/../A.md", content: "first" },
    ]));

    const snapshot = vault.snapshot();
    expect(snapshot.files.map((file) => file.path)).toEqual(["A.md", "B.md"]);
    expect(snapshot.files[0].sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(vault.readFile("./A.md")).toEqual({ path: "A.md", content: "first" });
  });

  it("rejects invalid and duplicate normalized fixture paths", () => {
    expect(() => new SyntheticVault(fixture([
      { path: "../outside.md", content: "unsafe" },
    ]))).toThrow("Invalid synthetic fixture path");

    expect(() => new SyntheticVault(fixture([
      { path: "Folder/../Note.md", content: "one" },
      { path: "Note.md", content: "two" },
    ]))).toThrow("Duplicate synthetic fixture path");
  });

  it("mutates only normalized in-memory paths", () => {
    const vault = new SyntheticVault(fixture([
      { path: "Notes/Draft.md", content: "draft" },
    ]));

    expect(vault.pathState("Notes")).toBe("dir");
    expect(vault.writeFile("Notes/./Draft.md", "final")).toEqual({
      path: "Notes/Draft.md",
      previousContent: "draft",
    });
    expect(vault.readFile("Notes/Draft.md")?.content).toBe("final");
    expect(() => vault.writeFile("../../outside.md", "unsafe")).toThrow("outside");
  });
});
