import { describe, test, expect } from "vitest";
import {
  escapesVault,
  isReservedConfigPath,
  outsideVaultMessage,
  reservedConfigMessage,
} from "../../../src/vault-ops/pathSafety";

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

  // FINDING 3.1: a drive letter hidden behind a leading slash currently slips the
  // /^[a-zA-Z]:/ test (the "/" precedes the letter); normalizePath then strips the slash
  // to a bare C:/… . It must be refused identically to the un-slashed drive-letter form.
  test("refuses a Windows drive-letter absolute hidden behind a leading slash", () => {
    for (const p of ["/C:/Windows/System32/test.md", "/d:/secrets/note.md", "\\C:\\Windows\\x.md"]) {
      expect(escapesVault(p), p).toBe(true);
    }
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

describe("isReservedConfigPath", () => {
  const CFG = ".obsidian";

  test("refuses a path whose first segment is the config dir", () => {
    for (const p of [
      ".obsidian",
      ".obsidian/note.md",
      ".obsidian/plugins/x/main.js",
      ".obsidian/snippets/a.css",
      "/.obsidian/note.md", // leading slash, still first real segment
      ".obsidian\\note.md", // Windows separator
      "./.obsidian/note.md", // explicit current-dir prefix
    ]) {
      expect(isReservedConfigPath(p, CFG), p).toBe(true);
    }
  });

  test("allows ordinary paths and only matches the first segment exactly", () => {
    for (const p of [
      "note.md",
      "Sandbox/.obsidian/note.md", // .obsidian not the first segment
      ".obsidianx/note.md", // not exactly .obsidian (no over-broad prefix match)
      "my.obsidian/note.md",
      ".obsidian-archive/note.md",
      "obsidian/note.md", // no leading dot
    ]) {
      expect(isReservedConfigPath(p, CFG), p).toBe(false);
    }
  });

  // FINDING 2.1: the guard inspects only the FIRST segment, so a `..` that resolves into
  // the config dir slips it (the first segment is innocuous). path.join later collapses
  // `foo/../.obsidian/…` to `.obsidian/…` on disk, so it must be treated as reserved.
  test("refuses a config-dir target reached via internal .. traversal", () => {
    for (const p of [
      "foo/../.obsidian/evil.md",
      "a/b/../../.obsidian/plugins/x/main.js",
      "Notes/../.obsidian",
      "./x/../.obsidian/note.md",
    ]) {
      expect(isReservedConfigPath(p, CFG), p).toBe(true);
    }
  });

  // GUARDRAIL (must stay green): an internal `..` that never resolves into the config dir
  // must remain allowed, so the traversal-aware fix does not over-reject ordinary writes.
  test("still allows an internal .. that never reaches the config dir (no over-rejection)", () => {
    for (const p of ["foo/../bar.md", "Notes/../Archive/note.md"]) {
      expect(isReservedConfigPath(p, CFG), p).toBe(false);
    }
  });

  test("uses the live config dir name, tolerating slashes around it", () => {
    expect(isReservedConfigPath(".config/app.md", ".config")).toBe(true);
    expect(isReservedConfigPath(".config/app.md", "/.config/")).toBe(true); // padded configDir
    expect(isReservedConfigPath(".obsidian/note.md", ".config")).toBe(false); // not the live config dir
  });
});

describe("reservedConfigMessage", () => {
  test("names the offending path and the config folder", () => {
    const msg = reservedConfigMessage(".obsidian/note.md", ".obsidian");
    expect(msg).toContain(".obsidian/note.md");
    expect(msg).toContain(".obsidian");
    expect(msg).toContain("off limits");
  });
});
