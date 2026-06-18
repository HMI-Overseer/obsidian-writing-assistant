import { describe, it, expect } from "vitest";
import { dispositionMessage, editDispositionMessage } from "../../../src/vault-ops/disposition";
import type { VaultOperation } from "../../../src/vault-ops/types";

const FP = { mtime: 1, size: 2 };

const CREATE: VaultOperation = { kind: "create", path: "Notes/Vex.md", content: "hi" };
const OVERWRITE: VaultOperation = { kind: "overwrite", path: "Notes/Vex.md", content: "hi", expect: FP };
const DIR: VaultOperation = { kind: "createDir", path: "Notes/Folder" };
const MOVE: VaultOperation = { kind: "move", from: "a.md", to: "b.md", expect: FP };
const TRASH: VaultOperation = { kind: "trash", path: "a.md", expect: FP, snapshot: "x" };

describe("dispositionMessage", () => {
  it("reports an applied op in the past tense, with the path", () => {
    expect(dispositionMessage(CREATE, "applied")).toBe('Created "Notes/Vex.md".');
    expect(dispositionMessage(OVERWRITE, "applied")).toBe('Overwrote "Notes/Vex.md".');
    expect(dispositionMessage(DIR, "applied")).toBe('Created folder "Notes/Folder".');
    expect(dispositionMessage(TRASH, "applied")).toBe('Trashed "a.md".');
  });

  it("shows both endpoints for a move", () => {
    expect(dispositionMessage(MOVE, "applied")).toBe('Moved "a.md" → "b.md".');
  });

  it("flags an auto-applied op so the model knows there was no click", () => {
    expect(dispositionMessage(CREATE, "auto-applied")).toBe('Created "Notes/Vex.md" (auto-applied).');
  });

  it("says the op was declined and not changed", () => {
    expect(dispositionMessage(CREATE, "declined")).toBe('Declined by user — "Notes/Vex.md" was not changed.');
  });

  it("prefixes 'Error:' and carries the failure reason in lower-case infinitive", () => {
    expect(dispositionMessage(CREATE, "failed", "path exists")).toBe(
      'Error: could not create "Notes/Vex.md" — path exists.',
    );
    expect(dispositionMessage(MOVE, "failed", "target busy")).toBe(
      'Error: could not move "a.md" → "b.md" — target busy.',
    );
  });

  it("falls back to a generic reason when none is given", () => {
    expect(dispositionMessage(CREATE, "failed")).toBe(
      'Error: could not create "Notes/Vex.md" — the operation failed.',
    );
  });

  it("describes a satisfied directory no-op without asserting a change", () => {
    expect(dispositionMessage(DIR, "satisfied")).toBe('Folder "Notes/Folder" already exists; nothing to do.');
  });

  it("reports a cancelled op as still pending review", () => {
    expect(dispositionMessage(CREATE, "cancelled")).toBe(
      'Generation stopped before you decided — "Notes/Vex.md" is still pending review.',
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
      'Declined by user — edit to "The War.md" was not applied.',
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
      'Error: propose_edit did not apply to "The War.md" — no location matched the search text; re-read the file and retry.',
    );
    expect(editDispositionMessage("frontmatter", "The War.md", "failed")).toBe(
      'Error: update_frontmatter did not apply to "The War.md" — the edit could not be resolved.',
    );
  });

  it("reports a cancelled edit as still pending review", () => {
    expect(editDispositionMessage("edit", "The War.md", "cancelled")).toBe(
      'Generation stopped before you decided — edit to "The War.md" is still pending review.',
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

  it("stays quiet about a clean (exact) match — nothing to teach", () => {
    expect(editDispositionMessage("edit", "The War.md", "applied", undefined, "exact")).toBe(
      'Applied edit to "The War.md".',
    );
    expect(editDispositionMessage("edit", "The War.md", "auto-applied", undefined, "exact")).toBe(
      'Applied edit to "The War.md" (auto-applied).',
    );
  });
});
