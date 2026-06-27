import { describe, test, expect } from "vitest";
import { inverseOf, orderOps, preflight } from "../../../src/vault-ops/plan";
import type { DiskSnapshot } from "../../../src/vault-ops/plan";
import type { PathState, TargetFingerprint, VaultOperation } from "../../../src/vault-ops/types";

const FP: TargetFingerprint = { mtime: 100, size: 50 };

/** Build a fake disk from a map of path → [state, fingerprint?]. */
function disk(entries: Record<string, [PathState, TargetFingerprint?]>): DiskSnapshot {
  return {
    state: (p) => entries[p]?.[0] ?? "absent",
    fingerprint: (p) => entries[p]?.[1] ?? null,
  };
}

describe("preflight", () => {
  test("create requires the path to be absent", () => {
    const op: VaultOperation = { kind: "create", path: "a.md", content: "x" };
    expect(preflight([op], disk({})).ok).toBe(true);
    expect(preflight([op], disk({ "a.md": ["file"] })).ok).toBe(false);
  });

  test("createDir is idempotent on an existing folder but conflicts with a file", () => {
    const op: VaultOperation = { kind: "createDir", path: "Folder" };
    expect(preflight([op], disk({ "Folder": ["dir"] })).ok).toBe(true);
    expect(preflight([op], disk({ "Folder": ["file"] })).ok).toBe(false);
  });

  test("overwrite requires a matching fingerprint", () => {
    const op: VaultOperation = { kind: "overwrite", path: "a.md", content: "x", expect: FP };
    expect(preflight([op], disk({ "a.md": ["file", FP] })).ok).toBe(true);
    expect(preflight([op], disk({ "a.md": ["file", { mtime: 999, size: 50 }] })).ok).toBe(false);
    expect(preflight([op], disk({})).ok).toBe(false);
  });

  test("move requires matching source and an absent destination", () => {
    const op: VaultOperation = { kind: "move", from: "a.md", to: "b.md", expect: FP };
    expect(preflight([op], disk({ "a.md": ["file", FP] })).ok).toBe(true);
    expect(preflight([op], disk({ "a.md": ["file", FP], "b.md": ["file"] })).ok).toBe(false);
  });

  test("trash requires a matching fingerprint", () => {
    const op: VaultOperation = { kind: "trash", path: "a.md", expect: FP, snapshot: "old" };
    expect(preflight([op], disk({ "a.md": ["file", FP] })).ok).toBe(true);
    expect(preflight([op], disk({})).ok).toBe(false);
  });

  test("moveFolder needs a folder source and an absent destination (no fingerprint)", () => {
    const op: VaultOperation = { kind: "moveFolder", from: "Drafts/X", to: "Manuscript/X" };
    expect(preflight([op], disk({ "Drafts/X": ["dir"] })).ok).toBe(true);
    // Source gone.
    expect(preflight([op], disk({})).ok).toBe(false);
    // Destination occupied.
    expect(preflight([op], disk({ "Drafts/X": ["dir"], "Manuscript/X": ["dir"] })).ok).toBe(false);
  });

  test("trashFolder checks existence only; emptiness is deferred to apply", () => {
    const op: VaultOperation = { kind: "trashFolder", path: "Drafts/X" };
    // A folder that still exists passes pre-flight even if it has children on disk:
    // the disk snapshot carries no child-set, so emptiness is enforced at apply, not
    // here. This is what lets a same-batch move empty the husk before it is trashed.
    expect(preflight([op], disk({ "Drafts/X": ["dir"] })).ok).toBe(true);
    // Not a folder (absent or a file) is a conflict.
    expect(preflight([op], disk({})).ok).toBe(false);
    expect(preflight([op], disk({ "Drafts/X": ["file"] })).ok).toBe(false);
  });

  test("refuses a folder op whose endpoint escapes the vault", () => {
    const mv: VaultOperation = { kind: "moveFolder", from: "A", to: "../../X" };
    const rm = preflight([mv], disk({ A: ["dir"] }));
    expect(rm.ok).toBe(false);
    expect(rm.conflicts.some((c) => c.reason.includes("outside the vault"))).toBe(true);
  });

  test("reports every conflicting op", () => {
    const ops: VaultOperation[] = [
      { kind: "create", path: "exists.md", content: "x" },
      { kind: "create", path: "fine.md", content: "x" },
    ];
    const result = preflight(ops, disk({ "exists.md": ["file"] }));
    expect(result.ok).toBe(false);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0].index).toBe(0);
  });

  test("refuses any op whose path escapes the vault (authoritative boundary)", () => {
    const create: VaultOperation = { kind: "create", path: "../../outside.md", content: "x" };
    const rc = preflight([create], disk({}));
    expect(rc.ok).toBe(false);
    expect(rc.conflicts[0].reason).toContain("outside the vault");

    // A move with a safe source but an escaping destination is still refused.
    const move: VaultOperation = { kind: "move", from: "A.md", to: "../../x.md", expect: FP };
    const rm = preflight([move], disk({ "A.md": ["file", FP] }));
    expect(rm.ok).toBe(false);
    expect(rm.conflicts.some((c) => c.reason.includes("outside the vault"))).toBe(true);
  });
});

describe("orderOps", () => {
  test("orders by kind: createDir → create/overwrite → move → trash", () => {
    const ops: VaultOperation[] = [
      { kind: "trash", path: "old.md", expect: FP, snapshot: "" },
      { kind: "move", from: "x.md", to: "y.md", expect: FP },
      { kind: "create", path: "n.md", content: "" },
      { kind: "createDir", path: "Dir" },
    ];
    expect(orderOps(ops).map((o) => o.kind)).toEqual(["createDir", "create", "move", "trash"]);
  });

  test("createDir precedes a file created under it even if listed later", () => {
    const ops: VaultOperation[] = [
      { kind: "create", path: "New/a.md", content: "" },
      { kind: "createDir", path: "New" },
    ];
    const ordered = orderOps(ops);
    expect(ordered[0]).toEqual({ kind: "createDir", path: "New" });
  });

  test("a freshly written file precedes a move that uses it as source", () => {
    const ops: VaultOperation[] = [
      { kind: "move", from: "a.md", to: "b.md", expect: FP },
      { kind: "create", path: "a.md", content: "" },
    ];
    const ordered = orderOps(ops);
    expect(ordered[0].kind).toBe("create");
    expect(ordered[1].kind).toBe("move");
  });

  test("output length always matches input", () => {
    const ops: VaultOperation[] = [
      { kind: "create", path: "a.md", content: "" },
      { kind: "create", path: "b.md", content: "" },
    ];
    expect(orderOps(ops)).toHaveLength(2);
  });

  test("a husk-emptying move/moveFolder is ordered before the trashFolder that removes it", () => {
    // The reorg story: move the notes out, then trash the empty husk. The folder trash
    // must run last so the folder is genuinely empty by the time apply checks it.
    const ops: VaultOperation[] = [
      { kind: "trashFolder", path: "Drafts/Act II" },
      { kind: "move", from: "Drafts/Act II/a.md", to: "Manuscript/a.md", expect: FP },
      { kind: "moveFolder", from: "Drafts/Act II/sub", to: "Manuscript/sub" },
    ];
    const kinds = orderOps(ops).map((o) => o.kind);
    expect(kinds.indexOf("trashFolder")).toBe(kinds.length - 1);
    expect(kinds.indexOf("move")).toBeLessThan(kinds.indexOf("trashFolder"));
    expect(kinds.indexOf("moveFolder")).toBeLessThan(kinds.indexOf("trashFolder"));
  });
});

describe("inverseOf", () => {
  test("create ⇄ trash(snapshot=content)", () => {
    const op: VaultOperation = { kind: "create", path: "a.md", content: "hello" };
    expect(inverseOf(op, { fingerprint: FP })).toEqual({
      kind: "trash",
      path: "a.md",
      expect: FP,
      snapshot: "hello",
    });
  });

  test("overwrite inverse restores the captured pre-content", () => {
    const op: VaultOperation = { kind: "overwrite", path: "a.md", content: "new", expect: FP };
    expect(inverseOf(op, { preContent: "old", fingerprint: FP })).toEqual({
      kind: "overwrite",
      path: "a.md",
      content: "old",
      expect: FP,
    });
  });

  test("createDir inverse trashes the folder, or is a no-op if it pre-existed", () => {
    const op: VaultOperation = { kind: "createDir", path: "Dir" };
    expect(inverseOf(op, { fingerprint: FP })?.kind).toBe("trash");
    expect(inverseOf(op, { dirPreExisted: true })).toBeNull();
  });

  test("move inverse swaps endpoints", () => {
    const op: VaultOperation = { kind: "move", from: "a.md", to: "b.md", expect: FP };
    expect(inverseOf(op, { fingerprint: FP })).toEqual({
      kind: "move",
      from: "b.md",
      to: "a.md",
      expect: FP,
    });
  });

  test("trash inverse re-creates from the snapshot", () => {
    const op: VaultOperation = { kind: "trash", path: "a.md", expect: FP, snapshot: "body" };
    expect(inverseOf(op)).toEqual({ kind: "create", path: "a.md", content: "body" });
  });

  test("moveFolder inverse swaps endpoints (no fingerprint)", () => {
    const op: VaultOperation = { kind: "moveFolder", from: "A", to: "B" };
    expect(inverseOf(op)).toEqual({ kind: "moveFolder", from: "B", to: "A" });
  });

  test("trashFolder inverse re-creates the empty folder (no recursive snapshot)", () => {
    const op: VaultOperation = { kind: "trashFolder", path: "Drafts/Act II" };
    expect(inverseOf(op)).toEqual({ kind: "createDir", path: "Drafts/Act II" });
  });
});
