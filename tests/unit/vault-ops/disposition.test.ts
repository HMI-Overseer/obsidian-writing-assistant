import { describe, it, expect } from "vitest";
import { dispositionMessage, editDispositionMessage } from "../../../src/vault-ops/disposition";
import type { VaultOperation } from "../../../src/vault-ops/types";

const FP = { mtime: 1, size: 2 };

const CREATE: VaultOperation = { kind: "create", path: "Notes/Alice.md", content: "hi" };
const OVERWRITE: VaultOperation = { kind: "overwrite", path: "Notes/Alice.md", content: "hi", expect: FP };
const DIR: VaultOperation = { kind: "createDir", path: "Notes/Folder" };
const MOVE: VaultOperation = { kind: "move", from: "a.md", to: "b.md", expect: FP };
const TRASH: VaultOperation = { kind: "trash", path: "a.md", expect: FP, snapshot: "x" };
const REPLACE: VaultOperation = {
  kind: "replaceInVault",
  search: "Silver Age",
  replace: "Golden Age",
  caseSensitive: false,
  wholeWord: false,
  targets: [
    { path: "Lore/A.md", content: "x", expect: FP },
    { path: "Lore/B.md", content: "y", expect: FP },
  ],
  occurrences: 3,
};

describe("dispositionMessage", () => {
  it("reports an applied op in the past tense, with the path", () => {
    expect(dispositionMessage(CREATE, "applied")).toBe('Created "Notes/Alice.md".');
    expect(dispositionMessage(OVERWRITE, "applied")).toBe('Overwrote "Notes/Alice.md".');
    expect(dispositionMessage(DIR, "applied")).toBe('Created folder "Notes/Folder".');
    expect(dispositionMessage(TRASH, "applied")).toBe('Trashed "a.md".');
  });

  it("shows both endpoints for a move", () => {
    expect(dispositionMessage(MOVE, "applied")).toBe('Moved "a.md" → "b.md".');
  });

  it("reports folder ops with folder-aware verbs", () => {
    const moveFolder: VaultOperation = { kind: "moveFolder", from: "Drafts/X", to: "Manuscript/X" };
    const trashFolder: VaultOperation = { kind: "trashFolder", path: "Drafts/X" };
    expect(dispositionMessage(moveFolder, "applied")).toBe('Moved folder "Drafts/X" → "Manuscript/X".');
    expect(dispositionMessage(trashFolder, "applied")).toBe('Trashed folder "Drafts/X".');
    expect(dispositionMessage(trashFolder, "failed", "the folder is not empty")).toBe(
      'Error: could not trash folder "Drafts/X", the folder is not empty.',
    );
  });

  it("reports a replace with its terms, note count, and match count", () => {
    expect(dispositionMessage(REPLACE, "applied")).toBe(
      'Replaced "Silver Age" → "Golden Age" in 2 notes (3 matches).',
    );
    expect(dispositionMessage(REPLACE, "failed", "a file changed on disk")).toBe(
      'Error: could not replace "Silver Age" → "Golden Age" in 2 notes (3 matches), a file changed on disk.',
    );
  });

  it("flags an auto-applied op so the model knows there was no click", () => {
    expect(dispositionMessage(CREATE, "auto-applied")).toBe('Created "Notes/Alice.md" (auto-applied).');
  });

  it("says the op was declined and not changed", () => {
    expect(dispositionMessage(CREATE, "declined")).toBe('Declined by user, "Notes/Alice.md" was not changed.');
  });

  it("prefixes 'Error:' and carries the failure reason in lower-case infinitive", () => {
    expect(dispositionMessage(CREATE, "failed", "path exists")).toBe(
      'Error: could not create "Notes/Alice.md", path exists.',
    );
    expect(dispositionMessage(MOVE, "failed", "target busy")).toBe(
      'Error: could not move "a.md" → "b.md", target busy.',
    );
  });

  it("falls back to a generic reason when none is given", () => {
    expect(dispositionMessage(CREATE, "failed")).toBe(
      'Error: could not create "Notes/Alice.md", the operation failed.',
    );
  });

  it("describes a satisfied directory no-op without asserting a change", () => {
    expect(dispositionMessage(DIR, "satisfied")).toBe('Folder "Notes/Folder" already exists; nothing to do.');
  });

  it("reports a cancelled op as still pending review", () => {
    expect(dispositionMessage(CREATE, "cancelled")).toBe(
      'Generation stopped before you decided, "Notes/Alice.md" is still pending review.',
    );
  });
});

describe("editDispositionMessage", () => {
  it("reports an applied edit and frontmatter update in edit terms", () => {
    expect(editDispositionMessage("edit", "The War.md", "applied")).toBe(
      'Applied edit to "The War.md".',
    );
    expect(editDispositionMessage("frontmatter", "The War.md", "applied")).toBe(
      'Applied frontmatter update to "The War.md".',
    );
  });

  it("flags an auto-applied edit so the model knows there was no click", () => {
    expect(editDispositionMessage("edit", "The War.md", "auto-applied")).toBe(
      'Applied edit to "The War.md" (auto-applied).',
    );
  });

  it("says the edit was declined and not applied", () => {
    expect(editDispositionMessage("edit", "The War.md", "declined")).toBe(
      'Declined by user, edit to "The War.md" was not applied.',
    );
  });

  it("prefixes 'Error:', names the tool, and carries the reason on a no-match failure", () => {
    expect(
      editDispositionMessage(
        "edit",
        "The War.md",
        "failed",
        "no location matched the search text; re-read the file and retry",
      ),
    ).toBe(
      'Error: edit did not apply to "The War.md", no location matched the search text; re-read the file and retry.',
    );
    expect(editDispositionMessage("frontmatter", "The War.md", "failed")).toBe(
      'Error: update_frontmatter did not apply to "The War.md", the edit could not be resolved.',
    );
  });

  it("reports a cancelled edit as still pending review", () => {
    expect(editDispositionMessage("edit", "The War.md", "cancelled")).toBe(
      'Generation stopped before you decided, edit to "The War.md" is still pending review.',
    );
  });

  it("names a non-exact match type on an applied edit so the model learns it was sloppy", () => {
    expect(editDispositionMessage("edit", "The War.md", "applied", undefined, "fuzzy")).toBe(
      'Applied edit to "The War.md" (fuzzy match).',
    );
    expect(editDispositionMessage("edit", "The War.md", "applied", undefined, "whitespace")).toBe(
      'Applied edit to "The War.md" (whitespace-corrected match).',
    );
  });

  it("combines the auto-applied flag and the match type in one parenthetical", () => {
    expect(editDispositionMessage("edit", "The War.md", "auto-applied", undefined, "fuzzy")).toBe(
      'Applied edit to "The War.md" (auto-applied, fuzzy match).',
    );
  });

  it("stays quiet about a clean (exact) match, nothing to teach", () => {
    expect(editDispositionMessage("edit", "The War.md", "applied", undefined, "exact")).toBe(
      'Applied edit to "The War.md".',
    );
    expect(editDispositionMessage("edit", "The War.md", "auto-applied", undefined, "exact")).toBe(
      'Applied edit to "The War.md" (auto-applied).',
    );
  });

  it("flags a non-unique search on an applied edit so the model can disambiguate", () => {
    // The search matched several identical passages and the engine anchored the first.
    // Telling the model the multiplicity lets it add surrounding context next time
    // rather than trusting a silent first-match guess (symptom C).
    expect(editDispositionMessage("edit", "The War.md", "applied", undefined, "exact", 3)).toBe(
      'Applied edit to "The War.md" (first of 3 matches).',
    );
  });

  it("combines the auto-applied flag, match type, and multiplicity in one parenthetical", () => {
    expect(editDispositionMessage("edit", "The War.md", "auto-applied", undefined, "fuzzy", 2)).toBe(
      'Applied edit to "The War.md" (auto-applied, fuzzy match, first of 2 matches).',
    );
  });

  it("stays quiet about a unique match (count 1 or absent)", () => {
    expect(editDispositionMessage("edit", "The War.md", "applied", undefined, "exact", 1)).toBe(
      'Applied edit to "The War.md".',
    );
    expect(editDispositionMessage("edit", "The War.md", "applied", undefined, "exact")).toBe(
      'Applied edit to "The War.md".',
    );
  });
});

// RFC-0012: a decline made in the composer drawer can carry the user's reason back to
// the model on the same tool result the loop is already awaiting. Guidance is additive:
// absent, empty, and whitespace-only all have to reproduce today's string byte for byte,
// or every plain decline regresses.
describe("decline guidance", () => {
  const BASE_OP = 'Declined by user, "Notes/Alice.md" was not changed.';
  const BASE_EDIT = 'Declined by user, edit to "The War.md" was not applied.';

  it("leaves the op decline byte-identical for absent, empty, and blank guidance", () => {
    expect(dispositionMessage(CREATE, "declined")).toBe(BASE_OP);
    expect(dispositionMessage(CREATE, "declined", undefined, "")).toBe(BASE_OP);
    expect(dispositionMessage(CREATE, "declined", undefined, "   \n\t ")).toBe(BASE_OP);
  });

  it("leaves the edit decline byte-identical for absent, empty, and blank guidance", () => {
    expect(editDispositionMessage("edit", "The War.md", "declined")).toBe(BASE_EDIT);
    expect(
      editDispositionMessage("edit", "The War.md", "declined", undefined, undefined, undefined, ""),
    ).toBe(BASE_EDIT);
    expect(
      editDispositionMessage(
        "edit",
        "The War.md",
        "declined",
        undefined,
        undefined,
        undefined,
        "  \n ",
      ),
    ).toBe(BASE_EDIT);
  });

  it("appends the guidance as one distinct trailing sentence", () => {
    expect(
      dispositionMessage(CREATE, "declined", undefined, "put it under Drafts/ instead"),
    ).toBe(`${BASE_OP} The user's guidance: put it under Drafts/ instead.`);
    expect(
      editDispositionMessage(
        "edit",
        "The War.md",
        "declined",
        undefined,
        undefined,
        undefined,
        "keep the original opening line",
      ),
    ).toBe(`${BASE_EDIT} The user's guidance: keep the original opening line.`);
  });

  it("trims surrounding space and never doubles the terminal period", () => {
    expect(
      dispositionMessage(CREATE, "declined", undefined, "  use Drafts/ instead.  "),
    ).toBe(`${BASE_OP} The user's guidance: use Drafts/ instead.`);
  });

  it("ignores guidance on every non-declined disposition", () => {
    const guidance = "not a decline";
    expect(dispositionMessage(CREATE, "applied", undefined, guidance)).toBe(
      'Created "Notes/Alice.md".',
    );
    expect(dispositionMessage(CREATE, "auto-applied", undefined, guidance)).toBe(
      'Created "Notes/Alice.md" (auto-applied).',
    );
    expect(dispositionMessage(CREATE, "failed", "path exists", guidance)).toBe(
      'Error: could not create "Notes/Alice.md", path exists.',
    );
    expect(dispositionMessage(DIR, "satisfied", undefined, guidance)).toBe(
      'Folder "Notes/Folder" already exists; nothing to do.',
    );
    expect(dispositionMessage(CREATE, "cancelled", undefined, guidance)).toBe(
      'Generation stopped before you decided, "Notes/Alice.md" is still pending review.',
    );
    expect(
      editDispositionMessage(
        "edit",
        "The War.md",
        "applied",
        undefined,
        undefined,
        undefined,
        guidance,
      ),
    ).toBe('Applied edit to "The War.md".');
    expect(
      editDispositionMessage(
        "edit",
        "The War.md",
        "cancelled",
        undefined,
        undefined,
        undefined,
        guidance,
      ),
    ).toBe('Generation stopped before you decided, edit to "The War.md" is still pending review.');
  });
});
