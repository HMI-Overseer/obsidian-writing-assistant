import { describe, it, expect } from "vitest";
import { dispositionMessage } from "../../../src/vault-ops/disposition";
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

  it("carries the failure reason in lower-case infinitive", () => {
    expect(dispositionMessage(CREATE, "failed", "path exists")).toBe(
      'Failed to create "Notes/Vex.md": path exists.',
    );
    expect(dispositionMessage(MOVE, "failed", "target busy")).toBe(
      'Failed to move "a.md" → "b.md": target busy.',
    );
  });

  it("falls back to a generic reason when none is given", () => {
    expect(dispositionMessage(CREATE, "failed")).toBe('Failed to create "Notes/Vex.md": operation failed.');
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
