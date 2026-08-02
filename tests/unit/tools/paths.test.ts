import { describe, it, expect } from "vitest";
import { FileSystemAdapter, TFile, TFolder, normalizePath } from "obsidian";
import {
  SNAP_TOOL_KEYS,
  toVaultRelativePath,
  normalizeVaultToolCall,
  snapToExistingFile,
} from "../../../src/tools/paths";
import { ALL_VAULT_TOOLS, VAULT_TOOL_NAMES } from "../../../src/tools/vault/definition";
import { ALL_EDIT_TOOLS, EDIT_TOOL_NAMES } from "../../../src/tools/editing/definition";
import {
  ALL_VAULT_OPS_TOOLS,
  VAULT_OPS_TOOL_NAMES,
} from "../../../src/tools/vault-ops/definition";
import type { ToolCall } from "../../../src/tools/types";
import type { App } from "obsidian";

const ROOT = "D:\\vault\\ExampleVault";
const NAME = "ExampleVault";

describe("toVaultRelativePath", () => {
  it("strips the vault root from an absolute Windows path inside the vault", () => {
    expect(toVaultRelativePath("D:\\vault\\ExampleVault\\sandbox 2\\Lore", ROOT, NAME)).toBe(
      "sandbox 2/Lore",
    );
  });

  it("normalizes backslashes in the stripped remainder to forward slashes", () => {
    expect(toVaultRelativePath("D:\\vault\\ExampleVault\\Characters\\Alice.md", ROOT, NAME)).toBe(
      "Characters/Alice.md",
    );
  });

  it("matches the vault root case-insensitively (drive letter / casing)", () => {
    expect(toVaultRelativePath("d:/VAULT/examplevault/Lore/The_Archive.md", ROOT, NAME)).toBe(
      "Lore/The_Archive.md",
    );
  });

  it("leaves an already vault-relative path unchanged", () => {
    expect(toVaultRelativePath("sandbox 2/Lore", ROOT, NAME)).toBe("sandbox 2/Lore");
  });

  it("leaves an absolute path outside the vault unchanged", () => {
    expect(toVaultRelativePath("C:\\Windows\\system32\\notes.md", ROOT, NAME)).toBe(
      "C:\\Windows\\system32\\notes.md",
    );
  });

  it("does not treat a sibling folder sharing a name prefix as inside the vault", () => {
    // "D:/vault/ExampleVault2" is a different folder, must not be mistaken for the root.
    expect(toVaultRelativePath("D:\\vault\\ExampleVault2\\Lore", ROOT, NAME)).toBe(
      "D:\\vault\\ExampleVault2\\Lore",
    );
  });

  it("maps the vault root itself to the empty (root) path", () => {
    expect(toVaultRelativePath("D:\\vault\\ExampleVault", ROOT, NAME)).toBe("");
  });

  it("passes the path through untouched when the base path is unknown", () => {
    expect(toVaultRelativePath("D:\\vault\\ExampleVault\\Lore", undefined, NAME)).toBe(
      "D:\\vault\\ExampleVault\\Lore",
    );
  });

  // --- redundant leading vault-name segment (the double-nesting bug) ---------

  it("strips a relative path that redundantly leads with the vault name", () => {
    expect(toVaultRelativePath("ExampleVault/sandbox 2", ROOT, NAME)).toBe("sandbox 2");
  });

  it("strips the vault-name prefix case-insensitively and tolerates a leading slash", () => {
    expect(toVaultRelativePath("/examplevault/sandbox 2/Lore", ROOT, NAME)).toBe("sandbox 2/Lore");
  });

  it("strips a vault-name segment left in an absolute path's remainder", () => {
    expect(toVaultRelativePath("D:\\vault\\ExampleVault\\ExampleVault\\sandbox 2", ROOT, NAME)).toBe(
      "sandbox 2",
    );
  });

  it("leaves a bare vault-name path alone (only the prefix form is redundant)", () => {
    expect(toVaultRelativePath("ExampleVault", ROOT, NAME)).toBe("ExampleVault");
  });

  it("does not strip a folder that merely starts with the vault name", () => {
    expect(toVaultRelativePath("ExampleVaultNotes/x.md", ROOT, NAME)).toBe("ExampleVaultNotes/x.md");
  });
});

/**
 * App backed by the mock FileSystemAdapter (what vaultBasePath checks against).
 * `vaultNameFolderExists` simulates a real top-level folder named like the vault,
 * which suppresses vault-name stripping so that folder stays addressable.
 */
function appWithBase(base: string, name = NAME, vaultNameFolderExists = false): App {
  const adapter = new FileSystemAdapter();
  adapter.getBasePath = () => base;
  return {
    vault: {
      adapter,
      getName: () => name,
      getAbstractFileByPath: (p: string) => (vaultNameFolderExists && p === name ? {} : null),
      // Snap-eligible tools look up the parent folder / root; an empty root means no
      // confusable candidates, so snapping is a no-op for these vault-name tests.
      getRoot: () => new TFolder(),
    },
  } as unknown as App;
}

/**
 * App whose vault resolves a fixed set of file paths into a TFolder/TFile tree, so
 * {@link snapToExistingFile} can find (or fail to find) confusable-folded matches.
 */
function appWithFiles(filePaths: string[]): App {
  const folders = new Map<string, TFolder>();
  const files = new Map<string, TFile>();
  const folderAt = (path: string): TFolder => {
    let f = folders.get(path);
    if (!f) {
      f = new TFolder();
      f.path = path;
      folders.set(path, f);
    }
    return f;
  };
  const root = folderAt("");

  for (const raw of filePaths) {
    const p = normalizePath(raw);
    const segs = p.split("/");
    let parent = root;
    let cur = "";
    for (let i = 0; i < segs.length - 1; i++) {
      cur = cur ? `${cur}/${segs[i]}` : segs[i];
      const folder = folderAt(cur);
      if (!parent.children.includes(folder)) parent.children.push(folder);
      parent = folder;
    }
    const file = new TFile();
    file.path = p;
    files.set(p, file);
    parent.children.push(file);
  }

  const adapter = new FileSystemAdapter();
  adapter.getBasePath = () => ROOT;
  return {
    vault: {
      adapter,
      getName: () => NAME,
      getRoot: () => root,
      getAbstractFileByPath: (path: string) => {
        const p = normalizePath(path);
        return files.get(p) ?? folders.get(p) ?? null;
      },
    },
  } as unknown as App;
}

describe("normalizeVaultToolCall", () => {
  const app = appWithBase(ROOT);

  it("rewrites a vault-name-prefixed create_directory path (double-nesting bug)", () => {
    const call: ToolCall = {
      id: "0",
      name: "create_directory",
      arguments: { path: "ExampleVault/sandbox 2" },
    };
    expect(normalizeVaultToolCall(app, call).arguments.path).toBe("sandbox 2");
  });

  it("keeps the vault-name prefix when a real folder by that name exists", () => {
    const collidingApp = appWithBase(ROOT, NAME, /* vaultNameFolderExists */ true);
    const call: ToolCall = {
      id: "0b",
      name: "create_directory",
      arguments: { path: "ExampleVault/sandbox 2" },
    };
    // A genuine top-level "ExampleVault" folder stays addressable, no stripping.
    expect(normalizeVaultToolCall(collidingApp, call)).toBe(call);
  });

  it("rewrites an absolute write_file path to vault-relative", () => {
    const call: ToolCall = {
      id: "1",
      name: "write_file",
      arguments: { path: "D:\\vault\\ExampleVault\\sandbox 2\\Lore", content: "x" },
    };
    const out = normalizeVaultToolCall(app, call);
    expect(out.arguments.path).toBe("sandbox 2/Lore");
    expect(out.arguments.content).toBe("x");
  });

  it("rewrites each entry of a get_frontmatter `paths` array", () => {
    const call: ToolCall = {
      id: "1b",
      name: "get_frontmatter",
      arguments: {
        paths: ["ExampleVault/Characters/Alice.md", "D:\\vault\\ExampleVault\\Lore\\The_Archive.md", "Plot.md"],
      },
    };
    expect(normalizeVaultToolCall(app, call).arguments.paths).toEqual([
      "Characters/Alice.md",
      "Lore/The_Archive.md",
      "Plot.md",
    ]);
  });

  it("rewrites both endpoints of a move_file", () => {
    const call: ToolCall = {
      id: "2",
      name: "move_file",
      arguments: {
        from: "D:\\vault\\ExampleVault\\Inbox\\Draft.md",
        to: "D:\\vault\\ExampleVault\\Characters\\Alice.md",
      },
    };
    const out = normalizeVaultToolCall(app, call);
    expect(out.arguments.from).toBe("Inbox/Draft.md");
    expect(out.arguments.to).toBe("Characters/Alice.md");
  });

  it("returns the same object when nothing needs translating", () => {
    const call: ToolCall = {
      id: "3",
      name: "write_file",
      arguments: { path: "sandbox 2/Lore.md", content: "x" },
    };
    expect(normalizeVaultToolCall(app, call)).toBe(call);
  });

  it("leaves non-string path arguments alone", () => {
    const call: ToolCall = { id: "4", name: "write_file", arguments: { path: 42 } };
    expect(normalizeVaultToolCall(app, call)).toBe(call);
  });

  it("leaves an absolute path alone on a non-filesystem vault (no base path)", () => {
    const app = {
      vault: { adapter: {}, getName: () => NAME, getAbstractFileByPath: () => null },
    } as unknown as App;
    const call: ToolCall = {
      id: "5",
      name: "write_file",
      arguments: { path: "D:\\vault\\ExampleVault\\Lore", content: "x" },
    };
    // No base path means the absolute prefix can't be stripped; the vault-name
    // segment is mid-path (not leading), so nothing changes.
    expect(normalizeVaultToolCall(app, call)).toBe(call);
  });
});

// ’ = U+2019 (right single quotation mark), the curly apostrophe Obsidian saves and
// the model "straightens" to ' (U+0027) when it composes a path, the smart-quote
// move/read failure this resolver fixes.
const CURLY = "’";

describe("snapToExistingFile (confusable-punctuation path snapping)", () => {
  const app = appWithFiles([
    `Lore/The Sovereign${CURLY}s Halo.md`,
    `Lore/Anno${CURLY}s Crucible.md`,
    "Lore/Plain.md",
  ]);

  it("returns an exact path unchanged", () => {
    const exact = `Lore/The Sovereign${CURLY}s Halo.md`;
    expect(snapToExistingFile(app, exact)).toBe(exact);
  });

  it("snaps a straight apostrophe to the curly-quoted file actually on disk", () => {
    expect(snapToExistingFile(app, "Lore/The Sovereign's Halo.md")).toBe(
      `Lore/The Sovereign${CURLY}s Halo.md`,
    );
  });

  it("returns the input unchanged when nothing in the folder matches", () => {
    expect(snapToExistingFile(app, "Lore/Missing.md")).toBe("Lore/Missing.md");
  });

  it("never snaps across folders (only the same parent is searched)", () => {
    // The curly file lives in Lore/, so a root-level lookup must not reach it.
    expect(snapToExistingFile(app, "The Sovereign's Halo.md")).toBe("The Sovereign's Halo.md");
  });

  it("refuses to guess when more than one file folds to the same name", () => {
    const ambiguous = appWithFiles([`Lore/A${CURLY}s.md`, "Lore/A‘s.md"]);
    // Both the right- and left-quote files fold to "Lore/A's.md"; the straight input
    // matches neither exactly, so the snap is ambiguous and must be left alone.
    expect(snapToExistingFile(ambiguous, "Lore/A's.md")).toBe("Lore/A's.md");
  });
});

describe("normalizeVaultToolCall confusable snapping (existing-file keys only)", () => {
  const app = appWithFiles([
    `Lore/The Sovereign${CURLY}s Halo.md`,
    `Lore/Anno${CURLY}s Crucible.md`,
  ]);

  it("snaps move_file `from` to the on-disk curly name but leaves `to` (a destination) alone", () => {
    const call: ToolCall = {
      id: "m",
      name: "move_file",
      arguments: { from: "Lore/The Sovereign's Halo.md", to: "Archive/The Sovereign's Halo.md" },
    };
    const out = normalizeVaultToolCall(app, call);
    expect(out.arguments.from).toBe(`Lore/The Sovereign${CURLY}s Halo.md`);
    expect(out.arguments.to).toBe("Archive/The Sovereign's Halo.md");
  });

  it("snaps read_file `path`", () => {
    const out = normalizeVaultToolCall(app, {
      id: "r",
      name: "read_file",
      arguments: { path: "Lore/Anno's Crucible.md" },
    });
    expect(out.arguments.path).toBe(`Lore/Anno${CURLY}s Crucible.md`);
  });

  it("snaps insert_into_note `path` (an existing-note edit target)", () => {
    const out = normalizeVaultToolCall(app, {
      id: "i",
      name: "insert_into_note",
      arguments: { path: "Lore/Anno's Crucible.md", text: "x", where: "append" },
    });
    expect(out.arguments.path).toBe(`Lore/Anno${CURLY}s Crucible.md`);
  });

  it("does NOT snap write_file `path` (a destination), even when a confusable file exists", () => {
    const out = normalizeVaultToolCall(app, {
      id: "w",
      name: "write_file",
      arguments: { path: "Lore/The Sovereign's Halo.md", content: "x" },
    });
    expect(out.arguments.path).toBe("Lore/The Sovereign's Halo.md");
  });

  it("snaps each existing-file entry of get_frontmatter `paths`, leaving misses alone", () => {
    const out = normalizeVaultToolCall(app, {
      id: "gf",
      name: "get_frontmatter",
      arguments: { paths: ["Lore/Anno's Crucible.md", "Lore/Missing.md"] },
    });
    expect(out.arguments.paths).toEqual([`Lore/Anno${CURLY}s Crucible.md`, "Lore/Missing.md"]);
  });
});

/**
 * Drift guard for SNAP_TOOL_KEYS (the confusable-punctuation snap table).
 *
 * Its keys are tool names nothing typechecks, so a rename that misses one switches
 * snapping off for that tool in silence: the call still works, it just stops resolving
 * a curly apostrophe to the note that is right there. Nothing else in the suite would
 * notice, because every behavioural test below names its tool explicitly.
 */
describe("SNAP_TOOL_KEYS drift guard", () => {
  const ADVERTISED = new Set<string>([
    ...VAULT_TOOL_NAMES,
    ...EDIT_TOOL_NAMES,
    ...VAULT_OPS_TOOL_NAMES,
  ]);

  it("keys only advertised tools", () => {
    for (const name of Object.keys(SNAP_TOOL_KEYS)) {
      expect(
        ADVERTISED.has(name),
        `SNAP_TOOL_KEYS has an entry for "${name}", which is not an advertised tool`,
      ).toBe(true);
    }
  });

  it("names only argument keys the tool actually declares", () => {
    const schemaOf = new Map(
      [...ALL_VAULT_TOOLS, ...ALL_EDIT_TOOLS, ...ALL_VAULT_OPS_TOOLS].map((t) => [t.name, t]),
    );
    for (const [name, keys] of Object.entries(SNAP_TOOL_KEYS)) {
      const tool = schemaOf.get(name);
      for (const key of keys) {
        expect(
          tool?.parameters.properties[key],
          `SNAP_TOOL_KEYS["${name}"] names argument "${key}", which that tool does not declare`,
        ).toBeDefined();
      }
    }
  });

  // The security-relevant half, stated as an assertion rather than only as a comment
  // on the table: snapping a *destination* could silently retarget a new file onto an
  // existing note. Nothing but this test says so.
  it("never snaps a write destination", () => {
    expect(SNAP_TOOL_KEYS.write_file).toBeUndefined();
    expect(SNAP_TOOL_KEYS.create_directory).toBeUndefined();
    expect(SNAP_TOOL_KEYS.replace_in_vault).toBeUndefined();
    expect(SNAP_TOOL_KEYS.move_file).not.toContain("to");
  });
});
