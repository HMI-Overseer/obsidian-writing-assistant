import { describe, it, expect } from "vitest";
import {
  formatBytes,
  summarizeOp,
  gateBadgeLabel,
  opPrimaryPath,
  commonAncestorDir,
  describeOpInHierarchy,
  opDetailText,
} from "../../../src/vault-ops/summary";
import type { VaultOperation } from "../../../src/vault-ops/types";

const FP = { mtime: 1, size: 2 };

describe("formatBytes", () => {
  it("formats small sizes in bytes", () => {
    expect(formatBytes("hello")).toBe("5 B");
    expect(formatBytes("")).toBe("0 B");
  });

  it("formats kilobytes with one decimal", () => {
    expect(formatBytes("x".repeat(2048))).toBe("2.0 KB");
  });

  it("counts UTF-8 byte length, not character length", () => {
    // "€" is 3 bytes in UTF-8.
    expect(formatBytes("€")).toBe("3 B");
  });
});

describe("summarizeOp", () => {
  it("summarizes a create with its size", () => {
    const op: VaultOperation = { kind: "create", path: "Characters/Vex.md", content: "hi" };
    expect(summarizeOp(op)).toBe("New file Characters/Vex.md (2 B)");
  });

  it("summarizes an overwrite", () => {
    const op: VaultOperation = { kind: "overwrite", path: "A.md", content: "abc", expect: FP };
    expect(summarizeOp(op)).toBe("Overwrite A.md (3 B)");
  });

  it("summarizes a createDir", () => {
    expect(summarizeOp({ kind: "createDir", path: "Characters/Minor" })).toBe(
      "New folder Characters/Minor",
    );
  });

  it("summarizes a move with an arrow", () => {
    const op: VaultOperation = { kind: "move", from: "Inbox/D.md", to: "C/D.md", expect: FP };
    expect(summarizeOp(op)).toBe("Move Inbox/D.md → C/D.md");
  });

  it("summarizes a trash", () => {
    const op: VaultOperation = { kind: "trash", path: "Old.md", expect: FP, snapshot: "x" };
    expect(summarizeOp(op)).toBe("Trash Old.md");
  });

  it("summarizes a folder move with an arrow", () => {
    const op: VaultOperation = { kind: "moveFolder", from: "Drafts/Act II", to: "Manuscript/Act II" };
    expect(summarizeOp(op)).toBe("Move folder Drafts/Act II → Manuscript/Act II");
  });

  it("summarizes a folder trash, naming the empty-only scope", () => {
    const op: VaultOperation = { kind: "trashFolder", path: "Drafts/Act II" };
    expect(summarizeOp(op)).toBe("Trash empty folder Drafts/Act II");
  });

  it("summarizes a replaceInVault with its terms, note count, and match count", () => {
    const op: VaultOperation = {
      kind: "replaceInVault",
      search: "Age of Laurels",
      replace: "Age of Ambition",
      caseSensitive: false,
      wholeWord: false,
      targets: [
        { path: "Lore/A.md", content: "x", expect: FP },
        { path: "Lore/B.md", content: "y", expect: FP },
      ],
      occurrences: 3,
    };
    expect(summarizeOp(op)).toBe(
      'Replace "Age of Laurels" → "Age of Ambition" in 2 notes (3 matches)',
    );
  });

  it("uses the singular for a single-note replace", () => {
    const op: VaultOperation = {
      kind: "replaceInVault",
      search: "a",
      replace: "b",
      caseSensitive: false,
      wholeWord: false,
      targets: [{ path: "One.md", content: "x", expect: FP }],
      occurrences: 1,
    };
    expect(summarizeOp(op)).toBe('Replace "a" → "b" in 1 note (1 matches)');
  });
});

describe("gateBadgeLabel", () => {
  it("maps gates to badge labels", () => {
    expect(gateBadgeLabel("auto")).toBe("Auto");
    expect(gateBadgeLabel("ask")).toBe("Review");
    expect(gateBadgeLabel("deny")).toBe("Denied");
  });
});

describe("opPrimaryPath", () => {
  it("returns the path for non-move ops", () => {
    expect(opPrimaryPath({ kind: "create", path: "A/B.md", content: "x" })).toBe("A/B.md");
    expect(opPrimaryPath({ kind: "createDir", path: "A/B" })).toBe("A/B");
  });

  it("returns the destination for a move", () => {
    expect(opPrimaryPath({ kind: "move", from: "Inbox/D.md", to: "C/D.md", expect: FP })).toBe(
      "C/D.md",
    );
  });

  it("returns the destination for a folder move and the path for a folder trash", () => {
    expect(opPrimaryPath({ kind: "moveFolder", from: "A", to: "B/C" })).toBe("B/C");
    expect(opPrimaryPath({ kind: "trashFolder", path: "A/B" })).toBe("A/B");
  });
});

describe("commonAncestorDir", () => {
  it("returns the shared leading directory", () => {
    expect(commonAncestorDir(["A/B/x.md", "A/B/y.md", "A/B/C/z.md"])).toBe("A/B");
  });

  it("returns '' when paths share no leading folder", () => {
    expect(commonAncestorDir(["A/x.md", "B/y.md"])).toBe("");
  });

  it("matches whole segments only, not name prefixes", () => {
    expect(commonAncestorDir(["Ab/x.md", "Abc/y.md"])).toBe("");
  });

  it("ignores leaf names when computing the directory", () => {
    // Two files directly under "A" share directory "A", not "A/x".
    expect(commonAncestorDir(["A/x.md", "A/y.md"])).toBe("A");
  });

  it("returns '' for an empty list", () => {
    expect(commonAncestorDir([])).toBe("");
  });
});

describe("describeOpInHierarchy", () => {
  it("strips the root prefix and reports depth", () => {
    const op: VaultOperation = { kind: "create", path: "A/B/C/note.md", content: "x" };
    expect(describeOpInHierarchy(op, "A/B")).toEqual({
      relativePath: "C/note.md",
      leaf: "note.md",
      depth: 1,
    });
  });

  it("treats a root-level op as depth 0", () => {
    const op: VaultOperation = { kind: "createDir", path: "A/B" };
    expect(describeOpInHierarchy(op, "A")).toEqual({
      relativePath: "B",
      leaf: "B",
      depth: 0,
    });
  });

  it("keeps the full path when there is no shared root", () => {
    const op: VaultOperation = { kind: "create", path: "X/y.md", content: "x" };
    expect(describeOpInHierarchy(op, "")).toEqual({
      relativePath: "X/y.md",
      leaf: "y.md",
      depth: 1,
    });
  });
});

describe("opDetailText", () => {
  it("describes each op kind with a muted detail", () => {
    expect(opDetailText({ kind: "create", path: "A.md", content: "hi" })).toBe("new file · 2 B");
    expect(opDetailText({ kind: "overwrite", path: "A.md", content: "abc", expect: FP })).toBe(
      "overwrite · 3 B",
    );
    expect(opDetailText({ kind: "createDir", path: "A/B" })).toBe("new folder");
    expect(opDetailText({ kind: "move", from: "Inbox/D.md", to: "C/D.md", expect: FP })).toBe(
      "moved from Inbox/D.md",
    );
    expect(opDetailText({ kind: "trash", path: "Old.md", expect: FP, snapshot: "x" })).toBe("trash");
    expect(opDetailText({ kind: "moveFolder", from: "Drafts/X", to: "Manuscript/X" })).toBe(
      "folder moved from Drafts/X",
    );
    expect(opDetailText({ kind: "trashFolder", path: "Drafts/X" })).toBe("trash empty folder");
  });
});
