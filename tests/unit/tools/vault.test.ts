import { describe, test, expect, vi } from "vitest";
import { TFile, TFolder } from "obsidian";
import { executeVaultTool } from "../../../src/tools/vault/handlers";
import type { VaultToolContext } from "../../../src/tools/vault/handlers";
import type { ToolCall, ToolResult } from "../../../src/tools/types";
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
  resolvedLinks?: Record<string, Record<string, number>>;
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
    resolvedLinks = {},
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
        resolvedLinks,
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

    // Clamped to 5: lines 11..21 (p10..p20 around match at line 16), not the whole note.
    expect(result.content).toContain("> 16: the token here");
    expect(result.content).toContain("p10");
    expect(result.content).not.toContain("p9");
  });
});

// ---------------------------------------------------------------------------
// read_file
// ---------------------------------------------------------------------------

describe("read_file", () => {
  test("returns content with cat -n style line numbers under the path header", async () => {
    const note = makeFile("Notes/chapter.md");
    const ctx = makeCtx({
      files: [note],
      fileContents: { "Notes/chapter.md": "First line.\nSecond line.\nThird line." },
    });

    const result = await executeVaultTool(tc("read_file", { path: "Notes/chapter.md" }), ctx);

    expect(result.isReadOnly).toBe(true);
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("[Notes/chapter.md]");
    expect(result.content).toContain("1\tFirst line.");
    expect(result.content).toContain("2\tSecond line.");
    expect(result.content).toContain("3\tThird line.");
  });

  test("right-aligns line numbers so anchors line up on a longer note", async () => {
    const note = makeFile("big.md");
    const body = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join("\n");
    const ctx = makeCtx({ files: [note], fileContents: { "big.md": body } });

    const result = await executeVaultTool(tc("read_file", { path: "big.md" }), ctx);

    expect(result.content).toContain(" 1\tline 1");
    expect(result.content).toContain("12\tline 12");
  });
});

// ---------------------------------------------------------------------------
// get_outline / read_section (D6)
// ---------------------------------------------------------------------------

// A small structured note shared by the outline/section tests:
//   0  # Act I
//   1  intro
//   2  ## Chapter 1
//   3  the duel was fierce
//   4  (blank)
//   5  ## Chapter 2
//   6  calm after the storm
const BOOK_BODY = [
  "# Act I",
  "intro",
  "## Chapter 1",
  "the duel was fierce",
  "",
  "## Chapter 2",
  "calm after the storm",
].join("\n");

const BOOK_HEADINGS = [
  { heading: "Act I", level: 1, position: { start: { line: 0 } } },
  { heading: "Chapter 1", level: 2, position: { start: { line: 2 } } },
  { heading: "Chapter 2", level: 2, position: { start: { line: 5 } } },
];

function bookCtx(): VaultToolContext {
  return makeCtx({
    files: [makeFile("Book.md")],
    fileContents: { "Book.md": BOOK_BODY },
    fileCaches: { "Book.md": { headings: BOOK_HEADINGS } },
  });
}

describe("get_outline", () => {
  test("returns JSON with depth, full headingPath, and per-section word/line counts", async () => {
    const result = await executeVaultTool(tc("get_outline", { path: "Book.md" }), bookCtx());

    expect(result.isReadOnly).toBe(true);
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content);
    expect(parsed.path).toBe("Book.md");
    expect(parsed.headingCount).toBe(3);
    expect(parsed.headings[0]).toMatchObject({ depth: 1, headingPath: "Act I" });
    expect(parsed.headings[1]).toMatchObject({ depth: 2, headingPath: "Act I > Chapter 1" });
    expect(parsed.headings[2]).toMatchObject({ depth: 2, headingPath: "Act I > Chapter 2" });
    // Chapter 1 section = "## Chapter 1\nthe duel was fierce" (trailing blank trimmed):
    // 2 lines, 6 words (heading markers stripped: Chapter, 1, the, duel, was, fierce).
    expect(parsed.headings[1].lines).toBe(2);
    expect(parsed.headings[1].words).toBe(6);
  });

  test("says so and points at read_file for a note with no headings", async () => {
    const ctx = makeCtx({
      files: [makeFile("Flat.md")],
      fileContents: { "Flat.md": "just prose, no structure" },
      fileCaches: { "Flat.md": {} },
    });
    const result = await executeVaultTool(tc("get_outline", { path: "Flat.md" }), ctx);

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("no headings");
    expect(result.content).toContain("read_file");
  });

  test("errors with not-found when the note does not exist", async () => {
    const result = await executeVaultTool(tc("get_outline", { path: "Nope.md" }), makeCtx({}));
    expect(result.isError).toBe(true);
    expect(result.failure?.kind).toBe("not-found");
  });

  test("errors with invalid-args when path is missing", async () => {
    const result = await executeVaultTool(tc("get_outline", {}), makeCtx({}));
    expect(result.failure?.kind).toBe("invalid-args");
  });
});

describe("read_section", () => {
  test("reads a section by its full headingPath with file-consistent line numbers", async () => {
    const result = await executeVaultTool(
      tc("read_section", { path: "Book.md", headingPath: "Act I > Chapter 1" }),
      bookCtx(),
    );

    expect(result.isReadOnly).toBe(true);
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("[Book.md > Act I > Chapter 1]");
    // Line numbers match read_file's whole-file numbering (heading is file line 3).
    expect(result.content).toContain("3\t## Chapter 1");
    expect(result.content).toContain("4\tthe duel was fierce");
    // Stops at the next equal-level heading; does not bleed into Chapter 2.
    expect(result.content).not.toContain("Chapter 2");
  });

  test("a parent section includes its nested subsections", async () => {
    const result = await executeVaultTool(
      tc("read_section", { path: "Book.md", headingPath: "Act I" }),
      bookCtx(),
    );
    expect(result.content).toContain("1\t# Act I");
    expect(result.content).toContain("## Chapter 1");
    expect(result.content).toContain("## Chapter 2");
  });

  test("a duplicated heading is an ambiguous failure listing the candidate paths", async () => {
    const dupBody = ["# Act I", "## Scene", "a", "# Act II", "## Scene", "b"].join("\n");
    const ctx = makeCtx({
      files: [makeFile("Dup.md")],
      fileContents: { "Dup.md": dupBody },
      fileCaches: {
        "Dup.md": {
          headings: [
            { heading: "Act I", level: 1, position: { start: { line: 0 } } },
            { heading: "Scene", level: 2, position: { start: { line: 1 } } },
            { heading: "Act II", level: 1, position: { start: { line: 3 } } },
            { heading: "Scene", level: 2, position: { start: { line: 4 } } },
          ],
        },
      },
    });
    const result = await executeVaultTool(
      tc("read_section", { path: "Dup.md", headingPath: "Scene" }),
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(result.failure?.kind).toBe("ambiguous");
    expect(result.content).toContain("Act I > Scene");
    expect(result.content).toContain("Act II > Scene");
  });

  test("an unknown heading is a not-found that points at get_outline", async () => {
    const result = await executeVaultTool(
      tc("read_section", { path: "Book.md", headingPath: "Epilogue" }),
      bookCtx(),
    );
    expect(result.isError).toBe(true);
    expect(result.failure?.kind).toBe("not-found");
    expect(result.content).toContain("get_outline");
  });

  test("on a headingless note it points at read_file, not get_outline", async () => {
    const ctx = makeCtx({
      files: [makeFile("Flat.md")],
      fileContents: { "Flat.md": "just prose" },
      fileCaches: { "Flat.md": {} },
    });
    const result = await executeVaultTool(
      tc("read_section", { path: "Flat.md", headingPath: "Anything" }),
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("read_file");
  });

  test("errors with invalid-args when path or headingPath is missing", async () => {
    const ctx = bookCtx();
    const noPath = await executeVaultTool(tc("read_section", { headingPath: "x" }), ctx);
    expect(noPath.failure?.kind).toBe("invalid-args");
    const noHeading = await executeVaultTool(tc("read_section", { path: "Book.md" }), ctx);
    expect(noHeading.failure?.kind).toBe("invalid-args");
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
// get_outgoing_links (M3, the forward-link mirror of get_backlinks)
// ---------------------------------------------------------------------------

describe("get_outgoing_links", () => {
  test("returns the notes the target links out to (resolved links)", async () => {
    const source = makeFile("Scenes/Act1.md");
    const ctx = makeCtx({
      files: [source],
      resolvedLinks: {
        "Scenes/Act1.md": {
          "Characters/Will.md": 1,
          "Lore/The Fold.md": 2,
        },
      },
    });

    const result = await executeVaultTool(
      tc("get_outgoing_links", { path: "Scenes/Act1.md" }),
      ctx,
    );

    expect(result.isReadOnly).toBe(true);
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("Characters/Will.md");
    expect(result.content).toContain("Lore/The Fold.md");
    expect(result.content).toContain("(2)");
  });

  test("reports no outgoing links when the note references nothing", async () => {
    const source = makeFile("Scenes/Lonely.md");
    const ctx = makeCtx({ files: [source] });

    const result = await executeVaultTool(
      tc("get_outgoing_links", { path: "Scenes/Lonely.md" }),
      ctx,
    );
    expect(result.content).toContain("no outgoing");
    expect(result.isError).toBeUndefined();
  });

  test("returns error when note not found", async () => {
    const ctx = makeCtx({});
    const result = await executeVaultTool(tc("get_outgoing_links", { path: "Missing.md" }), ctx);

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Error:");
  });

  test("returns error when path is empty", async () => {
    const ctx = makeCtx({});
    const result = await executeVaultTool(tc("get_outgoing_links", { path: "" }), ctx);
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
          frontmatter: { species: "human", affiliation: "Guild", position: { start: 0 } },
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

  // The limit argument was advertised and discarded from 2026-04-10 until it was wired
  // on 2026-08-02: the handler read only `query`, so a model asking for a broader survey
  // got the configured default and no signal that its request went nowhere.
  describe("topK reaches the retriever", () => {
    function retrieveArgs(ctx: VaultToolContext): unknown[] {
      return (ctx.ragService.retrieve as unknown as { mock: { calls: unknown[][] } }).mock.calls[0];
    }

    async function callWith(args: Record<string, unknown>): Promise<unknown[]> {
      const ctx = makeCtx({ ragAvailability: "ready", ragRetrieve: () => Promise.resolve([]) });
      await executeVaultTool(tc("semantic_search", { query: "Will", ...args }), ctx);
      return retrieveArgs(ctx);
    }

    test("an explicit topK is passed through", async () => {
      expect(await callWith({ topK: 3 })).toEqual(["Will", undefined,3]);
    });

    test("omitting it leaves the configured retrieval limit in charge", async () => {
      expect(await callWith({})).toEqual(["Will", undefined,undefined]);
    });

    // Clamping rather than erroring mirrors search_content's contextLines: the model
    // named a breadth, and the nearest legal breadth beats spending a round trip.
    test("an out-of-range topK clamps instead of erroring", async () => {
      expect(await callWith({ topK: 999 })).toEqual(["Will", undefined,20]);
      expect(await callWith({ topK: 0 })).toEqual(["Will", undefined,1]);
      expect(await callWith({ topK: 2.7 })).toEqual(["Will", undefined,2]);
    });

    test("a non-numeric topK is ignored rather than coerced", async () => {
      expect(await callWith({ topK: "lots" })).toEqual(["Will", undefined,undefined]);
    });
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

// ---------------------------------------------------------------------------
// Structured failure contract (ToolResult.failure)
// ---------------------------------------------------------------------------

describe("failure contract", () => {
  test("a missing path is invalid-args with a recovery step", async () => {
    const ctx = makeCtx({});
    const result = await executeVaultTool(tc("read_file", {}), ctx);
    expect(result.failure?.kind).toBe("invalid-args");
    expect(result.failure?.recovery).toBeTruthy();
  });

  test("a missing note is not-found and points at a way to locate it", async () => {
    const ctx = makeCtx({});
    const result = await executeVaultTool(tc("read_file", { path: "Missing.md" }), ctx);
    expect(result.failure?.kind).toBe("not-found");
    expect(result.content).toContain("list_directory");
  });

  test("an unavailable semantic backend is tagged unavailable, not laundered to no-match", async () => {
    const ctx = makeCtx({ ragAvailability: "no-backend" });
    const result = await executeVaultTool(tc("semantic_search", { query: "x" }), ctx);
    expect(result.failure?.kind).toBe("unavailable");
  });

  test("an empty (but successful) search carries no failure", async () => {
    const a = makeFile("note.md");
    const ctx = makeCtx({ files: [a], fileContents: { "note.md": "nothing relevant" } });
    const result = await executeVaultTool(tc("search_content", { query: "absent" }), ctx);
    expect(result.isError).toBeUndefined();
    expect(result.failure).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Path-boundary safety, reads name the boundary, and never disclose an
// out-of-vault file.
//
// An out-of-vault path (../, drive letter) is refused at the boundary BEFORE the
// index lookup, with the same wording the write channel uses ("outside the vault.
// Use a vault-relative path.") instead of a dead-end "not found" the model can't
// resolve by searching. The index lookup (getFileByPath / getAbstractFileByPath)
// remains behind it as the security backstop, it can only ever return an
// in-vault file, so non-disclosure is preserved. These tests lock both in: the
// boundary message AND that the lookup is never reached for an escaping path.
// ---------------------------------------------------------------------------

describe("path-boundary safety (reads stay inside the vault)", () => {
  const ESCAPING = ["../../etc/passwd", "../secret.md", "C:/Windows/System32/config", "..\\..\\x.md"];

  /** A refusal names the boundary (not "not found") and points at a vault-relative retry. */
  function expectBoundaryRefusal(result: ToolResult) {
    expect(result.isError).toBe(true);
    expect(result.failure?.kind).toBe("invalid-args");
    expect(result.content).toContain("outside the vault");
    expect(result.content).toContain("vault-relative");
    expect(result.content).not.toContain("not found");
  }

  test("read_file names the boundary for an out-of-vault path, never reaching the lookup", async () => {
    const ctx = makeCtx({ files: [makeFile("In/Vault.md")] });
    for (const path of ESCAPING) {
      const result = await executeVaultTool(tc("read_file", { path }), ctx);
      expectBoundaryRefusal(result);
    }
    // Backstop preserved: the index lookup was never even reached for an escaping path.
    expect(ctx.app.vault.getFileByPath).not.toHaveBeenCalled();
    expect(ctx.app.vault.read).not.toHaveBeenCalled();
  });

  test("get_backlinks names the boundary for an out-of-vault path", async () => {
    const ctx = makeCtx({ files: [makeFile("In/Vault.md")] });
    const result = await executeVaultTool(tc("get_backlinks", { path: "../../etc/passwd" }), ctx);
    expectBoundaryRefusal(result);
  });

  test("get_outgoing_links names the boundary, never reaching the lookup", async () => {
    const ctx = makeCtx({ files: [makeFile("In/Vault.md")] });
    for (const path of ESCAPING) {
      expectBoundaryRefusal(await executeVaultTool(tc("get_outgoing_links", { path }), ctx));
    }
    expect(ctx.app.vault.getFileByPath).not.toHaveBeenCalled();
  });

  test("get_outline / read_section name the boundary, never reaching the lookup", async () => {
    const ctx = makeCtx({ files: [makeFile("In/Vault.md")] });
    for (const path of ESCAPING) {
      expectBoundaryRefusal(await executeVaultTool(tc("get_outline", { path }), ctx));
      expectBoundaryRefusal(
        await executeVaultTool(tc("read_section", { path, headingPath: "Any" }), ctx),
      );
    }
    expect(ctx.app.vault.getFileByPath).not.toHaveBeenCalled();
    expect(ctx.app.vault.read).not.toHaveBeenCalled();
  });

  test("list_directory / directory_tree name the boundary for an out-of-vault folder", async () => {
    const ctx = makeCtx({ abstractFiles: { In: makeFolder("In") } });
    for (const name of ["list_directory", "directory_tree"]) {
      const result = await executeVaultTool(tc(name, { path: "../.." }), ctx);
      expectBoundaryRefusal(result);
    }
    expect(ctx.app.vault.getAbstractFileByPath).not.toHaveBeenCalled();
  });

  test("search_files / search_content name the boundary for an out-of-vault scope", async () => {
    const ctx = makeCtx({ files: [makeFile("In/Vault.md")] });
    expectBoundaryRefusal(
      await executeVaultTool(tc("search_files", { pattern: "*", path: "../.." }), ctx),
    );
    expectBoundaryRefusal(
      await executeVaultTool(tc("search_content", { query: "x", path: "C:/Windows" }), ctx),
    );
    // A scope refusal short-circuits before the vault is scanned.
    expect(ctx.app.vault.getMarkdownFiles).not.toHaveBeenCalled();
  });

  test("get_frontmatter reports a per-path boundary error for an out-of-vault path, never reads it", async () => {
    const ctx = makeCtx({ files: [makeFile("In/Vault.md")] });
    const result = await executeVaultTool(
      tc("get_frontmatter", { paths: ["../../secret.md"] }),
      ctx,
    );
    // The call itself succeeds (per-entry errors), but the out-of-vault path names
    // the boundary rather than "No note found", it was never resolved to disk.
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("outside the vault");
    expect(result.content).not.toContain("No note found");
    expect(ctx.app.vault.getFileByPath).not.toHaveBeenCalled();
  });
});
