import { describe, test, expect, vi } from "vitest";
import { TFile, TFolder } from "obsidian";
import { executeVaultTool } from "../../../src/tools/vault/handlers";
import type { VaultToolContext } from "../../../src/tools/vault/handlers";
import type { ToolCall } from "../../../src/tools/types";
import { RagRetrievalError } from "../../../src/rag/ragService";
import type { RagAvailability } from "../../../src/rag/ragService";
import type { RagContextBlock } from "../../../src/shared/chatRequest";

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
  ragAvailability?: RagAvailability;
  ragRetrieve?: (query: string, activeFilePath?: string) => Promise<RagContextBlock[] | null>;
}): VaultToolContext {
  const {
    files = [],
    fileContents = {},
    fileCaches = {},
    backlinks = {},
    tags = {},
    root = makeFolder(""),
    abstractFiles = {},
    ragAvailability = "no-backend",
    ragRetrieve = () => Promise.resolve([]),
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
        cachedRead: vi.fn((file: TFile) => Promise.resolve(fileContents[file.path] ?? "")),
      },
      metadataCache: {
        getFileCache: vi.fn((file: TFile) => fileCaches[file.path] ?? null),
        getBacklinksForFile: vi.fn((file: TFile) => ({ data: backlinks[file.path] ?? {} })),
        getTags: vi.fn(() => tags),
      },
    } as unknown as import("obsidian").App,
    ragService: {
      isReady: vi.fn(() => ragAvailability === "ready"),
      availability: vi.fn(() => ragAvailability),
      retrieve: vi.fn(ragRetrieve),
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
// search_content
// ---------------------------------------------------------------------------

describe("search_content", () => {
  test("finds a literal string in note bodies with path:line:snippet", async () => {
    const a = makeFile("Characters/Will.md");
    const b = makeFile("Scenes/Act1.md");
    const ctx = makeCtx({
      files: [a, b],
      fileContents: {
        "Characters/Will.md": "Will is brave.\nHe carries a sword.",
        "Scenes/Act1.md": "The sword glints.\nNo mention here.",
      },
    });

    const result = await executeVaultTool(tc("search_content", { query: "sword" }), ctx);

    expect(result.isReadOnly).toBe(true);
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("Characters/Will.md:2: He carries a sword.");
    expect(result.content).toContain("Scenes/Act1.md:1: The sword glints.");
  });

  test("is case-insensitive by default and case-sensitive on request", async () => {
    const a = makeFile("note.md");
    const ctx = makeCtx({ files: [a], fileContents: { "note.md": "The TODO marker." } });

    const insensitive = await executeVaultTool(tc("search_content", { query: "todo" }), ctx);
    expect(insensitive.content).toContain("note.md:1");

    const sensitive = await executeVaultTool(
      tc("search_content", { query: "todo", caseSensitive: true }),
      ctx,
    );
    expect(sensitive.content).toContain("No matches found");
  });

  test("supports regex matching when regex is true", async () => {
    const a = makeFile("note.md");
    const ctx = makeCtx({ files: [a], fileContents: { "note.md": "Chapter 12 begins." } });

    const result = await executeVaultTool(
      tc("search_content", { query: "Chapter \\d+", regex: true }),
      ctx,
    );
    expect(result.content).toContain("note.md:1");
  });

  test("returns a correctable error for an invalid regex", async () => {
    const a = makeFile("note.md");
    const ctx = makeCtx({ files: [a], fileContents: { "note.md": "anything" } });

    const result = await executeVaultTool(
      tc("search_content", { query: "(unclosed", regex: true }),
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Error:");
  });

  test("restricts the scan to the given path", async () => {
    const a = makeFile("Characters/Will.md");
    const b = makeFile("Scenes/Act1.md");
    const ctx = makeCtx({
      files: [a, b],
      fileContents: {
        "Characters/Will.md": "shared token",
        "Scenes/Act1.md": "shared token",
      },
    });

    const result = await executeVaultTool(
      tc("search_content", { query: "shared", path: "Characters" }),
      ctx,
    );
    expect(result.content).toContain("Characters/Will.md");
    expect(result.content).not.toContain("Scenes/Act1.md");
  });

  test("respects excludePatterns", async () => {
    const a = makeFile("Will.md");
    const b = makeFile("Will-draft.md");
    const ctx = makeCtx({
      files: [a, b],
      fileContents: { "Will.md": "token", "Will-draft.md": "token" },
    });

    const result = await executeVaultTool(
      tc("search_content", { query: "token", excludePatterns: ["*draft*"] }),
      ctx,
    );
    expect(result.content).toContain("Will.md:1");
    expect(result.content).not.toContain("Will-draft.md");
  });

  test("reports no matches without erroring", async () => {
    const a = makeFile("note.md");
    const ctx = makeCtx({ files: [a], fileContents: { "note.md": "nothing relevant" } });
    const result = await executeVaultTool(tc("search_content", { query: "absent" }), ctx);
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("No matches found");
  });

  test("returns error when query is missing", async () => {
    const ctx = makeCtx({});
    const result = await executeVaultTool(tc("search_content", {}), ctx);
    expect(result.isError).toBe(true);
  });

  test("reports total match count when results are truncated", async () => {
    const body = Array.from({ length: 60 }, (_, i) => `line ${i} has token`).join("\n");
    const a = makeFile("big.md");
    const ctx = makeCtx({ files: [a], fileContents: { "big.md": body } });

    const result = await executeVaultTool(tc("search_content", { query: "token" }), ctx);

    expect(result.content).toContain("showing first 50 of 60");
    expect(result.content).toContain("Showing 50 of 60 matches");
  });

  test("includes surrounding lines when contextLines is set", async () => {
    const a = makeFile("note.md");
    const ctx = makeCtx({
      files: [a],
      fileContents: { "note.md": "first para\nsecond has token\nthird para" },
    });

    const result = await executeVaultTool(
      tc("search_content", { query: "token", contextLines: 1 }),
      ctx,
    );

    expect(result.content).toContain("[note.md]");
    expect(result.content).toContain("first para");
    expect(result.content).toContain("> 2: second has token");
    expect(result.content).toContain("third para");
  });

  test("merges overlapping context windows so shared lines print once", async () => {
    const a = makeFile("note.md");
    const ctx = makeCtx({
      files: [a],
      // lines: 0 p0, 1 token one, 2 p2, 3 token two, 4 p4
      fileContents: { "note.md": "p0\ntoken one\np2\ntoken two\np4" },
    });

    const result = await executeVaultTool(
      tc("search_content", { query: "token", contextLines: 2 }),
      ctx,
    );

    // contextLines 2 makes the two windows overlap and merge into one hunk;
    // the shared line "p2" must appear exactly once (no separator, no dupes).
    expect(result.content.split("p2").length - 1).toBe(1);
    expect(result.content).toContain("> 2: token one");
    expect(result.content).toContain("> 4: token two");
    expect(result.content).not.toContain("--");
  });

  test("clamps contextLines to the supported maximum", async () => {
    const a = makeFile("note.md");
    const body = Array.from({ length: 30 }, (_, i) => (i === 15 ? "the token here" : `p${i}`)).join(
      "\n",
    );
    const ctx = makeCtx({ files: [a], fileContents: { "note.md": body } });

    const result = await executeVaultTool(
      tc("search_content", { query: "token", contextLines: 999 }),
      ctx,
    );

    // Clamped to 5: lines 11..21 (p10..p20 around match at line 16) — not the whole note.
    expect(result.content).toContain("> 16: the token here");
    expect(result.content).toContain("p10");
    expect(result.content).not.toContain("p9");
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
// semantic_search
// ---------------------------------------------------------------------------

describe("semantic_search", () => {
  test("returns error when query is missing", async () => {
    const ctx = makeCtx({ ragAvailability: "ready" });
    const result = await executeVaultTool(tc("semantic_search", {}), ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Error:");
  });

  test("no embedding backend: errors and points at search_content, not 'build the index'", async () => {
    const ctx = makeCtx({ ragAvailability: "no-backend" });
    const result = await executeVaultTool(tc("semantic_search", { query: "test" }), ctx);

    expect(result.isError).toBe(true);
    expect(result.content).toContain("no embedding model is configured");
    expect(result.content).toContain("search_content");
    // Must NOT prescribe the impossible recovery for a pure cloud user.
    expect(result.content).not.toContain("Build index");
  });

  test("configured but empty index: errors and nudges to build the index", async () => {
    const ctx = makeCtx({ ragAvailability: "index-empty" });
    const result = await executeVaultTool(tc("semantic_search", { query: "test" }), ctx);

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Build index");
    expect(result.content).toContain("search_content");
  });

  test("unreachable backend: surfaces a failure to run, NOT an empty vault", async () => {
    const ctx = makeCtx({
      ragAvailability: "ready",
      ragRetrieve: () => Promise.reject(new RagRetrievalError("Embedding response contained no data.")),
    });
    const result = await executeVaultTool(tc("semantic_search", { query: "test" }), ctx);

    expect(result.isError).toBe(true);
    expect(result.content).toContain("unreachable");
    // The defect this guards against: never report "no results" for a run that failed.
    expect(result.content).not.toContain("No results found");
  });

  test("ready with no matches: reports empty result without erroring", async () => {
    const ctx = makeCtx({ ragAvailability: "ready", ragRetrieve: () => Promise.resolve([]) });
    const result = await executeVaultTool(tc("semantic_search", { query: "ghost" }), ctx);

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain('No results found for query: "ghost"');
  });

  test("ready with matches: renders file paths, scores, and content", async () => {
    const ctx = makeCtx({
      ragAvailability: "ready",
      ragRetrieve: () =>
        Promise.resolve([
          {
            filePath: "Characters/Will.md",
            headingPath: "Background",
            content: "Will trained as a smith.",
            score: 0.912,
          },
        ]),
    });
    const result = await executeVaultTool(tc("semantic_search", { query: "Will" }), ctx);

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("Characters/Will.md > Background");
    expect(result.content).toContain("0.912");
    expect(result.content).toContain("Will trained as a smith.");
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
