import { describe, test, expect } from "vitest";
import {
  validateCreateDirectory as _validateCreateDirectory,
  validateMoveFile as _validateMoveFile,
  validateReplaceInVault,
  validateTrashFile,
  validateWriteFile as _validateWriteFile,
} from "../../../../src/tools/vault-ops/validation";
import type { PathState } from "../../../../src/vault-ops/types";

type Resolve = (path: string) => PathState;

// Default config dir for the existing cases; the live value is threaded from
// `app.vault.configDir` in production. The config-subtree tests below pass an
// explicit dir to prove the guard tracks the live value, not a hardcoded name.
const CONFIG_DIR = ".obsidian";
const validateWriteFile = (args: Record<string, unknown>, resolve: Resolve, cfg = CONFIG_DIR) =>
  _validateWriteFile(args, resolve, cfg);
const validateCreateDirectory = (args: Record<string, unknown>, resolve: Resolve, cfg = CONFIG_DIR) =>
  _validateCreateDirectory(args, resolve, cfg);
const validateMoveFile = (args: Record<string, unknown>, resolve: Resolve, cfg = CONFIG_DIR) =>
  _validateMoveFile(args, resolve, cfg);

const absent = (): PathState => "absent";
const resolveWith = (states: Record<string, PathState>) => (p: string) => states[p] ?? "absent";

describe("validateWriteFile", () => {
  test("accepts a new path", () => {
    const r = validateWriteFile({ path: "a.md", content: "hi" }, absent);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.args).toEqual({ path: "a.md", content: "hi" });
  });

  test("rejects a missing path", () => {
    expect(validateWriteFile({ content: "hi" }, absent).ok).toBe(false);
  });

  test("rejects non-string content", () => {
    expect(validateWriteFile({ path: "a.md", content: 5 }, absent).ok).toBe(false);
  });

  test("rejects writing over a folder", () => {
    const r = validateWriteFile({ path: "Dir", content: "x" }, resolveWith({ Dir: "dir" }));
    expect(r.ok).toBe(false);
  });

  test("allows writing over an existing file (becomes overwrite later)", () => {
    expect(validateWriteFile({ path: "a.md", content: "x" }, resolveWith({ "a.md": "file" })).ok)
      .toBe(true);
  });

  test("accepts a .canvas document", () => {
    expect(validateWriteFile({ path: "Board.canvas", content: "{}" }, absent).ok).toBe(true);
  });

  test("rejects a missing extension with a self-correcting type error", () => {
    const r = validateWriteFile({ path: "Sandbox/NoExtension", content: "x" }, absent);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("unsupported file type");
  });

  test("rejects an executable/script type even when the path is in-vault", () => {
    for (const path of ["Sandbox/run.bat", "x.exe", "page.html", "data.json"]) {
      const r = validateWriteFile({ path, content: "x" }, absent);
      expect(r.ok, path).toBe(false);
      if (!r.ok) expect(r.error).toContain(".md");
    }
  });

  test("rejects overwriting an existing non-document file (e.g. plugin .json)", () => {
    // The extension check applies to overwrite too, so the model cannot clobber a
    // config/plugin file that happens to live inside the vault.
    const r = validateWriteFile(
      { path: ".obsidian/plugins/x/data.json", content: "{}" },
      resolveWith({ ".obsidian/plugins/x/data.json": "file" }),
    );
    expect(r.ok).toBe(false);
  });

  test("reports a folder path as a folder, not a type error (dir branch wins)", () => {
    const r = validateWriteFile({ path: "Characters", content: "x" }, resolveWith({ Characters: "dir" }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("folder");
  });
});

describe("validateCreateDirectory", () => {
  test("accepts a folder path", () => {
    expect(validateCreateDirectory({ path: "New" }, absent).ok).toBe(true);
  });

  test("rejects a path that is a file", () => {
    expect(validateCreateDirectory({ path: "a.md" }, resolveWith({ "a.md": "file" })).ok).toBe(false);
  });

  test("treats an existing folder as already satisfied, not an error", () => {
    const result = validateCreateDirectory({ path: "Dir" }, resolveWith({ Dir: "dir" }));
    expect(result.ok).toBe(true);
    expect("satisfied" in result && result.satisfied).toBe(true);
  });
});

describe("validateMoveFile", () => {
  test("accepts an existing source to an absent destination", () => {
    const r = validateMoveFile({ from: "a.md", to: "b.md" }, resolveWith({ "a.md": "file" }));
    expect(r.ok).toBe(true);
  });

  test("rejects a missing source", () => {
    expect(validateMoveFile({ from: "a.md", to: "b.md" }, absent).ok).toBe(false);
  });

  test("rejects an occupied destination", () => {
    const r = validateMoveFile(
      { from: "a.md", to: "b.md" },
      resolveWith({ "a.md": "file", "b.md": "file" }),
    );
    expect(r.ok).toBe(false);
  });

  test("rejects identical from/to", () => {
    expect(validateMoveFile({ from: "a.md", to: "a.md" }, resolveWith({ "a.md": "file" })).ok)
      .toBe(false);
  });

  test("refuses laundering a blessed file into a forbidden type (note.md -> note.bat)", () => {
    // The whole point of the write_file allowlist would be moot if a move could
    // rename an allowed file into an executable, so the destination is held to the
    // same allowlist. This is the invariant: no non-blessed extension ever lands.
    const r = validateMoveFile({ from: "note.md", to: "note.bat" }, resolveWith({ "note.md": "file" }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("unsupported file type");
  });

  test("refuses a move whose destination drops the extension", () => {
    const r = validateMoveFile({ from: "note.md", to: "Archive/note" }, resolveWith({ "note.md": "file" }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain(".md");
  });

  test("allows a move between blessed document types (.md -> .canvas)", () => {
    expect(
      validateMoveFile({ from: "note.md", to: "board.canvas" }, resolveWith({ "note.md": "file" })).ok,
    ).toBe(true);
  });
});

describe("validateTrashFile", () => {
  test("accepts an existing file", () => {
    expect(validateTrashFile({ path: "a.md" }, resolveWith({ "a.md": "file" })).ok).toBe(true);
  });

  test("rejects an absent path", () => {
    expect(validateTrashFile({ path: "a.md" }, absent).ok).toBe(false);
  });

  test("rejects a folder (files only in v1)", () => {
    expect(validateTrashFile({ path: "Dir" }, resolveWith({ Dir: "dir" })).ok).toBe(false);
  });
});

describe("validateReplaceInVault", () => {
  test("accepts a search/replace pair and defaults the flags to false", () => {
    const r = validateReplaceInVault({ search: "old", replace: "new" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.args).toEqual({
        search: "old",
        replace: "new",
        path: undefined,
        caseSensitive: false,
        wholeWord: false,
      });
    }
  });

  test("threads an explicit scope path and the boolean flags", () => {
    const r = validateReplaceInVault({
      search: "old",
      replace: "new",
      path: "Lore",
      caseSensitive: true,
      wholeWord: true,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.args).toMatchObject({ path: "Lore", caseSensitive: true, wholeWord: true });
  });

  test("rejects an empty search (would match nothing meaningful)", () => {
    const r = validateReplaceInVault({ search: "", replace: "new" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("search");
  });

  test("accepts an empty replace (deletes the term)", () => {
    expect(validateReplaceInVault({ search: "draft ", replace: "" }).ok).toBe(true);
  });

  test("rejects a non-string replace", () => {
    expect(validateReplaceInVault({ search: "old", replace: 5 }).ok).toBe(false);
  });

  test("rejects a scope path that escapes the vault", () => {
    const r = validateReplaceInVault({ search: "old", replace: "new", path: "../outside" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("outside the vault");
  });

  test("rejects non-boolean flags", () => {
    expect(validateReplaceInVault({ search: "a", replace: "b", caseSensitive: "yes" }).ok).toBe(false);
    expect(validateReplaceInVault({ search: "a", replace: "b", wholeWord: 1 }).ok).toBe(false);
  });
});

describe("vault-boundary rejection (out-of-vault paths fail before the review gate)", () => {
  const ESCAPING = [
    "../../outside-vault.md",
    "..",
    "a/../../x.md",
    "C:/Windows/System32/test.md",
    "C:\\Windows\\System32\\test.md",
  ];

  test("validateWriteFile rejects each escaping path with a boundary explanation", () => {
    for (const path of ESCAPING) {
      const r = validateWriteFile({ path, content: "x" }, absent);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain("outside the vault");
    }
  });

  test("validateCreateDirectory rejects an escaping path", () => {
    const r = validateCreateDirectory({ path: "../escape" }, absent);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("outside the vault");
  });

  test("validateMoveFile rejects an escaping source or destination", () => {
    const fromBad = validateMoveFile({ from: "../x.md", to: "B.md" }, absent);
    expect(fromBad.ok).toBe(false);
    if (!fromBad.ok) expect(fromBad.error).toContain("outside the vault");

    const toBad = validateMoveFile({ from: "A.md", to: "../../x.md" }, resolveWith({ "A.md": "file" }));
    expect(toBad.ok).toBe(false);
    if (!toBad.ok) expect(toBad.error).toContain("outside the vault");
  });

  test("validateTrashFile rejects an escaping path", () => {
    const r = validateTrashFile({ path: "../../secret.md" }, resolveWith({}));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("outside the vault");
  });

  test("still allows an internal .. that stays inside the vault (no over-rejection)", () => {
    expect(validateWriteFile({ path: "a/../b.md", content: "x" }, absent).ok).toBe(true);
  });
});

describe("config-subtree rejection (.obsidian writes refused before the gate)", () => {
  test("validateWriteFile refuses a blessed-type write into .obsidian (slips the extension allowlist)", () => {
    // A .md / .canvas under .obsidian passes hasWritableExtension, so the
    // file-type guard alone would let it through; the reserved-prefix guard is
    // what stops it.
    for (const path of [".obsidian/note.md", ".obsidian/board.canvas"]) {
      const r = validateWriteFile({ path, content: "x" }, absent);
      expect(r.ok, path).toBe(false);
      if (!r.ok) expect(r.error).toContain("configuration folder");
    }
  });

  test("validateCreateDirectory refuses a folder inside .obsidian", () => {
    const r = validateCreateDirectory({ path: ".obsidian/plugins/evil" }, absent);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("off limits");
  });

  test("validateMoveFile refuses a move whose destination is inside .obsidian", () => {
    const r = validateMoveFile({ from: "note.md", to: ".obsidian/note.md" }, resolveWith({ "note.md": "file" }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("configuration folder");
  });

  test("still allows a note whose name merely starts with .obsidian (no over-rejection)", () => {
    expect(validateWriteFile({ path: "Sandbox/.obsidian-notes.md", content: "x" }, absent).ok).toBe(true);
  });

  test("tracks the live configDir, not a hardcoded name (renamed config dir is protected)", () => {
    // A user who renamed their config directory: writes into it are refused, and a
    // folder literally named .obsidian is now ordinary content the model may write.
    const refused = validateWriteFile({ path: ".config/app.md", content: "x" }, absent, ".config");
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error).toContain(".config");

    expect(validateWriteFile({ path: ".obsidian/note.md", content: "x" }, absent, ".config").ok).toBe(true);
  });
});
