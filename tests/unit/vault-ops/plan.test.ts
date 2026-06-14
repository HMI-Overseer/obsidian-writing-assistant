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
});
