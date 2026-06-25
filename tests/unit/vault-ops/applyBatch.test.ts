import { describe, it, expect } from "vitest";
import type { App } from "obsidian";
import { TFile, TFolder, normalizePath } from "obsidian";
import { applyVaultOpBatch, undoVaultOpBatch } from "../../../src/vault-ops/applyBatch";
import { applyOperation } from "../../../src/vault-ops/apply";
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
    // Populate children so folderIsEmpty() can see contents added under the folder.
    const prefix = path === "" ? "" : `${path}/`;
    const isDirectChild = (p: string) =>
      p.startsWith(prefix) && p.slice(prefix.length).indexOf("/") === -1;
    for (const f of files.keys()) {
      if (isDirectChild(f)) d.children.push(fileFor(f));
    }
    for (const sub of folders) {
      if (sub !== path && isDirectChild(sub)) d.children.push(folderFor(sub));
    }
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
      trashFile(file: TFile | TFolder) {
        const p = normalizePath(file.path);
        // Mirror Obsidian: trashing a folder takes its whole subtree.
        if (folders.has(p)) {
          folders.delete(p);
          const prefix = `${p}/`;
          for (const f of [...files.keys()]) if (f.startsWith(prefix)) files.delete(f);
          for (const d of [...folders]) if (d.startsWith(prefix)) folders.delete(d);
        } else {
          files.delete(p);
        }
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
    expect(files.has("Fresh.md")).toBe(false); // nothing written, all-or-nothing.
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

  it("refuses to apply an op whose path escapes the vault, and writes nothing", async () => {
    const { app, files } = makeVault();
    const op: VaultOperation = { kind: "create", path: "../../outside-vault.md", content: "x" };

    const result = await applyVaultOpBatch(app, [{ id: "a", op }]);

    expect(result.ok).toBe(false);
    expect(result.conflicts.some((c) => c.reason.includes("outside the vault"))).toBe(true);
    expect(result.applied).toHaveLength(0);
    expect(files.size).toBe(0); // nothing escaped the vault onto disk.
  });

  it("applyOperation itself throws on an escaping path (last line before disk)", async () => {
    const { app, files } = makeVault();
    await expect(
      applyOperation(app, { kind: "create", path: "../../outside-vault.md", content: "x" }),
    ).rejects.toThrow(/outside the vault/);
    expect(files.size).toBe(0);
  });

  it("applies a replaceInVault across every target and records a restoring inverse", async () => {
    const vault = makeVault();
    const eA = vault.seedFile("Lore/A.md", "old A old");
    const eB = vault.seedFile("Lore/B.md", "old B");
    const op: VaultOperation = {
      kind: "replaceInVault",
      search: "old",
      replace: "new",
      caseSensitive: false,
      wholeWord: false,
      targets: [
        { path: "Lore/A.md", content: "new A new", expect: eA },
        { path: "Lore/B.md", content: "new B", expect: eB },
      ],
      occurrences: 3,
    };

    const result = await applyVaultOpBatch(vault.app, [{ id: "r", op }]);

    expect(result.ok).toBe(true);
    expect(vault.files.get("Lore/A.md")?.content).toBe("new A new");
    expect(vault.files.get("Lore/B.md")?.content).toBe("new B");
    expect(result.applied[0].inverse).toMatchObject({ kind: "replaceInVault" });
  });

  it("aborts a replaceInVault when any target's fingerprint drifted, writing nothing", async () => {
    const vault = makeVault();
    const eA = vault.seedFile("Lore/A.md", "old A");
    vault.seedFile("Lore/B.md", "old B");
    const stale: TargetFingerprint = { mtime: 1, size: 1 };
    const op: VaultOperation = {
      kind: "replaceInVault",
      search: "old",
      replace: "new",
      caseSensitive: false,
      wholeWord: false,
      targets: [
        { path: "Lore/A.md", content: "new A", expect: eA },
        { path: "Lore/B.md", content: "new B", expect: stale },
      ],
      occurrences: 2,
    };

    const result = await applyVaultOpBatch(vault.app, [{ id: "r", op }]);

    expect(result.ok).toBe(false);
    expect(vault.files.get("Lore/A.md")?.content).toBe("old A"); // all-or-nothing
    expect(vault.files.get("Lore/B.md")?.content).toBe("old B");
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

  it("round-trips a replaceInVault: undo restores every original file", async () => {
    const vault = makeVault();
    const eA = vault.seedFile("A.md", "old A");
    const eB = vault.seedFile("B.md", "old B old");

    const apply = await applyVaultOpBatch(vault.app, [
      {
        id: "r",
        op: {
          kind: "replaceInVault",
          search: "old",
          replace: "new",
          caseSensitive: false,
          wholeWord: false,
          targets: [
            { path: "A.md", content: "new A", expect: eA },
            { path: "B.md", content: "new B new", expect: eB },
          ],
          occurrences: 3,
        },
      },
    ]);
    expect(apply.ok).toBe(true);
    expect(vault.files.get("A.md")?.content).toBe("new A");
    expect(vault.files.get("B.md")?.content).toBe("new B new");

    const undo = await undoVaultOpBatch(vault.app, {
      proposalId: "p",
      applied: apply.applied,
      appliedAt: 0,
    });

    expect(undo.ok).toBe(true);
    expect(vault.files.get("A.md")?.content).toBe("old A");
    expect(vault.files.get("B.md")?.content).toBe("old B old");
  });
});

describe("undoVaultOpBatch drift guard (§3-B amendment 3)", () => {
  it("refuses to undo a create when the created file changed since apply", async () => {
    const vault = makeVault();
    const apply = await applyVaultOpBatch(vault.app, [
      { id: "a", op: { kind: "create", path: "New.md", content: "v1" } },
    ]);
    // Simulate the user editing the file after it was created.
    await vault.app.vault.process(vault.app.vault.getFileByPath("New.md")!, () => "v2 edited");

    const undo = await undoVaultOpBatch(vault.app, {
      proposalId: "p",
      applied: apply.applied,
      appliedAt: 0,
    });

    expect(undo.ok).toBe(false);
    expect(undo.refused).toBe(true);
    expect(vault.files.has("New.md")).toBe(true); // not trashed, edits preserved.
  });

  it("refuses to undo a trash when the path is occupied again", async () => {
    const vault = makeVault();
    const expect0 = vault.seedFile("Old.md", "keepme");
    const apply = await applyVaultOpBatch(vault.app, [
      { id: "t", op: { kind: "trash", path: "Old.md", expect: expect0, snapshot: "keepme" } },
    ]);
    expect(apply.ok).toBe(true);
    // A new file now lives at the trashed path.
    vault.seedFile("Old.md", "different file");

    const undo = await undoVaultOpBatch(vault.app, {
      proposalId: "p",
      applied: apply.applied,
      appliedAt: 0,
    });

    expect(undo.refused).toBe(true);
    expect(vault.files.get("Old.md")?.content).toBe("different file"); // not resurrected over.
  });

  it("refuses to undo a move when the destination is occupied again", async () => {
    const vault = makeVault();
    const expect0 = vault.seedFile("Inbox/D.md", "body");
    const apply = await applyVaultOpBatch(vault.app, [
      { id: "m", op: { kind: "move", from: "Inbox/D.md", to: "Done/D.md", expect: expect0 } },
    ]);
    expect(apply.ok).toBe(true);
    // The original location was filled by something else after the move.
    vault.seedFile("Inbox/D.md", "new occupant");

    const undo = await undoVaultOpBatch(vault.app, {
      proposalId: "p",
      applied: apply.applied,
      appliedAt: 0,
    });

    expect(undo.refused).toBe(true);
    expect(vault.files.get("Inbox/D.md")?.content).toBe("new occupant");
    expect(vault.files.has("Done/D.md")).toBe(true); // moved file untouched.
  });

  it("refuses to undo a createDir when the folder is no longer empty (Finding E)", async () => {
    const vault = makeVault();
    const apply = await applyVaultOpBatch(vault.app, [
      { id: "d", op: { kind: "createDir", path: "Test Folder" } },
    ]);
    expect(apply.ok).toBe(true);
    expect(vault.folders.has("Test Folder")).toBe(true);
    // A later turn adds a file inside the folder.
    vault.seedFile("Test Folder/note.md", "user content");

    const undo = await undoVaultOpBatch(vault.app, {
      proposalId: "p",
      applied: apply.applied,
      appliedAt: 0,
    });

    expect(undo.ok).toBe(false);
    expect(undo.refused).toBe(true);
    expect(vault.folders.has("Test Folder")).toBe(true); // folder kept...
    expect(vault.files.has("Test Folder/note.md")).toBe(true); // ...and its contents preserved.
  });

  it("undoes a createDir when the folder is still empty (Finding E)", async () => {
    const vault = makeVault();
    const apply = await applyVaultOpBatch(vault.app, [
      { id: "d", op: { kind: "createDir", path: "Empty Folder" } },
    ]);
    expect(apply.ok).toBe(true);

    const undo = await undoVaultOpBatch(vault.app, {
      proposalId: "p",
      applied: apply.applied,
      appliedAt: 0,
    });

    expect(undo.ok).toBe(true);
    expect(undo.refused).toBeUndefined();
    expect(vault.folders.has("Empty Folder")).toBe(false); // empty folder removed cleanly.
  });

  it("still undoes cleanly when nothing drifted", async () => {
    const vault = makeVault();
    const apply = await applyVaultOpBatch(vault.app, [
      { id: "a", op: { kind: "create", path: "Clean.md", content: "hi" } },
    ]);

    const undo = await undoVaultOpBatch(vault.app, {
      proposalId: "p",
      applied: apply.applied,
      appliedAt: 0,
    });

    expect(undo.ok).toBe(true);
    expect(undo.refused).toBeUndefined();
    expect(vault.files.has("Clean.md")).toBe(false);
  });

  it("refuses to undo a replaceInVault when a rewritten file changed since apply", async () => {
    const vault = makeVault();
    const eA = vault.seedFile("A.md", "old A");
    const apply = await applyVaultOpBatch(vault.app, [
      {
        id: "r",
        op: {
          kind: "replaceInVault",
          search: "old",
          replace: "new",
          caseSensitive: false,
          wholeWord: false,
          targets: [{ path: "A.md", content: "new A", expect: eA }],
          occurrences: 1,
        },
      },
    ]);
    expect(apply.ok).toBe(true);
    // The user hand-edits the rewritten file after the replace applied.
    await vault.app.vault.process(vault.app.vault.getFileByPath("A.md")!, () => "hand edited");

    const undo = await undoVaultOpBatch(vault.app, {
      proposalId: "p",
      applied: apply.applied,
      appliedAt: 0,
    });

    expect(undo.refused).toBe(true);
    expect(vault.files.get("A.md")?.content).toBe("hand edited"); // not clobbered.
  });
});
