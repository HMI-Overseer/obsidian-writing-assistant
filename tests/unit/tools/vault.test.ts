import { describe, test, expect, vi } from "vitest";
import { TFile, TFolder } from "obsidian";
import { executeVaultTool } from "../../../src/tools/vault/handlers";
import type { VaultToolContext } from "../../../src/tools/vault/handlers";
import type { ToolCall } from "../../../src/tools/types";

// ---------------------------------------------------------------------------
// Mock builders
// ---------------------------------------------------------------------------

function makeFile(path: string, extension = "md"): TFile {
  const f = new TFile();
  f.path = path;
  f.name = path.split("/").pop() ?? path;
  f.extension = extension;
  return f;
}

function makeFolder(path: string, children: (TFile | TFolder)[] = []): TFolder {
  const f = new TFolder();
  f.path = path;
  f.name = path.split("/").pop() ?? path;
  f.children = children;
  return f;
}

function makeCtx(overrides: {
  files?: TFile[];
  fileContents?: Record<string, string>;
  fileCaches?: Record<string, Record<string, unknown>>;
  backlinks?: Record<string, Record<string, unknown[]>>;
  tags?: Record<string, number>;
  root?: TFolder;
  abstractFiles?: Record<string, TFile | TFolder>;
  ragReady?: boolean;
}): VaultToolContext {
  const {
    files = [],
    fileContents = {},
    fileCaches = {},
    backlinks = {},
    tags = {},
    root = makeFolder(""),
    abstractFiles = {},
    ragReady = false,
  } = overrides;

  const fileMap = new Map(files.map((f) => [f.path, f]));

  return {
    app: {
      vault: {
        getFileByPath: vi.fn((path: string) => fileMap.get(path) ?? null),
        getMarkdownFiles: vi.fn(() => files),
        getRoot: vi.fn(() => root),
        getAbstractFileByPath: vi.fn((path: string) => abstractFiles[path] ?? null),
        read: vi.fn((file: TFile) => Promise.resolve(fileContents[file.path] ?? "")),
      },
      metadataCache: {
        getFileCache: vi.fn((file: TFile) => fileCaches[file.path] ?? null),
        getBacklinksForFile: vi.fn((file: TFile) => ({ data: backlinks[file.path] ?? {} })),
        getTags: vi.fn(() => tags),
      },
    } as unknown as import("obsidian").App,
    ragService: {
      isReady: vi.fn(() => ragReady),
      retrieve: vi.fn(() => Promise.resolve([])),
    } as unknown as import("../../../src/rag/ragService").RagService,
  };
}

function tc(name: string, args: Record<string, unknown> = {}): ToolCall {
  return { id: "test-id", name, arguments: args };
}

// ---------------------------------------------------------------------------
// list_directory
// ---------------------------------------------------------------------------

describe("list_directory", () => {
  test("lists notes and subfolders with [FILE]/[DIR] prefixes", async () => {
    const noteA = makeFile("Characters/Alaric.md");
    const noteB = makeFile("Characters/Will.md");
    const sub = makeFolder("Characters/Drafts", [makeFile("Characters/Drafts/old.md")]);
    const folder = makeFolder("Characters", [noteA, noteB, sub]);

    const ctx = makeCtx({ abstractFiles: { Characters: folder } });
    const result = await executeVaultTool(tc("list_directory", { path: "Characters" }), ctx);

    expect(result.isReadOnly).toBe(true);
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("[FILE] Characters/Alaric.md");
    expect(result.content).toContain("[FILE] Characters/Will.md");
    expect(result.content).toContain("[DIR] Characters/Drafts");
  });

  test("uses vault root when path is omitted", async () => {
    const note = makeFile("index.md");
    const root = makeFolder("", [note]);
    const ctx = makeCtx({ root });
    const result = await executeVaultTool(tc("list_directory", {}), ctx);

    expect(result.content).toContain("Vault root:");
    expect(result.content).toContain("[FILE] index.md");
  });

  test("excludes non-markdown files", async () => {
    const md = makeFile("Assets/note.md");
    const img = makeFile("Assets/image.png", "png");
    const folder = makeFolder("Assets", [md, img]);
    const ctx = makeCtx({ abstractFiles: { Assets: folder } });

    const result = await executeVaultTool(tc("list_directory", { path: "Assets" }), ctx);
    expect(result.content).toContain("[FILE] Assets/note.md");
    expect(result.content).not.toContain("image.png");
  });

  test("returns error when folder not found", async () => {
    const ctx = makeCtx({});
    const result = await executeVaultTool(tc("list_directory", { path: "Missing" }), ctx);

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Error:");
  });

  test("returns error when path resolves to a file not a folder", async () => {
    const file = makeFile("note.md");
    const ctx = makeCtx({ abstractFiles: { "note.md": file } });
    const result = await executeVaultTool(tc("list_directory", { path: "note.md" }), ctx);

    expect(result.isError).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// directory_tree
// ---------------------------------------------------------------------------

describe("directory_tree", () => {
  test("returns recursive JSON tree", async () => {
    const noteA = makeFile("Characters/Alaric.md");
    const sub = makeFolder("Characters/Drafts", [makeFile("Characters/Drafts/old.md")]);
    const folder = makeFolder("Characters", [noteA, sub]);

    const ctx = makeCtx({ abstractFiles: { Characters: folder } });
    const result = await executeVaultTool(tc("directory_tree", { path: "Characters" }), ctx);

    expect(result.isReadOnly).toBe(true);
    expect(result.isError).toBeUndefined();
    const tree = JSON.parse(result.content);
    expect(tree.name).toBe("Characters");
    expect(tree.path).toBe("Characters");
    expect(tree.type).toBe("directory");
    const childNames = tree.children.map((c: { name: string }) => c.name);
    expect(childNames).toContain("Alaric.md");
    expect(childNames).toContain("Drafts");
    const alaric = tree.children.find((c: { name: string }) => c.name === "Alaric.md");
    expect(alaric.path).toBe("Characters/Alaric.md");
    const drafts = tree.children.find((c: { name: string }) => c.name === "Drafts");
    expect(drafts.type).toBe("directory");
    expect(drafts.path).toBe("Characters/Drafts");
    expect(drafts.children[0].name).toBe("old.md");
    expect(drafts.children[0].path).toBe("Characters/Drafts/old.md");
  });

  test("uses vault root when path is omitted", async () => {
    const note = makeFile("index.md");
    const root = makeFolder("", [note]);
    const ctx = makeCtx({ root });
    const result = await executeVaultTool(tc("directory_tree", {}), ctx);

    expect(result.isReadOnly).toBe(true);
    const tree = JSON.parse(result.content);
    expect(tree.type).toBe("directory");
    expect(tree.children[0].name).toBe("index.md");
  });

  test("returns error when folder not found", async () => {
    const ctx = makeCtx({});
    const result = await executeVaultTool(tc("directory_tree", { path: "Missing" }), ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Error:");
  });
});

// ---------------------------------------------------------------------------
// search_files
// ---------------------------------------------------------------------------

describe("search_files", () => {
  test("matches files by glob pattern", async () => {
    const files = [
      makeFile("Characters/Will.md"),
      makeFile("Characters/Alaric.md"),
      makeFile("Scenes/Act1.md"),
    ];
    const ctx = makeCtx({ files });
    const result = await executeVaultTool(tc("search_files", { pattern: "Will*" }), ctx);

    expect(result.isReadOnly).toBe(true);
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("Characters/Will.md");
    expect(result.content).not.toContain("Alaric.md");
    expect(result.content).not.toContain("Act1.md");
  });

  test("search is case-insensitive", async () => {
    const files = [makeFile("Characters/WILL.md")];
    const ctx = makeCtx({ files });
    const result = await executeVaultTool(tc("search_files", { pattern: "will*" }), ctx);
    expect(result.content).toContain("Characters/WILL.md");
  });

  test("restricts search to given path", async () => {
    const files = [
      makeFile("Characters/Will.md"),
      makeFile("Scenes/Will-scene.md"),
    ];
    const ctx = makeCtx({ files });
    const result = await executeVaultTool(
      tc("search_files", { path: "Characters", pattern: "Will*" }),
      ctx,
    );
    expect(result.content).toContain("Characters/Will.md");
    expect(result.content).not.toContain("Scenes/Will-scene.md");
  });

  test("respects excludePatterns", async () => {
    const files = [
      makeFile("Characters/Will.md"),
      makeFile("Characters/Will-draft.md"),
    ];
    const ctx = makeCtx({ files });
    const result = await executeVaultTool(
      tc("search_files", { pattern: "Will*", excludePatterns: ["*draft*"] }),
      ctx,
    );
    expect(result.content).toContain("Characters/Will.md");
    expect(result.content).not.toContain("Will-draft.md");
  });

  test("reports no results when nothing matches", async () => {
    const files = [makeFile("Characters/Alaric.md")];
    const ctx = makeCtx({ files });
    const result = await executeVaultTool(tc("search_files", { pattern: "Zzz*" }), ctx);
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("No notes found");
  });

  test("returns error when pattern is missing", async () => {
    const ctx = makeCtx({});
    const result = await executeVaultTool(tc("search_files", {}), ctx);
    expect(result.isError).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// get_backlinks
// ---------------------------------------------------------------------------

describe("get_backlinks", () => {
  test("returns notes that link to the target", async () => {
    const target = makeFile("Characters/Will.md");
    const ctx = makeCtx({
      files: [target],
      backlinks: {
        "Characters/Will.md": {
          "Scenes/Act1.md": [],
          "Scenes/Act2.md": [],
        },
      },
    });

    const result = await executeVaultTool(tc("get_backlinks", { path: "Characters/Will.md" }), ctx);

    expect(result.isReadOnly).toBe(true);
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("Scenes/Act1.md");
    expect(result.content).toContain("Scenes/Act2.md");
    expect(result.content).toContain("(2)");
  });

  test("reports no backlinks when none exist", async () => {
    const target = makeFile("Characters/Nobody.md");
    const ctx = makeCtx({ files: [target] });

    const result = await executeVaultTool(tc("get_backlinks", { path: "Characters/Nobody.md" }), ctx);
    expect(result.content).toContain("No notes link to");
    expect(result.isError).toBeUndefined();
  });

  test("returns error when note not found", async () => {
    const ctx = makeCtx({});
    const result = await executeVaultTool(tc("get_backlinks", { path: "Missing.md" }), ctx);

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Error:");
  });

  test("returns error when path is empty", async () => {
    const ctx = makeCtx({});
    const result = await executeVaultTool(tc("get_backlinks", { path: "" }), ctx);
    expect(result.isError).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// find_notes_by_tag
// ---------------------------------------------------------------------------

describe("find_notes_by_tag", () => {
  test("finds notes with frontmatter tag array", async () => {
    const noteA = makeFile("Characters/Alaric.md");
    const noteB = makeFile("Scenes/Act1.md");
    const ctx = makeCtx({
      files: [noteA, noteB],
      fileCaches: {
        "Characters/Alaric.md": { frontmatter: { tags: ["character", "antagonist"] } },
        "Scenes/Act1.md": { frontmatter: { tags: ["scene"] } },
      },
    });

    const result = await executeVaultTool(tc("find_notes_by_tag", { tag: "character" }), ctx);

    expect(result.isReadOnly).toBe(true);
    expect(result.content).toContain("Characters/Alaric.md");
    expect(result.content).not.toContain("Scenes/Act1.md");
  });

  test("accepts tag with or without # prefix", async () => {
    const note = makeFile("note.md");
    const ctx = makeCtx({
      files: [note],
      fileCaches: { "note.md": { frontmatter: { tags: ["location"] } } },
    });

    const withHash = await executeVaultTool(tc("find_notes_by_tag", { tag: "#location" }), ctx);
    const withoutHash = await executeVaultTool(tc("find_notes_by_tag", { tag: "location" }), ctx);

    expect(withHash.content).toContain("note.md");
    expect(withoutHash.content).toContain("note.md");
  });

  test("finds notes with inline tags from cache", async () => {
    const note = makeFile("note.md");
    const ctx = makeCtx({
      files: [note],
      fileCaches: {
        "note.md": {
          tags: [{ tag: "#location", position: {} }],
        },
      },
    });

    const result = await executeVaultTool(tc("find_notes_by_tag", { tag: "location" }), ctx);
    expect(result.content).toContain("note.md");
  });

  test("suggests similar tags when none match", async () => {
    const note = makeFile("note.md");
    const ctx = makeCtx({
      files: [note],
      fileCaches: { "note.md": { frontmatter: { tags: ["character"] } } },
      tags: { "#character": 1, "#character-arc": 2 },
    });

    const result = await executeVaultTool(tc("find_notes_by_tag", { tag: "char" }), ctx);
    expect(result.content).toContain("Similar tags");
    expect(result.isError).toBeUndefined();
  });

  test("returns error when tag is empty", async () => {
    const ctx = makeCtx({});
    const result = await executeVaultTool(tc("find_notes_by_tag", { tag: "" }), ctx);
    expect(result.isError).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// get_frontmatter
// ---------------------------------------------------------------------------

describe("get_frontmatter", () => {
  test("returns frontmatter for multiple paths", async () => {
    const a = makeFile("Characters/Alaric.md");
    const b = makeFile("Characters/Will.md");
    const ctx = makeCtx({
      files: [a, b],
      fileCaches: {
        "Characters/Alaric.md": {
          frontmatter: { species: "human", affiliation: "Harbingers", position: { start: 0 } },
        },
        "Characters/Will.md": {
          frontmatter: { species: "elf", status: "alive", position: { start: 0 } },
        },
      },
    });

    const result = await executeVaultTool(
      tc("get_frontmatter", { paths: ["Characters/Alaric.md", "Characters/Will.md"] }),
      ctx,
    );

    expect(result.isReadOnly).toBe(true);
    const parsed = JSON.parse(result.content);
    expect(parsed["Characters/Alaric.md"].species).toBe("human");
    expect(parsed["Characters/Alaric.md"].position).toBeUndefined();
    expect(parsed["Characters/Will.md"].status).toBe("alive");
  });

  test("records error for paths that do not exist", async () => {
    const ctx = makeCtx({});
    const result = await executeVaultTool(
      tc("get_frontmatter", { paths: ["Missing.md"] }),
      ctx,
    );

    const parsed = JSON.parse(result.content);
    expect(parsed["Missing.md"].error).toBeTruthy();
  });

  test("returns empty object for notes with no frontmatter", async () => {
    const note = makeFile("plain.md");
    const ctx = makeCtx({ files: [note], fileCaches: { "plain.md": {} } });

    const result = await executeVaultTool(
      tc("get_frontmatter", { paths: ["plain.md"] }),
      ctx,
    );

    const parsed = JSON.parse(result.content);
    expect(parsed["plain.md"]).toEqual({});
  });

  test("returns error when paths array is empty", async () => {
    const ctx = makeCtx({});
    const result = await executeVaultTool(tc("get_frontmatter", { paths: [] }), ctx);
    expect(result.isError).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Unknown tool
// ---------------------------------------------------------------------------

describe("unknown tool", () => {
  test("returns isReadOnly false for unrecognised vault tool names", async () => {
    const ctx = makeCtx({});
    const result = await executeVaultTool(tc("totally_unknown"), ctx);
    expect(result.isReadOnly).toBe(false);
  });
});
