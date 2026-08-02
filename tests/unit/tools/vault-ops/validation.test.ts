import { describe, test, expect } from "vitest";
import {
  validateCreateDirectory as _validateCreateDirectory,
  validateMove as _validateMove,
  validateReplaceInVault,
  validateTrash,
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
const validateMove = (args: Record<string, unknown>, resolve: Resolve, cfg = CONFIG_DIR) =>
  _validateMove(args, resolve, cfg);

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

// `move` and `trash` are one tool each (RFC-0015): the probed state of the source picks
// the note or the folder pathway, so the two predecessors' cases live under one describe
// and the pathway is an assertion rather than a choice of function. The wrong-sibling
// refusals ("use move_file instead") are gone, not moved: they were the model's mistake
// to make and it can no longer make it.
describe("validateMove", () => {
  test("accepts an existing note to an absent destination, on the note pathway", () => {
    const r = validateMove({ from: "a.md", to: "b.md" }, resolveWith({ "a.md": "file" }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.args).toEqual({ from: "a.md", to: "b.md", isFolder: false });
  });

  test("accepts an existing folder to an absent destination, on the folder pathway", () => {
    const r = validateMove(
      { from: "Drafts/Act II", to: "Manuscript/Act II" },
      resolveWith({ "Drafts/Act II": "dir" }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.args).toEqual({
        from: "Drafts/Act II",
        to: "Manuscript/Act II",
        isFolder: true,
      });
    }
  });

  test("the probed source picks the pathway, not the arguments", () => {
    // Identical arguments, opposite branches: the only difference is what `from` is on
    // disk. Both accept, so the assertion is on the branch itself rather than on which
    // one happened to error, and it fails from either side.
    const args = { from: "X.md", to: "Y.md" };
    const asFile = validateMove(args, resolveWith({ "X.md": "file" }));
    const asFolder = validateMove(args, resolveWith({ "X.md": "dir" }));
    expect(asFile.ok).toBe(true);
    expect(asFolder.ok).toBe(true);
    if (asFile.ok && asFolder.ok) {
      expect(asFile.args.isFolder).toBe(false);
      expect(asFolder.args.isFolder).toBe(true);
    }
  });

  test("rejects a missing source, whatever the caller meant to move", () => {
    const r = validateMove({ from: "a.md", to: "b.md" }, absent);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('source "a.md" does not exist.');
  });

  test("an absent source outranks an unsupported destination type", () => {
    // Ordering change taken deliberately with the merge: the retired move_file judged
    // the destination's extension before it resolved the source, so this call used to
    // report the type. The source is the thing that is actually wrong, and the merged
    // tool cannot know whether the destination needs an extension until it knows what
    // the source is.
    const r = validateMove({ from: "Ghost.md", to: "x.bat" }, absent);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('source "Ghost.md" does not exist.');
  });

  test("rejects an occupied destination on either pathway", () => {
    const note = validateMove(
      { from: "a.md", to: "b.md" },
      resolveWith({ "a.md": "file", "b.md": "file" }),
    );
    expect(note.ok).toBe(false);
    if (!note.ok) expect(note.error).toContain("already exists");

    const folder = validateMove({ from: "A", to: "B" }, resolveWith({ A: "dir", B: "dir" }));
    expect(folder.ok).toBe(false);
    if (!folder.ok) expect(folder.error).toContain("already exists");
  });

  test("rejects identical from/to on either pathway", () => {
    expect(validateMove({ from: "a.md", to: "a.md" }, resolveWith({ "a.md": "file" })).ok)
      .toBe(false);
    expect(validateMove({ from: "A", to: "A" }, resolveWith({ A: "dir" })).ok).toBe(false);
  });

  test("refuses laundering a blessed note into a forbidden type (note.md -> note.bat)", () => {
    // The whole point of the write_file allowlist would be moot if a move could
    // rename an allowed file into an executable, so the destination is held to the
    // same allowlist. This is the invariant: no non-blessed extension ever lands.
    const r = validateMove({ from: "note.md", to: "note.bat" }, resolveWith({ "note.md": "file" }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("unsupported file type");
  });

  test("refuses a note move whose destination drops the extension", () => {
    const r = validateMove({ from: "note.md", to: "Archive/note" }, resolveWith({ "note.md": "file" }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain(".md");
  });

  test("allows a note move between blessed document types (.md -> .canvas)", () => {
    expect(
      validateMove({ from: "note.md", to: "board.canvas" }, resolveWith({ "note.md": "file" })).ok,
    ).toBe(true);
  });

  test("needs no document extension on the folder pathway (a folder has none)", () => {
    // The extensionless destination the note pathway refuses as an unsupported type is
    // exactly what a folder move requires, which is why the allowlist is per-pathway.
    const r = validateMove({ from: "A", to: "B" }, resolveWith({ A: "dir" }));
    expect(r.ok).toBe(true);
  });

  test("rejects an escaping source or destination", () => {
    const fromBad = validateMove({ from: "../X", to: "B" }, absent);
    expect(fromBad.ok).toBe(false);
    if (!fromBad.ok) expect(fromBad.error).toContain("outside the vault");

    const toBad = validateMove({ from: "A", to: "../../X" }, resolveWith({ A: "dir" }));
    expect(toBad.ok).toBe(false);
    if (!toBad.ok) expect(toBad.error).toContain("outside the vault");
  });

  test("refuses a move whose destination is inside the config subtree, on either pathway", () => {
    const folder = validateMove({ from: "A", to: ".obsidian/A" }, resolveWith({ A: "dir" }));
    expect(folder.ok).toBe(false);
    if (!folder.ok) expect(folder.error).toContain("configuration folder");

    const note = validateMove(
      { from: "note.md", to: ".obsidian/note.md" },
      resolveWith({ "note.md": "file" }),
    );
    expect(note.ok).toBe(false);
    if (!note.ok) expect(note.error).toContain("configuration folder");
  });
});

describe("validateTrash", () => {
  test("accepts an existing note, on the note pathway", () => {
    const r = validateTrash({ path: "a.md" }, resolveWith({ "a.md": "file" }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.args).toEqual({ path: "a.md", isFolder: false });
  });

  test("accepts an existing folder, on the folder pathway (emptiness is enforced at apply)", () => {
    const r = validateTrash({ path: "Drafts/Act II" }, resolveWith({ "Drafts/Act II": "dir" }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.args).toEqual({ path: "Drafts/Act II", isFolder: true });
  });

  test("the probed target picks the pathway, not the arguments", () => {
    // One destructive tool resolving its target strictly: the same path is a note trash
    // or a folder trash purely by what it turns out to be (RFC-0015's safety constraint).
    const asFile = validateTrash({ path: "X" }, resolveWith({ X: "file" }));
    const asFolder = validateTrash({ path: "X" }, resolveWith({ X: "dir" }));
    expect(asFile.ok).toBe(true);
    expect(asFolder.ok).toBe(true);
    if (asFile.ok && asFolder.ok) {
      expect(asFile.args.isFolder).toBe(false);
      expect(asFolder.args.isFolder).toBe(true);
    }
  });

  test("rejects an absent path, in one wording for both pathways", () => {
    const r = validateTrash({ path: "a.md" }, absent);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('"a.md" does not exist.');
  });

  test("rejects an escaping path", () => {
    const r = validateTrash({ path: "../../secret" }, resolveWith({}));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("outside the vault");
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

  test("validateMove rejects an escaping source or destination", () => {
    const fromBad = validateMove({ from: "../x.md", to: "B.md" }, absent);
    expect(fromBad.ok).toBe(false);
    if (!fromBad.ok) expect(fromBad.error).toContain("outside the vault");

    const toBad = validateMove({ from: "A.md", to: "../../x.md" }, resolveWith({ "A.md": "file" }));
    expect(toBad.ok).toBe(false);
    if (!toBad.ok) expect(toBad.error).toContain("outside the vault");
  });

  test("validateTrash rejects an escaping path", () => {
    const r = validateTrash({ path: "../../secret.md" }, resolveWith({}));
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

  test("validateMove refuses a move whose destination is inside .obsidian", () => {
    const r = validateMove({ from: "note.md", to: ".obsidian/note.md" }, resolveWith({ "note.md": "file" }));
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

  // FINDING 2.1 (tool level): the same first-segment-only bypass, exercised through the
  // in-loop validators the model actually hits. Each currently returns ok:true because
  // escapesVault permits the `..` path and the config guard reads only the first segment.
  test("validateWriteFile refuses a .obsidian write reached via internal .. traversal", () => {
    const r = validateWriteFile({ path: "x/../.obsidian/evil.md", content: "x" }, absent);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("configuration folder");
  });

  test("validateCreateDirectory refuses a .obsidian folder reached via internal .. traversal", () => {
    const r = validateCreateDirectory({ path: "x/../.obsidian/evil" }, absent);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("off limits");
  });

  test("validateMove refuses a note destination reaching .obsidian via internal .. traversal", () => {
    const r = validateMove(
      { from: "note.md", to: "x/../.obsidian/note.md" },
      resolveWith({ "note.md": "file" }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("configuration folder");
  });

  test("validateMove refuses a folder destination reaching .obsidian via internal .. traversal", () => {
    const r = validateMove(
      { from: "Notes", to: "x/../.obsidian/Notes" },
      resolveWith({ Notes: "dir" }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("configuration folder");
  });

  // GUARDRAIL (must stay green): a legitimate internal `..` that stays in the note area
  // must remain writable, so the traversal-aware fix does not over-reject.
  test("still allows an internal .. write that never reaches the config dir (no over-rejection)", () => {
    expect(validateWriteFile({ path: "Drafts/../Archive/note.md", content: "x" }, absent).ok).toBe(true);
  });
});
