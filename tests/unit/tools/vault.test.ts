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
// list_directory + depth (RFC-0015: directory_tree is absorbed here, D5/D6)
//
// The expected strings below are the *pre-merge* bytes, captured by running the old
// executeListDirectory on these exact fixtures before the merge landed, not
// transcribed from the source. D6's claim is that a call without depth is unchanged,
// and this is the instrument for it.
// ---------------------------------------------------------------------------

/** "Root" holding one note and a chain of `levels` subfolders, each holding one note. */
function makeNestedRoot(levels: number): TFolder {
  const paths = ["Root"];
  for (let i = 1; i <= levels; i++) paths.push(`${paths[i - 1]}/L${i}`);

  let built: TFolder | null = null;
  for (let i = levels; i >= 0; i--) {
    const children: (TFile | TFolder)[] = [makeFile(`${paths[i]}/n${i}.md`)];
    if (built) children.push(built);
    built = makeFolder(paths[i], children);
  }
  return built as TFolder;
}

describe("list_directory depth", () => {
  test("without depth, output is byte-identical to the pre-merge listing", async () => {
    const drafts = makeFolder("Characters/Drafts", [
      makeFile("Characters/Drafts/old.md"),
      makeFolder("Characters/Drafts/Deep", [makeFile("Characters/Drafts/Deep/deeper.md")]),
    ]);
    const folder = makeFolder("Characters", [
      makeFile("Characters/Alaric.md"),
      makeFile("Characters/Will.md"),
      drafts,
    ]);

    const listed = await executeVaultTool(
      tc("list_directory", { path: "Characters" }),
      makeCtx({ abstractFiles: { Characters: folder } }),
    );
    expect(listed.content).toBe(
      'Contents of "Characters":\n' +
        "[DIR] Characters/Drafts\n" +
        "[FILE] Characters/Alaric.md\n" +
        "[FILE] Characters/Will.md",
    );

    const root = await executeVaultTool(
      tc("list_directory", {}),
      makeCtx({ root: makeFolder("", [makeFile("index.md")]) }),
    );
    expect(root.content).toBe("Vault root:\n[FILE] index.md");

    const empty = await executeVaultTool(
      tc("list_directory", { path: "Empty" }),
      makeCtx({ abstractFiles: { Empty: makeFolder("Empty") } }),
    );
    expect(empty.content).toBe('Contents of "Empty": (empty)');
  });

  test("depth 3 lists three folder levels, and nothing below them", async () => {
    const ctx = makeCtx({ abstractFiles: { Root: makeNestedRoot(5) } });
    const result = await executeVaultTool(tc("list_directory", { path: "Root", depth: 3 }), ctx);

    expect(result.isReadOnly).toBe(true);
    expect(result.isError).toBeUndefined();
    expect(result.content).toBe(
      'Contents of "Root":\n' +
        "[DIR] Root/L1\n" +
        "[DIR] Root/L1/L2\n" +
        "[DIR] Root/L1/L2/L3\n" +
        "[FILE] Root/L1/L2/n2.md\n" +
        "[FILE] Root/L1/n1.md\n" +
        "[FILE] Root/n0.md",
    );
  });

  test("an out-of-range depth clamps rather than erroring, exactly as topK does", async () => {
    const ctx = makeCtx({ abstractFiles: { Root: makeNestedRoot(6) } });
    const listAt = async (depth: unknown) =>
      (await executeVaultTool(tc("list_directory", { path: "Root", depth }), ctx)).content;

    // Above the range: clamped to 5, so it stops where depth 5 stops and never reaches
    // L6, even though the fixture nests six levels deep.
    expect(await listAt(9)).toBe(await listAt(5));
    expect(await listAt(9)).toContain("[DIR] Root/L1/L2/L3/L4/L5\n");
    expect(await listAt(9)).not.toContain("Root/L1/L2/L3/L4/L5/L6");
    // The ceiling is 5 and not lower: depth 4 stops one level short of what 5 reaches.
    expect(await listAt(4)).not.toContain("[DIR] Root/L1/L2/L3/L4/L5\n");
    // Below the range, and a fractional value: floored into range, never refused.
    expect(await listAt(0)).toBe(await listAt(1));
    expect(await listAt(-4)).toBe(await listAt(1));
    expect(await listAt(2.7)).toBe(await listAt(2));
    // Non-numeric is ignored, so the call behaves as if depth were absent.
    expect(await listAt("deep")).toBe(await listAt(undefined));
    for (const depth of [9, 0, -4, 2.7, "deep"]) {
      const result = await executeVaultTool(tc("list_directory", { path: "Root", depth }), ctx);
      expect(result.isError, `depth ${String(depth)} must not error`).toBeUndefined();
    }
  });

  test("a listing over the entry bound truncates, names the next move, and does not error", async () => {
    const files = Array.from({ length: 600 }, (_, i) =>
      makeFile(`Big/n${String(i).padStart(4, "0")}.md`),
    );
    const ctx = makeCtx({ abstractFiles: { Big: makeFolder("Big", files) } });
    const result = await executeVaultTool(tc("list_directory", { path: "Big" }), ctx);

    // RFC-0010: a bound on our own output clamps at write time, it never gates a read.
    expect(result.isError).toBeUndefined();
    expect(result.isReadOnly).toBe(true);
    expect(result.content.startsWith('Contents of "Big", showing first 500 of 600:\n')).toBe(true);
    expect(result.content).toContain("[FILE] Big/n0000.md");
    expect(result.content).not.toContain("[FILE] Big/n0500.md");
    expect(result.content).toContain(
      "[Showing 500 of 600 entries, narrow path to a subfolder or lower depth to see the rest.]",
    );
  });

  test("a listing exactly at the entry bound is not truncated", async () => {
    const files = Array.from({ length: 500 }, (_, i) =>
      makeFile(`Big/n${String(i).padStart(4, "0")}.md`),
    );
    const ctx = makeCtx({ abstractFiles: { Big: makeFolder("Big", files) } });
    const result = await executeVaultTool(tc("list_directory", { path: "Big" }), ctx);

    expect(result.content.startsWith('Contents of "Big":\n')).toBe(true);
    expect(result.content).not.toContain("showing first");
    expect(result.content).toContain("[FILE] Big/n0499.md");
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
// get_outline, and the structured note the read tests below share (D6)
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

/** A note whose bare "Scene" heading is duplicated under two different acts. */
function dupCtx(): VaultToolContext {
  return makeCtx({
    files: [makeFile("Dup.md")],
    fileContents: {
      "Dup.md": ["# Act I", "## Scene", "a", "# Act II", "## Scene", "b"].join("\n"),
    },
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
}

/** A note with no headings at all, the case both read pathways have to speak to. */
function flatCtx(): VaultToolContext {
  return makeCtx({
    files: [makeFile("Flat.md")],
    fileContents: { "Flat.md": "just prose, no structure" },
    fileCaches: { "Flat.md": {} },
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

  test("says so and points at the whole-note read for a note with no headings", async () => {
    const result = await executeVaultTool(tc("get_outline", { path: "Flat.md" }), flatCtx());

    expect(result.isError).toBeUndefined();
    expect(result.content).toBe('Note "Flat.md" has no headings; read it whole with read.');
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

// ---------------------------------------------------------------------------
// read (RFC-0015: read_file + read_section merge here, D4)
//
// The per-pathway expectations below are the *pre-merge* bytes of the two
// predecessors, captured by running them on these exact fixtures before the merge
// landed. The gate's claim is that path alone returns exactly what read_file
// returned and path plus headingPath exactly what read_section returned, offset
// line numbers included.
// ---------------------------------------------------------------------------

describe("read", () => {
  const WHOLE_SMALL = "[Notes/chapter.md]\n\n1\tFirst line.\n2\tSecond line.\n3\tThird line.";
  const WHOLE_WIDE =
    "[big.md]\n\n 1\tline 1\n 2\tline 2\n 3\tline 3\n 4\tline 4\n 5\tline 5\n 6\tline 6\n" +
    " 7\tline 7\n 8\tline 8\n 9\tline 9\n10\tline 10\n11\tline 11\n12\tline 12";
  const WHOLE_BOOK =
    "[Book.md]\n\n1\t# Act I\n2\tintro\n3\t## Chapter 1\n4\tthe duel was fierce\n5\t\n" +
    "6\t## Chapter 2\n7\tcalm after the storm";
  const SECTION_LEAF = "[Book.md > Act I > Chapter 1]\n\n3\t## Chapter 1\n4\tthe duel was fierce";
  const SECTION_TAIL = "[Book.md > Act I > Chapter 2]\n\n6\t## Chapter 2\n7\tcalm after the storm";
  const SECTION_PARENT =
    "[Book.md > Act I]\n\n1\t# Act I\n2\tintro\n3\t## Chapter 1\n4\tthe duel was fierce\n5\t\n" +
    "6\t## Chapter 2\n7\tcalm after the storm";

  const chapterCtx = () =>
    makeCtx({
      files: [makeFile("Notes/chapter.md")],
      fileContents: { "Notes/chapter.md": "First line.\nSecond line.\nThird line." },
    });

  test("path alone is byte-identical to the retired read_file", async () => {
    const result = await executeVaultTool(
      tc("read", { path: "Notes/chapter.md" }),
      chapterCtx(),
    );

    expect(result.isReadOnly).toBe(true);
    expect(result.isError).toBeUndefined();
    expect(result.content).toBe(WHOLE_SMALL);
  });

  test("right-aligns line numbers so anchors line up on a longer note", async () => {
    const body = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join("\n");
    const ctx = makeCtx({ files: [makeFile("big.md")], fileContents: { "big.md": body } });

    const result = await executeVaultTool(tc("read", { path: "big.md" }), ctx);

    expect(result.content).toBe(WHOLE_WIDE);
  });

  test("path and headingPath is byte-identical to the retired read_section", async () => {
    const leaf = await executeVaultTool(
      tc("read", { path: "Book.md", headingPath: "Act I > Chapter 1" }),
      bookCtx(),
    );

    expect(leaf.isReadOnly).toBe(true);
    expect(leaf.isError).toBeUndefined();
    // The offset line numbers are the note's own (the heading is file line 3), which is
    // the piece of the byte-for-byte claim most easily got wrong by hand.
    expect(leaf.content).toBe(SECTION_LEAF);
    // Stops at the next equal-level heading; does not bleed into Chapter 2.
    expect(leaf.content).not.toContain("calm after the storm");

    const tail = await executeVaultTool(
      tc("read", { path: "Book.md", headingPath: "Act I > Chapter 2" }),
      bookCtx(),
    );
    expect(tail.content).toBe(SECTION_TAIL);
  });

  // D4's dispatch, stated from both sides on one note: the same path with and without a
  // headingPath is the whole note and one section of it.
  test("headingPath is what narrows the read; without it a structured note comes back whole", async () => {
    const whole = await executeVaultTool(tc("read", { path: "Book.md" }), bookCtx());
    expect(whole.isError).toBeUndefined();
    expect(whole.content).toBe(WHOLE_BOOK);

    const section = await executeVaultTool(
      tc("read", { path: "Book.md", headingPath: "Act I > Chapter 1" }),
      bookCtx(),
    );
    expect(section.content).toBe(SECTION_LEAF);
  });

  // A blank headingPath is an absent one: it widens to the whole note rather than
  // refusing, so there is no value that returns a plausible wrong answer (D7's
  // principle, applied to the parameter this tool dispatches on).
  test("a blank headingPath reads the note whole rather than refusing", async () => {
    const result = await executeVaultTool(
      tc("read", { path: "Book.md", headingPath: "   " }),
      bookCtx(),
    );
    expect(result.isError).toBeUndefined();
    expect(result.content).toBe(WHOLE_BOOK);
  });

  test("a parent section includes its nested subsections", async () => {
    const result = await executeVaultTool(
      tc("read", { path: "Book.md", headingPath: "Act I" }),
      bookCtx(),
    );
    expect(result.content).toBe(SECTION_PARENT);
  });

  test("a duplicated heading is an ambiguous failure listing the candidate paths", async () => {
    const result = await executeVaultTool(
      tc("read", { path: "Dup.md", headingPath: "Scene" }),
      dupCtx(),
    );

    expect(result.isError).toBe(true);
    expect(result.failure?.kind).toBe("ambiguous");
    expect(result.content).toBe(
      'Error: heading "Scene" matches 2 sections in "Dup.md". ' +
        "pass one of these full headingPaths: Act I > Scene | Act II > Scene.",
    );
  });

  test("an unknown heading is a not-found that points at get_outline", async () => {
    const result = await executeVaultTool(
      tc("read", { path: "Book.md", headingPath: "Epilogue" }),
      bookCtx(),
    );
    expect(result.isError).toBe(true);
    expect(result.failure?.kind).toBe("not-found");
    expect(result.content).toBe(
      'Error: no heading matching "Epilogue" in "Book.md". ' +
        "call get_outline to see the note's exact heading paths.",
    );
  });

  // The one place the merge changes what the model is told: the wrong-sibling clause
  // named a tool that no longer exists, so it now names the parameter to drop (D4).
  test("on a headingless note the section pathway says to omit headingPath", async () => {
    const result = await executeVaultTool(
      tc("read", { path: "Flat.md", headingPath: "Anything" }),
      flatCtx(),
    );
    expect(result.isError).toBe(true);
    expect(result.failure?.kind).toBe("not-found");
    expect(result.content).toBe(
      'Error: note "Flat.md" has no headings to read a section from. ' +
        "omit headingPath to read it whole.",
    );
    expect(result.content).not.toContain("read_file");
  });

  test("errors with invalid-args when path is missing, on either pathway", async () => {
    const bare = await executeVaultTool(tc("read", {}), bookCtx());
    expect(bare.failure?.kind).toBe("invalid-args");
    const sectioned = await executeVaultTool(tc("read", { headingPath: "Act I" }), bookCtx());
    expect(sectioned.failure?.kind).toBe("invalid-args");
  });
});

// ---------------------------------------------------------------------------
// get_links (RFC-0015: get_backlinks + get_outgoing_links merge here, D7)
//
// The per-direction expectations below are the *pre-merge* bytes of the two
// predecessors, captured by running them on these fixtures before the merge landed.
// The gate's claim is that narrowing to a direction returns exactly what its
// predecessor returned, including the two empty-result sentences.
// ---------------------------------------------------------------------------

describe("get_links", () => {
  const LINKED = () =>
    makeCtx({
      files: [makeFile("Characters/Will.md")],
      backlinks: {
        "Characters/Will.md": { "Scenes/Act2.md": [], "Scenes/Act1.md": [] },
      },
      resolvedLinks: {
        "Characters/Will.md": { "Lore/The Fold.md": 2, "Characters/Alaric.md": 1 },
      },
    });
  const LONELY = () => makeCtx({ files: [makeFile("Scenes/Lonely.md")] });

  const INCOMING_HITS =
    'Notes linking to "Characters/Will.md" (2):\nScenes/Act1.md\nScenes/Act2.md';
  const OUTGOING_HITS =
    'Notes "Characters/Will.md" links to (2):\nCharacters/Alaric.md\nLore/The Fold.md';
  const INCOMING_EMPTY =
    'No notes link to "Scenes/Lonely.md". This note has no incoming wikilinks; nothing to follow up.';
  const OUTGOING_EMPTY =
    '"Scenes/Lonely.md" has no outgoing links. This note links to no other notes; nothing to follow up.';

  test("direction incoming is byte-identical to the retired get_backlinks", async () => {
    const hits = await executeVaultTool(
      tc("get_links", { path: "Characters/Will.md", direction: "incoming" }),
      LINKED(),
    );
    expect(hits.isReadOnly).toBe(true);
    expect(hits.isError).toBeUndefined();
    expect(hits.content).toBe(INCOMING_HITS);

    const empty = await executeVaultTool(
      tc("get_links", { path: "Scenes/Lonely.md", direction: "incoming" }),
      LONELY(),
    );
    expect(empty.isError).toBeUndefined();
    expect(empty.content).toBe(INCOMING_EMPTY);
  });

  test("direction outgoing is byte-identical to the retired get_outgoing_links", async () => {
    const hits = await executeVaultTool(
      tc("get_links", { path: "Characters/Will.md", direction: "outgoing" }),
      LINKED(),
    );
    expect(hits.isReadOnly).toBe(true);
    expect(hits.isError).toBeUndefined();
    expect(hits.content).toBe(OUTGOING_HITS);

    const empty = await executeVaultTool(
      tc("get_links", { path: "Scenes/Lonely.md", direction: "outgoing" }),
      LONELY(),
    );
    expect(empty.isError).toBeUndefined();
    expect(empty.content).toBe(OUTGOING_EMPTY);
  });

  test("omitting direction returns both, each under its own heading", async () => {
    const both = await executeVaultTool(
      tc("get_links", { path: "Characters/Will.md" }),
      LINKED(),
    );
    expect(both.isReadOnly).toBe(true);
    expect(both.isError).toBeUndefined();
    expect(both.content).toBe(`${INCOMING_HITS}\n\n${OUTGOING_HITS}`);
  });

  test("an empty direction keeps its own sentence beside the other's hits", async () => {
    const ctx = makeCtx({
      files: [makeFile("Scenes/Lonely.md")],
      resolvedLinks: { "Scenes/Lonely.md": { "Lore/The Fold.md": 1 } },
    });
    const result = await executeVaultTool(tc("get_links", { path: "Scenes/Lonely.md" }), ctx);

    expect(result.isError).toBeUndefined();
    expect(result.content).toBe(
      `${INCOMING_EMPTY}\n\nNotes "Scenes/Lonely.md" links to (1):\nLore/The Fold.md`,
    );
  });

  test("both directions empty reads as two sentences, not an error", async () => {
    const result = await executeVaultTool(tc("get_links", { path: "Scenes/Lonely.md" }), LONELY());
    expect(result.isError).toBeUndefined();
    expect(result.content).toBe(`${INCOMING_EMPTY}\n\n${OUTGOING_EMPTY}`);
  });

  // D7's point: there is no wrong value to pick. An unrecognised direction widens to
  // both rather than refusing, so the answer is always a superset of what was asked.
  test("an unrecognised direction returns both rather than refusing", async () => {
    const result = await executeVaultTool(
      tc("get_links", { path: "Characters/Will.md", direction: "backwards" }),
      LINKED(),
    );
    expect(result.isError).toBeUndefined();
    expect(result.content).toBe(`${INCOMING_HITS}\n\n${OUTGOING_HITS}`);
  });

  test("returns error when note not found", async () => {
    const ctx = makeCtx({});
    const result = await executeVaultTool(tc("get_links", { path: "Missing.md" }), ctx);

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Error:");
  });

  test("returns error when path is empty", async () => {
    const ctx = makeCtx({});
    const result = await executeVaultTool(tc("get_links", { path: "" }), ctx);
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
    const result = await executeVaultTool(tc("read", {}), ctx);
    expect(result.failure?.kind).toBe("invalid-args");
    expect(result.failure?.recovery).toBeTruthy();
  });

  test("a missing note is not-found and points at a way to locate it", async () => {
    const ctx = makeCtx({});
    const result = await executeVaultTool(tc("read", { path: "Missing.md" }), ctx);
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

  // Both read pathways, because the merge put them behind one entry point: a boundary
  // check that only guarded the whole-note arm would leave the section arm open.
  test("read names the boundary on either pathway, never reaching the lookup", async () => {
    const ctx = makeCtx({ files: [makeFile("In/Vault.md")] });
    for (const path of ESCAPING) {
      expectBoundaryRefusal(await executeVaultTool(tc("read", { path }), ctx));
      expectBoundaryRefusal(
        await executeVaultTool(tc("read", { path, headingPath: "Any" }), ctx),
      );
    }
    // Backstop preserved: the index lookup was never even reached for an escaping path.
    expect(ctx.app.vault.getFileByPath).not.toHaveBeenCalled();
    expect(ctx.app.vault.read).not.toHaveBeenCalled();
  });

  test("get_links names the boundary, in every direction, never reaching the lookup", async () => {
    const ctx = makeCtx({ files: [makeFile("In/Vault.md")] });
    for (const path of ESCAPING) {
      for (const direction of [undefined, "incoming", "outgoing"]) {
        expectBoundaryRefusal(await executeVaultTool(tc("get_links", { path, direction }), ctx));
      }
    }
    expect(ctx.app.vault.getFileByPath).not.toHaveBeenCalled();
  });

  test("get_outline names the boundary, never reaching the lookup", async () => {
    const ctx = makeCtx({ files: [makeFile("In/Vault.md")] });
    for (const path of ESCAPING) {
      expectBoundaryRefusal(await executeVaultTool(tc("get_outline", { path }), ctx));
    }
    expect(ctx.app.vault.getFileByPath).not.toHaveBeenCalled();
    expect(ctx.app.vault.read).not.toHaveBeenCalled();
  });

  test("list_directory names the boundary for an out-of-vault folder, at any depth", async () => {
    const ctx = makeCtx({ abstractFiles: { In: makeFolder("In") } });
    for (const depth of [undefined, 1, 5]) {
      expectBoundaryRefusal(
        await executeVaultTool(tc("list_directory", { path: "../..", depth }), ctx),
      );
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
