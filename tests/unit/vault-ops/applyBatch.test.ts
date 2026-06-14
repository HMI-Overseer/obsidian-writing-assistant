import { describe, it, expect } from "vitest";
import type { App } from "obsidian";
import { TFile, TFolder, normalizePath } from "obsidian";
import { applyVaultOpBatch, undoVaultOpBatch } from "../../../src/vault-ops/applyBatch";
import type { TargetFingerprint, VaultOperation } from "../../../src/vault-ops/types";

type FileRec = { content: string; mtime: number; size: number };
type StatFile = TFile & { stat: { mtime: number; size: number } };

/** A minimal in-memory vault backing the disk-touching executor. */
function makeVault() {
  const files = new Map<string, FileRec>();
  const folders = new Set<string>();
  let clock = 1000;

  const fileFor = (path: string): StatFile => {
    const rec = files.get(path);
    const f = new TFile() as StatFile;
    f.path = path;
    f.stat = { mtime: rec?.mtime ?? 0, size: rec?.size ?? 0 };
    return f;
  };
  const folderFor = (path: string): TFolder => {
    const d = new TFolder();
    d.path = path;
    return d;
  };

  const app = {
    vault: {
      getAbstractFileByPath(path: string) {
        const p = normalizePath(path);
        if (files.has(p)) return fileFor(p);
        if (folders.has(p)) return folderFor(p);
        return null;
      },
      getFileByPath(path: string) {
        const p = normalizePath(path);
        return files.has(p) ? fileFor(p) : null;
      },
      read(file: TFile) {
        return Promise.resolve(files.get(normalizePath(file.path))?.content ?? "");
      },
      create(path: string, content: string) {
        const p = normalizePath(path);
        files.set(p, { content, mtime: ++clock, size: content.length });
        return Promise.resolve();
      },
      process(file: TFile, fn: (c: string) => string) {
        const p = normalizePath(file.path);
        const cur = files.get(p);
        const next = fn(cur?.content ?? "");
        files.set(p, { content: next, mtime: ++clock, size: next.length });
        return Promise.resolve(next);
      },
      createFolder(path: string) {
        folders.add(normalizePath(path));
        return Promise.resolve();
      },
    },
    fileManager: {
      renameFile(file: TFile, to: string) {
        const from = normalizePath(file.path);
        const rec = files.get(from);
        if (rec) {
          files.delete(from);
          files.set(normalizePath(to), { ...rec, mtime: ++clock });
        }
        return Promise.resolve();
      },
      trashFile(file: TFile) {
        files.delete(normalizePath(file.path));
        return Promise.resolve();
      },
    },
  } as unknown as App;

  const seedFile = (path: string, content: string): TargetFingerprint => {
    const p = normalizePath(path);
    files.set(p, { content, mtime: ++clock, size: content.length });
    const rec = files.get(p)!;
    return { mtime: rec.mtime, size: rec.size };
  };

  return { app, files, folders, seedFile };
}

describe("applyVaultOpBatch", () => {
  it("applies a create and records a trash inverse", async () => {
    const { app, files } = makeVault();
    const op: VaultOperation = { kind: "create", path: "Characters/Vex.md", content: "hi" };

    const result = await applyVaultOpBatch(app, [{ id: "a", op }]);

    expect(result.ok).toBe(true);
    expect(files.has("Characters/Vex.md")).toBe(true);
    expect(result.applied).toHaveLength(1);
    expect(result.applied[0]).toMatchObject({ opId: "a", inverse: { kind: "trash" } });
  });

  it("orders createDir before a create that lands under it", async () => {
    const { app, folders, files } = makeVault();
    const ops = [
      { id: "f", op: { kind: "create", path: "New/Note.md", content: "x" } as VaultOperation },
      { id: "d", op: { kind: "createDir", path: "New" } as VaultOperation },
    ];

    const result = await applyVaultOpBatch(app, ops);

    expect(result.ok).toBe(true);
    expect(folders.has("New")).toBe(true);
    expect(files.has("New/Note.md")).toBe(true);
  });

  it("aborts the whole batch on a pre-flight conflict and writes nothing", async () => {
    const { app, files } = makeVault();
    files.set("Exists.md", { content: "old", mtime: 5, size: 3 });

    const ops = [
      { id: "a", op: { kind: "create", path: "Fresh.md", content: "new" } as VaultOperation },
      { id: "b", op: { kind: "create", path: "Exists.md", content: "x" } as VaultOperation },
    ];

    const result = await applyVaultOpBatch(app, ops);

    expect(result.ok).toBe(false);
    expect(result.conflicts.length).toBeGreaterThan(0);
    expect(result.applied).toHaveLength(0);
    expect(files.has("Fresh.md")).toBe(false); // nothing written — all-or-nothing.
  });

  it("rejects an overwrite whose fingerprint drifted", async () => {
    const vault = makeVault();
    vault.seedFile("A.md", "original");
    const stale: TargetFingerprint = { mtime: 1, size: 1 }; // does not match disk

    const result = await applyVaultOpBatch(vault.app, [
      { id: "a", op: { kind: "overwrite", path: "A.md", content: "new", expect: stale } },
    ]);

    expect(result.ok).toBe(false);
    expect(vault.files.get("A.md")?.content).toBe("original");
  });
});

describe("undoVaultOpBatch", () => {
  it("undoes a create by trashing the file", async () => {
    const { app, files } = makeVault();
    const apply = await applyVaultOpBatch(app, [
      { id: "a", op: { kind: "create", path: "X.md", content: "hi" } },
    ]);
    expect(files.has("X.md")).toBe(true);

    const undo = await undoVaultOpBatch(app, {
      proposalId: "p",
      applied: apply.applied,
      appliedAt: 0,
    });

    expect(undo.ok).toBe(true);
    expect(files.has("X.md")).toBe(false);
  });

  it("round-trips an overwrite: undo restores the original content", async () => {
    const vault = makeVault();
    const expect0 = vault.seedFile("A.md", "original");

    const apply = await applyVaultOpBatch(vault.app, [
      { id: "a", op: { kind: "overwrite", path: "A.md", content: "changed", expect: expect0 } },
    ]);
    expect(apply.ok).toBe(true);
    expect(vault.files.get("A.md")?.content).toBe("changed");

    const undo = await undoVaultOpBatch(vault.app, {
      proposalId: "p",
      applied: apply.applied,
      appliedAt: 0,
    });

    expect(undo.ok).toBe(true);
    expect(vault.files.get("A.md")?.content).toBe("original");
  });

  it("round-trips a move: undo moves the file back", async () => {
    const vault = makeVault();
    const expect0 = vault.seedFile("Inbox/D.md", "body");

    const apply = await applyVaultOpBatch(vault.app, [
      { id: "m", op: { kind: "move", from: "Inbox/D.md", to: "Done/D.md", expect: expect0 } },
    ]);
    expect(apply.ok).toBe(true);
    expect(vault.files.has("Done/D.md")).toBe(true);
    expect(vault.files.has("Inbox/D.md")).toBe(false);

    await undoVaultOpBatch(vault.app, {
      proposalId: "p",
      applied: apply.applied,
      appliedAt: 0,
    });

    expect(vault.files.has("Inbox/D.md")).toBe(true);
    expect(vault.files.has("Done/D.md")).toBe(false);
  });

  it("round-trips a trash: undo re-creates from the snapshot", async () => {
    const vault = makeVault();
    const expect0 = vault.seedFile("Old.md", "keepme");

    const apply = await applyVaultOpBatch(vault.app, [
      { id: "t", op: { kind: "trash", path: "Old.md", expect: expect0, snapshot: "keepme" } },
    ]);
    expect(apply.ok).toBe(true);
    expect(vault.files.has("Old.md")).toBe(false);

    await undoVaultOpBatch(vault.app, {
      proposalId: "p",
      applied: apply.applied,
      appliedAt: 0,
    });

    expect(vault.files.get("Old.md")?.content).toBe("keepme");
  });
});
