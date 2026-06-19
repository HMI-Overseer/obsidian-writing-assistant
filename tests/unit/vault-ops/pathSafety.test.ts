import { describe, test, expect } from "vitest";
import { escapesVault, outsideVaultMessage } from "../../../src/vault-ops/pathSafety";

describe("escapesVault", () => {
  test("allows ordinary vault-relative paths", () => {
    for (const p of [
      "Note.md",
      "Sandbox/Note.md",
      "a/b/c/deep.md",
      "Sandbox/NoExtension",
      "folder with spaces/file.md",
      "a/../b.md", // internal .. that stays inside the vault
      "a/b/../c.md",
    ]) {
      expect(escapesVault(p)).toBe(false);
    }
  });

  test("refuses .. traversal that rises above the vault root", () => {
    for (const p of [
      "..",
      "../",
      "../x.md",
      "../../outside-vault.md",
      "a/../../x.md",
      "a/b/../../../c.md",
      "/../x.md", // leading slash plus an escaping ..
    ]) {
      expect(escapesVault(p)).toBe(true);
    }
  });

  test("refuses Windows drive-letter absolute paths", () => {
    for (const p of [
      "C:/Windows/System32/test.md",
      "C:\\Windows\\System32\\test.md",
      "d:/x.md",
      "Z:relative",
    ]) {
      expect(escapesVault(p)).toBe(true);
    }
  });

  test("treats a bare leading slash as vault-relative (normalizePath strips it)", () => {
    expect(escapesVault("/Sandbox/Note.md")).toBe(false);
    expect(escapesVault("/Note.md")).toBe(false);
  });

  test("an empty path is not itself an escape (rejected by the non-empty check elsewhere)", () => {
    expect(escapesVault("")).toBe(false);
  });
});

describe("outsideVaultMessage", () => {
  test("names the offending path and explains the boundary", () => {
    const msg = outsideVaultMessage("../../x.md");
    expect(msg).toContain("../../x.md");
    expect(msg).toContain("outside the vault");
  });
});
