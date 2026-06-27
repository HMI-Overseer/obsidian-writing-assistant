import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import type { App } from "obsidian";
import { TFile, TFolder, normalizePath } from "obsidian";
import { applyVaultOpBatch } from "../../src/vault-ops/applyBatch";
import { applyOperation } from "../../src/vault-ops/apply";
import { executeVaultOpTool, buildPendingOverlay } from "../../src/tools/vault-ops/handlers";
import { executeVaultTool } from "../../src/tools/vault/handlers";
import { executeEditTool, resolveStructuralEditBlocks } from "../../src/tools/editing/handlers";
import { convertToolCallToEditBlock } from "../../src/tools/editing/conversion";
import { resolveEdits } from "../../src/editing/diffEngine";
import { applyHunksLive } from "../../src/editing/documentApplicator";
import { normalizeVaultToolCall } from "../../src/tools/paths";
import type { VaultOperation } from "../../src/vault-ops/types";
import type { ToolCall } from "../../src/tools/types";
import type { VaultToolContext } from "../../src/tools/vault/handlers";
import type { RagService } from "../../src/rag/ragService";

/**
 * §6.1, verify the vault-write handler against its **real on-disk resolution**, not
 * a string-keyed mock.
 *
 * The unit tests prove our *model* of the boundary: their `vault.create` writes to a
 * `Map`, so an escaping path is just an odd Map key, a real escape would never show.
 * This suite instead backs the vault with **real Node `fs` + `path`** in a throwaway
 * temp vault, reproducing Obsidian's `FileSystemAdapter` resolution faithfully:
 * every write resolves via `path.join(vaultRoot, normalizePath(p))` and hits the
 * actual filesystem. So if the guard's `..`-depth / drive-letter model disagreed
 * with how `path.join` *actually* collapses a path, an escaping op would create a
 * real file outside `vaultRoot` and the disk scan below would catch it.
 *
 * (The genuine Electron `FileSystemAdapter` class is unavailable outside the Obsidian
 * runtime, so it cannot be instantiated in CI. Reproducing its documented resolution
 * with the real `path`/`fs` primitives, and asserting against the real disk, is the
 * faithful stand-in: the part that was previously only an *assumption* (`path.join`
 * vs `path.resolve`, `..` handling, drive-letter / UNC quirks) is now executed for
 * real. The control test below proves the harness genuinely detects an escape, so the
 * guarded assertions are not vacuous.)
 *
 * Layout, the vault sits two levels deep so a `../..` escape lands inside the
 * sandbox (easy to detect and clean up) rather than polluting the OS temp root:
 *
 *   <sandbox>/a/b/vault   ← vaultRoot (the "vault")
 */

let sandbox: string;
let vaultRoot: string;

/** A vault App backed by the real filesystem, resolving exactly as the adapter does. */
function makeRealFsApp(root: string): App {
  const full = (p: string) => nodePath.join(root, normalizePath(p));
  // Real child listing for a folder, so the confusable-path resolver
  // (snapToExistingFile) can scan siblings exactly as it would in the live vault.
  const childrenOf = (relDir: string): (TFile | TFolder)[] => {
    const abs = full(relDir);
    if (!fs.existsSync(abs)) return [];
    const norm = normalizePath(relDir);
    return fs.readdirSync(abs, { withFileTypes: true }).map((entry) => {
      const childRel = normalizePath(norm ? `${norm}/${entry.name}` : entry.name);
      return entry.isDirectory()
        ? Object.assign(new TFolder(), { path: childRel, children: [] })
        : Object.assign(new TFile(), { path: childRel });
    });
  };
  return {
    vault: {
      adapter: { getBasePath: () => root },
      getName: () => nodePath.basename(root),
      getRoot() {
        return Object.assign(new TFolder(), { path: "", children: childrenOf("") });
      },
      getAbstractFileByPath(p: string) {
        const abs = full(p);
        if (!fs.existsSync(abs)) return null;
        const st = fs.statSync(abs);
        if (st.isDirectory()) {
          return Object.assign(new TFolder(), { path: normalizePath(p), children: childrenOf(p) });
        }
        return Object.assign(new TFile(), {
          path: normalizePath(p),
          stat: { mtime: st.mtimeMs, size: st.size },
        });
      },
      getFileByPath(p: string) {
        const abs = full(p);
        if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return null;
        const st = fs.statSync(abs);
        return Object.assign(new TFile(), {
          path: normalizePath(p),
          stat: { mtime: st.mtimeMs, size: st.size },
        });
      },
      read(file: TFile) {
        return Promise.resolve(fs.readFileSync(full(file.path), "utf8"));
      },
      create(p: string, content: string) {
        fs.writeFileSync(full(p), content);
        return Promise.resolve();
      },
      createFolder(p: string) {
        fs.mkdirSync(full(p), { recursive: true });
        return Promise.resolve();
      },
      process(file: TFile, fn: (c: string) => string) {
        const abs = full(file.path);
        const next = fn(fs.readFileSync(abs, "utf8"));
        fs.writeFileSync(abs, next);
        return Promise.resolve(next);
      },
    },
    fileManager: {
      renameFile(file: TFile, to: string) {
        const dest = full(to);
        fs.mkdirSync(nodePath.dirname(dest), { recursive: true });
        fs.renameSync(full(file.path), dest);
        return Promise.resolve();
      },
      trashFile(file: TFile | TFolder) {
        fs.rmSync(full(file.path), { recursive: true, force: true });
        return Promise.resolve();
      },
    },
    metadataCache: { getBacklinksForFile: () => ({ data: {} }) },
  } as unknown as App;
}

/** Every regular file anywhere under the sandbox that does NOT live under vaultRoot. */
function filesOutsideVault(): string[] {
  const escaped: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = nodePath.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
      } else {
        const rel = nodePath.relative(vaultRoot, abs);
        if (rel.startsWith("..") || nodePath.isAbsolute(rel)) escaped.push(abs);
      }
    }
  };
  walk(sandbox);
  return escaped;
}

beforeEach(() => {
  sandbox = fs.mkdtempSync(nodePath.join(os.tmpdir(), "vault-path-boundary-"));
  vaultRoot = nodePath.join(sandbox, "a", "b", "vault");
  fs.mkdirSync(vaultRoot, { recursive: true });
});

afterEach(() => {
  fs.rmSync(sandbox, { recursive: true, force: true });
});

/** Paths the guard MUST refuse (real `..` traversal above root, or a drive letter). */
const ESCAPING_PATHS = [
  "../../outside-vault.md",
  "../../../a/escape.md",
  "..\\..\\win-escape.md", // backslash traversal, normalizePath converts to "../.."
  "foo/../../bar.md", // internal "../" plus one that rises above the root
  "C:/Windows/System32/test.md", // drive-letter absolute
  "d:\\secrets\\note.md",
];

/**
 * Odd shapes the guard intentionally ALLOWS because `path.join` keeps them *inside*
 * the vault (a leading-slash / UNC / percent-encoded / extended-length form is not a
 * `..` escape). They must still never resolve outside vaultRoot, verified on disk.
 */
const ODD_BUT_CONTAINED_PATHS = [
  "/leading-slash.md",
  "\\\\server\\share\\note.md", // UNC-looking, collapses to server/share/note.md inside vault
  "%2e%2e/%2e%2e/encoded.md", // percent-encoded ".." is NOT decoded by the adapter
  "trailing.dot./note.md",
];

describe("vault path-boundary, real-filesystem resolution (§6.1)", () => {
  it("control: an UNGUARDED adapter write with '../../' really escapes the vault on disk", () => {
    // Proves the harness genuinely detects a real escape, so the guarded assertions
    // below are meaningful, not vacuously passing. We call the raw adapter directly,
    // bypassing every guard; the file must land OUTSIDE vaultRoot.
    const app = makeRealFsApp(vaultRoot);
    void app.vault.create("../../control-escape.md", "i escaped");

    const resolved = nodePath.join(vaultRoot, "../../control-escape.md");
    expect(fs.existsSync(resolved)).toBe(true);
    expect(filesOutsideVault()).toContain(resolved);
  });

  it("layer 1 (executeVaultOpTool): refuses every escaping write before any review", () => {
    const app = makeRealFsApp(vaultRoot);
    const overlay = buildPendingOverlay(app, []);

    for (const path of ESCAPING_PATHS) {
      const call: ToolCall = { id: `c-${path}`, name: "write_file", arguments: { path, content: "x" } };
      const normalized = normalizeVaultToolCall(app, call);
      const result = executeVaultOpTool(normalized, { app, overlay });
      expect(result.isError, `should refuse "${path}"`).toBe(true);
      expect(result.content).toContain("outside the vault");
    }
    expect(filesOutsideVault()).toEqual([]); // validation never writes anything anyway.
  });

  it("layers 2+3 (applyVaultOpBatch → applyOperation): never write an escaping op to disk", async () => {
    const app = makeRealFsApp(vaultRoot);

    for (const path of ESCAPING_PATHS) {
      const op: VaultOperation = { kind: "create", path, content: "x" };

      // Layer 2, pre-flight aborts the batch; nothing is applied.
      const batch = await applyVaultOpBatch(app, [{ id: "a", op }]);
      expect(batch.ok, `batch must refuse "${path}"`).toBe(false);
      expect(
        batch.conflicts.some((c) => c.reason.includes("outside the vault")),
        `conflict must name the boundary for "${path}"`,
      ).toBe(true);
      expect(batch.applied).toHaveLength(0);

      // Layer 3, the disk executor throws as its first act, even if reached directly.
      await expect(applyOperation(app, op), `applyOperation must throw for "${path}"`).rejects.toThrow(
        /outside the vault/,
      );

      // The path the adapter WOULD have written to must not exist on disk.
      expect(fs.existsSync(nodePath.join(vaultRoot, path))).toBe(false);
    }

    // Nothing escaped the vault root anywhere under the sandbox.
    expect(filesOutsideVault()).toEqual([]);
  });

  it("refuses an escaping move endpoint without moving the file out of the vault", async () => {
    const app = makeRealFsApp(vaultRoot);
    fs.mkdirSync(nodePath.join(vaultRoot, "Notes"), { recursive: true });
    fs.writeFileSync(nodePath.join(vaultRoot, "Notes", "A.md"), "body");
    // Use the file's REAL fingerprint so the conflict guard passes, the *only* thing
    // that can stop this move is the vault-boundary check, making it the load-bearing
    // assertion (it would escape on disk if the guard were removed).
    const st = fs.statSync(nodePath.join(vaultRoot, "Notes", "A.md"));

    const op: VaultOperation = {
      kind: "move",
      from: "Notes/A.md",
      to: "../../../escaped-move.md",
      expect: { mtime: st.mtimeMs, size: st.size },
    };
    const batch = await applyVaultOpBatch(app, [{ id: "m", op }]);

    expect(batch.ok).toBe(false);
    expect(batch.conflicts.some((c) => c.reason.includes("outside the vault"))).toBe(true);
    expect(fs.existsSync(nodePath.join(vaultRoot, "Notes", "A.md"))).toBe(true); // source untouched
    expect(filesOutsideVault()).toEqual([]); // nothing moved out
  });

  it("allows odd-but-contained shapes to resolve INSIDE the vault, never outside it", async () => {
    const app = makeRealFsApp(vaultRoot);

    for (const path of ODD_BUT_CONTAINED_PATHS) {
      const op: VaultOperation = { kind: "create", path, content: "ok" };
      // These do not escape, so they either apply inside the vault or fail on an
      // invalid filename, either way they must not write outside vaultRoot. We do
      // not assert ok/throw (OS-dependent for invalid chars), only the boundary.
      try {
        await applyVaultOpBatch(app, [{ id: "o", op }]);
      } catch {
        /* an invalid on-disk name is fine, it cannot escape. */
      }
    }

    expect(filesOutsideVault()).toEqual([]);
  });

  it("applies a legitimate in-vault create on the real filesystem (positive control)", async () => {
    const app = makeRealFsApp(vaultRoot);
    const op: VaultOperation = { kind: "create", path: "Notes/Welcome.md", content: "hello" };

    const batch = await applyVaultOpBatch(app, [{ id: "g", op }]);

    expect(batch.ok).toBe(true);
    expect(fs.readFileSync(nodePath.join(vaultRoot, "Notes", "Welcome.md"), "utf8")).toBe("hello");
    expect(filesOutsideVault()).toEqual([]);
  });

  it("applies a replaceInVault over in-vault targets, but refuses one whose target escapes", async () => {
    const app = makeRealFsApp(vaultRoot);
    fs.mkdirSync(nodePath.join(vaultRoot, "Lore"), { recursive: true });
    fs.writeFileSync(nodePath.join(vaultRoot, "Lore", "A.md"), "old A old");
    const st = fs.statSync(nodePath.join(vaultRoot, "Lore", "A.md"));

    // All targets in-vault: applies on real disk.
    const ok: VaultOperation = {
      kind: "replaceInVault",
      search: "old",
      replace: "new",
      caseSensitive: false,
      wholeWord: false,
      targets: [
        { path: "Lore/A.md", content: "new A new", expect: { mtime: st.mtimeMs, size: st.size } },
      ],
      occurrences: 2,
    };
    const okBatch = await applyVaultOpBatch(app, [{ id: "ok", op: ok }]);
    expect(okBatch.ok).toBe(true);
    expect(fs.readFileSync(nodePath.join(vaultRoot, "Lore", "A.md"), "utf8")).toBe("new A new");

    // A target that escapes the vault: pre-flight aborts, and the executor throws as
    // its first act, so the SECURITY invariant holds for the composite op too.
    const escaping: VaultOperation = {
      kind: "replaceInVault",
      search: "x",
      replace: "y",
      caseSensitive: false,
      wholeWord: false,
      targets: [{ path: "../../escaped.md", content: "pwned", expect: { mtime: 0, size: 0 } }],
      occurrences: 1,
    };
    const badBatch = await applyVaultOpBatch(app, [{ id: "bad", op: escaping }]);
    expect(badBatch.ok).toBe(false);
    expect(badBatch.conflicts.some((c) => c.reason.includes("outside the vault"))).toBe(true);
    await expect(applyOperation(app, escaping)).rejects.toThrow(/outside the vault/);
    expect(filesOutsideVault()).toEqual([]);
  });
});

describe("folder ops, real-filesystem resolution (§6.1)", () => {
  it("refuses an escaping move_folder destination without moving the folder out of the vault", async () => {
    const app = makeRealFsApp(vaultRoot);
    fs.mkdirSync(nodePath.join(vaultRoot, "Drafts", "Act II"), { recursive: true });
    fs.writeFileSync(nodePath.join(vaultRoot, "Drafts", "Act II", "Scene.md"), "body");

    const op: VaultOperation = {
      kind: "moveFolder",
      from: "Drafts/Act II",
      to: "../../../escaped-folder",
    };
    const batch = await applyVaultOpBatch(app, [{ id: "mf", op }]);

    expect(batch.ok).toBe(false);
    expect(batch.conflicts.some((c) => c.reason.includes("outside the vault"))).toBe(true);
    expect(fs.existsSync(nodePath.join(vaultRoot, "Drafts", "Act II", "Scene.md"))).toBe(true);
    // The executor also throws as its first act, even if reached directly.
    await expect(applyOperation(app, op)).rejects.toThrow(/outside the vault/);
    expect(filesOutsideVault()).toEqual([]); // nothing escaped onto disk.
  });

  it("moves a real folder and its contents inside the vault (positive control)", async () => {
    const app = makeRealFsApp(vaultRoot);
    fs.mkdirSync(nodePath.join(vaultRoot, "Drafts", "Act II"), { recursive: true });
    fs.writeFileSync(nodePath.join(vaultRoot, "Drafts", "Act II", "Scene.md"), "body");

    const op: VaultOperation = { kind: "moveFolder", from: "Drafts/Act II", to: "Manuscript/Act II" };
    const batch = await applyVaultOpBatch(app, [{ id: "mf", op }]);

    expect(batch.ok).toBe(true);
    expect(fs.readFileSync(nodePath.join(vaultRoot, "Manuscript", "Act II", "Scene.md"), "utf8")).toBe(
      "body",
    );
    expect(fs.existsSync(nodePath.join(vaultRoot, "Drafts", "Act II"))).toBe(false);
  });

  it("trash_folder removes an empty folder but refuses a populated one (empty-only, real disk)", async () => {
    const app = makeRealFsApp(vaultRoot);
    fs.mkdirSync(nodePath.join(vaultRoot, "Empty"), { recursive: true });
    fs.mkdirSync(nodePath.join(vaultRoot, "Full"), { recursive: true });
    fs.writeFileSync(nodePath.join(vaultRoot, "Full", "Note.md"), "precious");

    const emptyBatch = await applyVaultOpBatch(app, [{ id: "e", op: { kind: "trashFolder", path: "Empty" } }]);
    expect(emptyBatch.ok).toBe(true);
    expect(fs.existsSync(nodePath.join(vaultRoot, "Empty"))).toBe(false);

    const fullBatch = await applyVaultOpBatch(app, [{ id: "f", op: { kind: "trashFolder", path: "Full" } }]);
    expect(fullBatch.ok).toBe(false);
    expect(fullBatch.error).toMatch(/not empty/i);
    expect(fs.readFileSync(nodePath.join(vaultRoot, "Full", "Note.md"), "utf8")).toBe("precious");
  });

  it("reorg end-to-end on real disk: move the note out, then trash the empty husk", async () => {
    const app = makeRealFsApp(vaultRoot);
    fs.mkdirSync(nodePath.join(vaultRoot, "Drafts", "Act II"), { recursive: true });
    fs.writeFileSync(nodePath.join(vaultRoot, "Drafts", "Act II", "Scene.md"), "body");
    const st = fs.statSync(nodePath.join(vaultRoot, "Drafts", "Act II", "Scene.md"));

    // Folder trash is listed first; orderOps must run the move first so the husk is
    // empty by apply time, and the apply-time folderIsEmpty check then passes on disk.
    const batch = [
      { id: "tf", op: { kind: "trashFolder", path: "Drafts/Act II" } as VaultOperation },
      {
        id: "mv",
        op: {
          kind: "move",
          from: "Drafts/Act II/Scene.md",
          to: "Manuscript/Scene.md",
          expect: { mtime: st.mtimeMs, size: st.size },
        } as VaultOperation,
      },
    ];
    const result = await applyVaultOpBatch(app, batch);

    expect(result.ok).toBe(true);
    expect(fs.existsSync(nodePath.join(vaultRoot, "Manuscript", "Scene.md"))).toBe(true);
    expect(fs.existsSync(nodePath.join(vaultRoot, "Drafts", "Act II"))).toBe(false);
    expect(filesOutsideVault()).toEqual([]);
  });
});

describe("insert_into_note path boundary (edit channel), real filesystem (§6.1)", () => {
  it("executeEditTool refuses every escaping insert before touching the vault", async () => {
    const app = makeRealFsApp(vaultRoot);

    for (const path of ESCAPING_PATHS) {
      const result = await executeEditTool(
        { id: `c-${path}`, name: "insert_into_note", arguments: { path, text: "pwned", where: "append" } },
        { app, filePath: "" },
      );
      expect(result.isError, `should refuse "${path}"`).toBe(true);
      expect(result.content).toContain("outside the vault");
    }
    expect(filesOutsideVault()).toEqual([]); // validation never writes anything.
  });

  it("resolving + applying an escaping insert never writes outside the vault", async () => {
    // The edit channel only edits an EXISTING in-vault file (getFileByPath); an
    // escaping path resolves to no file, so the apply throws before any write.
    const app = makeRealFsApp(vaultRoot);

    for (const path of ESCAPING_PATHS) {
      const block = convertToolCallToEditBlock({
        id: "i",
        name: "insert_into_note",
        arguments: { path, text: "pwned", where: "append" },
      });
      expect(block).not.toBeNull();
      const [resolved] = await resolveStructuralEditBlocks([block!], { app, filePath: path });
      const [edit] = resolveEdits([resolved], "");
      await expect(
        applyHunksLive(app, path, [{ id: "h", resolvedEdit: edit, status: "pending" }]),
        `apply must refuse "${path}"`,
      ).rejects.toThrow();
      expect(fs.existsSync(nodePath.join(vaultRoot, path))).toBe(false);
    }
    expect(filesOutsideVault()).toEqual([]);
  });

  it("applies a legitimate in-vault append on the real filesystem (positive control)", async () => {
    const app = makeRealFsApp(vaultRoot);
    fs.mkdirSync(nodePath.join(vaultRoot, "Notes"), { recursive: true });
    fs.writeFileSync(nodePath.join(vaultRoot, "Notes", "Journal.md"), "Day 1.\n");

    const block = convertToolCallToEditBlock({
      id: "i",
      name: "insert_into_note",
      arguments: { path: "Notes/Journal.md", text: "Day 2.", where: "append" },
    });
    const [resolved] = await resolveStructuralEditBlocks([block!], { app, filePath: "Notes/Journal.md" });
    const doc = fs.readFileSync(nodePath.join(vaultRoot, "Notes", "Journal.md"), "utf8");
    const [edit] = resolveEdits([resolved], doc);
    await applyHunksLive(app, "Notes/Journal.md", [{ id: "h", resolvedEdit: edit, status: "pending" }]);

    expect(fs.readFileSync(nodePath.join(vaultRoot, "Notes", "Journal.md"), "utf8")).toBe(
      "Day 1.\n\nDay 2.\n",
    );
    expect(filesOutsideVault()).toEqual([]);
  });
});

describe("get_outline / read_section path boundary (read channel), real filesystem (§6.1)", () => {
  // The read channel only resolves an in-vault file (getFileByPath), but it still
  // names the boundary honestly via refuseOutsideVault rather than dead-ending the
  // model on "not found". Verify on real disk that every escaping outline/section
  // read is refused at the boundary, before any file is opened, and nothing escapes.
  const readCtx = (app: App) =>
    ({ app, ragService: {} as unknown as RagService } as VaultToolContext);

  it("refuses every escaping outline/section read, naming the boundary", async () => {
    const app = makeRealFsApp(vaultRoot);

    for (const path of ESCAPING_PATHS) {
      const outline = await executeVaultTool(
        { id: `o-${path}`, name: "get_outline", arguments: { path } },
        readCtx(app),
      );
      expect(outline.isError, `get_outline should refuse "${path}"`).toBe(true);
      expect(outline.content).toContain("outside the vault");

      const section = await executeVaultTool(
        { id: `s-${path}`, name: "read_section", arguments: { path, headingPath: "Any" } },
        readCtx(app),
      );
      expect(section.isError, `read_section should refuse "${path}"`).toBe(true);
      expect(section.content).toContain("outside the vault");
    }
    expect(filesOutsideVault()).toEqual([]); // reads never write, and nothing escaped.
  });
});

describe("smart-quote path resolution, real filesystem", () => {
  // ’ = U+2019, the curly apostrophe Obsidian saves; the model "straightens" it to '.
  const CURLY = "’";

  it("snaps a read_file straight apostrophe to the real curly-quoted file on disk", () => {
    const app = makeRealFsApp(vaultRoot);
    fs.mkdirSync(nodePath.join(vaultRoot, "Lore"), { recursive: true });
    const realName = `Anno${CURLY}s Crucible.md`;
    fs.writeFileSync(nodePath.join(vaultRoot, "Lore", realName), "body");

    const call: ToolCall = {
      id: "r",
      name: "read_file",
      arguments: { path: "Lore/Anno's Crucible.md" },
    };
    const normalized = normalizeVaultToolCall(app, call);

    expect(normalized.arguments.path).toBe(`Lore/${realName}`);
    // The snapped path resolves on real disk, the original straight one would not.
    expect(app.vault.getFileByPath(normalized.arguments.path as string)).not.toBeNull();
  });

  it("snaps a move_file source and moves the real curly-quoted file on disk", async () => {
    const app = makeRealFsApp(vaultRoot);
    fs.mkdirSync(nodePath.join(vaultRoot, "Lore"), { recursive: true });
    const realName = `The Sovereign${CURLY}s Halo.md`;
    fs.writeFileSync(nodePath.join(vaultRoot, "Lore", realName), "body");
    const st = fs.statSync(nodePath.join(vaultRoot, "Lore", realName));

    const call: ToolCall = {
      id: "m",
      name: "move_file",
      arguments: { from: "Lore/The Sovereign's Halo.md", to: "Lore/Renamed.md" },
    };
    const normalized = normalizeVaultToolCall(app, call);
    expect(normalized.arguments.from).toBe(`Lore/${realName}`);

    const op: VaultOperation = {
      kind: "move",
      from: normalized.arguments.from as string,
      to: normalized.arguments.to as string,
      expect: { mtime: st.mtimeMs, size: st.size },
    };
    const batch = await applyVaultOpBatch(app, [{ id: "m", op }]);

    expect(batch.ok).toBe(true);
    expect(fs.existsSync(nodePath.join(vaultRoot, "Lore", "Renamed.md"))).toBe(true);
    expect(fs.existsSync(nodePath.join(vaultRoot, "Lore", realName))).toBe(false);
  });
});
