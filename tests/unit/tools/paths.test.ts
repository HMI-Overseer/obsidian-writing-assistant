import { describe, it, expect } from "vitest";
import { FileSystemAdapter } from "obsidian";
import { toVaultRelativePath, normalizeVaultToolCall } from "../../../src/tools/paths";
import type { ToolCall } from "../../../src/tools/types";
import type { App } from "obsidian";

const ROOT = "D:\\vault\\Harbingers";
const NAME = "Harbingers";

describe("toVaultRelativePath", () => {
  it("strips the vault root from an absolute Windows path inside the vault", () => {
    expect(toVaultRelativePath("D:\\vault\\Harbingers\\sandbox 2\\Lore", ROOT, NAME)).toBe(
      "sandbox 2/Lore",
    );
  });

  it("normalizes backslashes in the stripped remainder to forward slashes", () => {
    expect(toVaultRelativePath("D:\\vault\\Harbingers\\Characters\\Vex.md", ROOT, NAME)).toBe(
      "Characters/Vex.md",
    );
  });

  it("matches the vault root case-insensitively (drive letter / casing)", () => {
    expect(toVaultRelativePath("d:/VAULT/harbingers/Lore/The_Nexus.md", ROOT, NAME)).toBe(
      "Lore/The_Nexus.md",
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
    // "D:/vault/Harbingers2" is a different folder — must not be mistaken for the root.
    expect(toVaultRelativePath("D:\\vault\\Harbingers2\\Lore", ROOT, NAME)).toBe(
      "D:\\vault\\Harbingers2\\Lore",
    );
  });

  it("maps the vault root itself to the empty (root) path", () => {
    expect(toVaultRelativePath("D:\\vault\\Harbingers", ROOT, NAME)).toBe("");
  });

  it("passes the path through untouched when the base path is unknown", () => {
    expect(toVaultRelativePath("D:\\vault\\Harbingers\\Lore", undefined, NAME)).toBe(
      "D:\\vault\\Harbingers\\Lore",
    );
  });

  // --- redundant leading vault-name segment (the double-nesting bug) ---------

  it("strips a relative path that redundantly leads with the vault name", () => {
    expect(toVaultRelativePath("Harbingers/sandbox 2", ROOT, NAME)).toBe("sandbox 2");
  });

  it("strips the vault-name prefix case-insensitively and tolerates a leading slash", () => {
    expect(toVaultRelativePath("/harbingers/sandbox 2/Lore", ROOT, NAME)).toBe("sandbox 2/Lore");
  });

  it("strips a vault-name segment left in an absolute path's remainder", () => {
    expect(toVaultRelativePath("D:\\vault\\Harbingers\\Harbingers\\sandbox 2", ROOT, NAME)).toBe(
      "sandbox 2",
    );
  });

  it("leaves a bare vault-name path alone (only the prefix form is redundant)", () => {
    expect(toVaultRelativePath("Harbingers", ROOT, NAME)).toBe("Harbingers");
  });

  it("does not strip a folder that merely starts with the vault name", () => {
    expect(toVaultRelativePath("HarbingersNotes/x.md", ROOT, NAME)).toBe("HarbingersNotes/x.md");
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
    },
  } as unknown as App;
}

describe("normalizeVaultToolCall", () => {
  const app = appWithBase(ROOT);

  it("rewrites a vault-name-prefixed create_directory path (double-nesting bug)", () => {
    const call: ToolCall = {
      id: "0",
      name: "create_directory",
      arguments: { path: "Harbingers/sandbox 2" },
    };
    expect(normalizeVaultToolCall(app, call).arguments.path).toBe("sandbox 2");
  });

  it("keeps the vault-name prefix when a real folder by that name exists", () => {
    const collidingApp = appWithBase(ROOT, NAME, /* vaultNameFolderExists */ true);
    const call: ToolCall = {
      id: "0b",
      name: "create_directory",
      arguments: { path: "Harbingers/sandbox 2" },
    };
    // A genuine top-level "Harbingers" folder stays addressable — no stripping.
    expect(normalizeVaultToolCall(collidingApp, call)).toBe(call);
  });

  it("rewrites an absolute write_file path to vault-relative", () => {
    const call: ToolCall = {
      id: "1",
      name: "write_file",
      arguments: { path: "D:\\vault\\Harbingers\\sandbox 2\\Lore", content: "x" },
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
        paths: ["Harbingers/Characters/Vex.md", "D:\\vault\\Harbingers\\Lore\\The_Nexus.md", "Plot.md"],
      },
    };
    expect(normalizeVaultToolCall(app, call).arguments.paths).toEqual([
      "Characters/Vex.md",
      "Lore/The_Nexus.md",
      "Plot.md",
    ]);
  });

  it("rewrites both endpoints of a move_file", () => {
    const call: ToolCall = {
      id: "2",
      name: "move_file",
      arguments: {
        from: "D:\\vault\\Harbingers\\Inbox\\Draft.md",
        to: "D:\\vault\\Harbingers\\Characters\\Vex.md",
      },
    };
    const out = normalizeVaultToolCall(app, call);
    expect(out.arguments.from).toBe("Inbox/Draft.md");
    expect(out.arguments.to).toBe("Characters/Vex.md");
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
      arguments: { path: "D:\\vault\\Harbingers\\Lore", content: "x" },
    };
    // No base path means the absolute prefix can't be stripped; the vault-name
    // segment is mid-path (not leading), so nothing changes.
    expect(normalizeVaultToolCall(app, call)).toBe(call);
  });
});
