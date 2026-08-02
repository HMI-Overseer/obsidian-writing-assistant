import { describe, test, expect, vi } from "vitest";
import { INSERT_INTO_NOTE_TOOL } from "../../../src/tools/editing/definition";
import { validateInsertIntoNote } from "../../../src/tools/editing/validation";
import {
  convertToolCallToEditBlock,
  toolCallsToEditBlocks,
} from "../../../src/tools/editing/conversion";
import {
  executeEditTool,
  resolveStructuralEditBlocks,
} from "../../../src/tools/editing/handlers";
import { resolveEdits } from "../../../src/editing/diffEngine";
import { editDispositionMessage } from "../../../src/vault-ops/disposition";
import type { ToolCall } from "../../../src/tools/types";

// ---------------------------------------------------------------------------
// Mock App
// ---------------------------------------------------------------------------

const CTX_PATH = "folder/test.md";

function mockApp(fileContent: string) {
  const file = { name: "test.md", path: CTX_PATH };
  return {
    vault: {
      getFileByPath: vi.fn().mockReturnValue(file),
      read: vi.fn().mockResolvedValue(fileContent),
    },
    workspace: { getActiveFile: vi.fn().mockReturnValue(file) },
    metadataCache: { getFileCache: vi.fn().mockReturnValue({}) },
  } as unknown as import("obsidian").App;
}

/** Resolve a structural insert block against `content`, returning the resolved block. */
async function resolveInsert(
  args: Record<string, unknown>,
  content: string,
) {
  const block = convertToolCallToEditBlock({ id: "t", name: "insert_into_note", arguments: args });
  expect(block).not.toBeNull();
  const [resolved] = await resolveStructuralEditBlocks([block!], {
    app: mockApp(content),
    filePath: CTX_PATH,
  });
  return resolved;
}

// ---------------------------------------------------------------------------
// Definition
// ---------------------------------------------------------------------------

describe("INSERT_INTO_NOTE_TOOL", () => {
  test("has correct name and required params", () => {
    expect(INSERT_INTO_NOTE_TOOL.name).toBe("insert_into_note");
    expect(INSERT_INTO_NOTE_TOOL.parameters.required).toEqual(["path", "content", "where"]);
  });

  test("declares path, anchor, content, where, explanation", () => {
    const props = INSERT_INTO_NOTE_TOOL.parameters.properties;
    expect(props.path).toBeDefined();
    expect(props.anchor).toBeDefined();
    expect(props.content).toBeDefined();
    expect(props.where).toBeDefined();
    expect(props.where.enum).toEqual(["before", "after", "append", "prepend"]);
    expect(props.explanation).toBeDefined();
  });

  test("carries strategyHint and errorGuidance so the prompt auto-derives", () => {
    expect(INSERT_INTO_NOTE_TOOL.strategyHint).toBeTruthy();
    expect(INSERT_INTO_NOTE_TOOL.errorGuidance).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

describe("validateInsertIntoNote", () => {
  test("accepts before/after with an anchor", () => {
    const v = validateInsertIntoNote({ path: "a.md", anchor: "X", content: "Y", where: "after" });
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.args.where).toBe("after");
      expect(v.args.anchor).toBe("X");
      expect(v.args.content).toBe("Y");
    }
  });

  test("accepts append/prepend without an anchor", () => {
    expect(validateInsertIntoNote({ path: "a.md", content: "Y", where: "append" }).ok).toBe(true);
    expect(validateInsertIntoNote({ path: "a.md", content: "Y", where: "prepend" }).ok).toBe(true);
  });

  test("rejects a missing or empty content", () => {
    expect(validateInsertIntoNote({ content: "", where: "append" }).ok).toBe(false);
    expect(validateInsertIntoNote({ where: "append" }).ok).toBe(false);
  });

  test("rejects an unknown where", () => {
    expect(validateInsertIntoNote({ content: "Y", where: "middle" }).ok).toBe(false);
    expect(validateInsertIntoNote({ content: "Y" }).ok).toBe(false);
  });

  test("rejects before/after without an anchor", () => {
    expect(validateInsertIntoNote({ content: "Y", where: "before" }).ok).toBe(false);
    expect(validateInsertIntoNote({ content: "Y", where: "after", anchor: "" }).ok).toBe(false);
  });

  // The payload is `content` now (RFC-0015), and it is required, so a call using the
  // retired `text` spelling must fail loudly and name the parameter it wants rather
  // than falling back and inserting an empty paragraph.
  test("refuses the retired text spelling and names content", () => {
    const v = validateInsertIntoNote({ path: "a.md", text: "Y", where: "append" });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.error).toContain("content");
  });
});

// ---------------------------------------------------------------------------
// Conversion (tool call → structural EditBlock)
// ---------------------------------------------------------------------------

describe("convertToolCallToEditBlock for insert_into_note", () => {
  test("builds a structural block with toolName and toolArgs", () => {
    const block = convertToolCallToEditBlock({
      id: "tc_1",
      name: "insert_into_note",
      arguments: { path: "Lore/A.md", anchor: "X", content: "Y", where: "after" },
    });
    expect(block).not.toBeNull();
    expect(block!.toolName).toBe("insert_into_note");
    expect(block!.targetPath).toBe("Lore/A.md");
    expect(block!.searchText).toBe("");
    expect(block!.replaceText).toBe("");
    expect(block!.toolArgs).toMatchObject({ anchor: "X", content: "Y", where: "after" });
  });

  test("normalizes literal \\n escapes in content and anchor", () => {
    const block = convertToolCallToEditBlock({
      id: "tc_1",
      name: "insert_into_note",
      arguments: { path: "a.md", anchor: "line 1\\nline 2", content: "new\\nlines", where: "before" },
    });
    expect(block!.toolArgs?.anchor).toBe("line 1\nline 2");
    expect(block!.toolArgs?.content).toBe("new\nlines");
  });

  test("returns null for invalid arguments", () => {
    const block = convertToolCallToEditBlock({
      id: "tc_1",
      name: "insert_into_note",
      arguments: { path: "a.md", where: "after" }, // missing content, missing anchor
    });
    expect(block).toBeNull();
  });

  test("toolCallsToEditBlocks keeps one block per insert call (no merge)", () => {
    const calls: ToolCall[] = [
      { id: "1", name: "insert_into_note", arguments: { path: "a.md", content: "A", where: "append" } },
      { id: "2", name: "insert_into_note", arguments: { path: "a.md", content: "B", where: "prepend" } },
    ];
    const blocks = toolCallsToEditBlocks(calls);
    expect(blocks).toHaveLength(2);
    expect(blocks.every((b) => b.toolName === "insert_into_note")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Resolution semantics (the seam: anchor → searchText/replaceText)
// ---------------------------------------------------------------------------

describe("resolveStructuralEditBlocks for insert_into_note", () => {
  test("after: searchText is the anchor, replaceText appends below it", async () => {
    const resolved = await resolveInsert(
      { path: CTX_PATH, anchor: "The hero arrived.", content: "He paused.", where: "after" },
      "# Chapter\n\nThe hero arrived.\n",
    );
    expect(resolved.searchText).toBe("The hero arrived.");
    expect(resolved.replaceText).toBe("The hero arrived.\n\nHe paused.");
  });

  test("before: searchText is the anchor, replaceText prepends above it", async () => {
    const resolved = await resolveInsert(
      { path: CTX_PATH, anchor: "## Scene", content: "Narration.", where: "before" },
      "## Scene\nDialogue.\n",
    );
    expect(resolved.searchText).toBe("## Scene");
    expect(resolved.replaceText).toBe("Narration.\n\n## Scene");
  });

  test("prepend (non-empty doc): empty search inserts a paragraph at the top", async () => {
    const resolved = await resolveInsert(
      { path: CTX_PATH, content: "Intro.", where: "prepend" },
      "Existing.\n",
    );
    expect(resolved.searchText).toBe("");
    expect(resolved.replaceText).toBe("Intro.\n\n");
  });

  test("prepend (empty doc): inserts the body alone, no trailing blank run", async () => {
    const resolved = await resolveInsert({ path: CTX_PATH, content: "Intro.", where: "prepend" }, "");
    expect(resolved.searchText).toBe("");
    expect(resolved.replaceText).toBe("Intro.");
  });

  test("append (unique tail line): anchors the last content line", async () => {
    const resolved = await resolveInsert(
      { path: CTX_PATH, content: "Day 2.", where: "append" },
      "# Journal\n\nDay 1.\n",
    );
    expect(resolved.searchText).toBe("Day 1.");
    expect(resolved.replaceText).toBe("Day 1.\n\nDay 2.");
  });

  test("append (non-unique tail line): grows the anchor upward until unique", async () => {
    const resolved = await resolveInsert(
      { path: CTX_PATH, content: "X", where: "append" },
      "- item\nmiddle\n- item\n",
    );
    // The bare last line "- item" recurs earlier, so the anchor grows to a unique block.
    expect(resolved.searchText).toBe("middle\n- item");
    expect(resolved.replaceText).toBe("middle\n- item\n\nX");
  });

  test("append (empty doc): inserts the body alone", async () => {
    const resolved = await resolveInsert({ path: CTX_PATH, content: "First.", where: "append" }, "");
    expect(resolved.searchText).toBe("");
    expect(resolved.replaceText).toBe("First.");
  });

  test("trims surrounding blank lines in the inserted text", async () => {
    const resolved = await resolveInsert(
      { path: CTX_PATH, anchor: "Anchor", content: "\n\nbody\n\n", where: "after" },
      "Anchor\n",
    );
    expect(resolved.replaceText).toBe("Anchor\n\nbody");
  });
});

// ---------------------------------------------------------------------------
// End to end: resolved insert applies through the diff engine
// ---------------------------------------------------------------------------

describe("insert_into_note resolves to an applicable edit", () => {
  test("after-anchor resolves to a confident exact match the apply step can splice", async () => {
    const doc = "# Chapter\n\nThe hero arrived.\n";
    const resolved = await resolveInsert(
      { path: CTX_PATH, anchor: "The hero arrived.", content: "He paused.", where: "after" },
      doc,
    );
    const [edit] = resolveEdits([resolved], doc);
    expect(edit.matchType).toBe("exact");
    expect(edit.confidence).toBe(1);
    // Simulate the splice the document applicator performs.
    const post =
      doc.slice(0, edit.matchOffset) +
      resolved.replaceText +
      doc.slice(edit.matchOffset + edit.matchLength);
    expect(post).toBe("# Chapter\n\nThe hero arrived.\n\nHe paused.\n");
  });
});

// ---------------------------------------------------------------------------
// executeEditTool (in-loop validate path)
// ---------------------------------------------------------------------------

describe("executeEditTool for insert_into_note", () => {
  test("acknowledges an append without checking for an anchor", async () => {
    const app = mockApp("Day 1.\n");
    const result = await executeEditTool(
      { id: "t", name: "insert_into_note", arguments: { path: CTX_PATH, content: "Day 2.", where: "append" } },
      { app, filePath: CTX_PATH },
    );
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("Insertion proposed");
  });

  test("reports no-match when a before/after anchor is absent", async () => {
    const app = mockApp("# Chapter\n\nHe drew the blade.\n");
    const result = await executeEditTool(
      { id: "t", name: "insert_into_note", arguments: { path: CTX_PATH, anchor: "Missing line", content: "x", where: "after" } },
      { app, filePath: CTX_PATH },
    );
    expect(result.isError).toBe(true);
    expect(result.failure?.kind).toBe("no-match");
  });

  test("names the vault boundary for an out-of-vault path", async () => {
    const getFileByPath = vi.fn();
    const app = {
      vault: { getFileByPath, read: vi.fn() },
      workspace: { getActiveFile: vi.fn() },
    } as unknown as import("obsidian").App;

    const result = await executeEditTool(
      { id: "t", name: "insert_into_note", arguments: { path: "../../escape.md", content: "x", where: "append" } },
      { app, filePath: CTX_PATH },
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("outside the vault");
    expect(result.isReadOnly).toBe(false);
    expect(getFileByPath).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Disposition wording
// ---------------------------------------------------------------------------

describe("editDispositionMessage for the insert kind", () => {
  test("an applied insertion names insert_into_note / insertion", () => {
    const msg = editDispositionMessage("insert", "Notes/J.md", "applied");
    expect(msg).toContain("insertion");
    expect(msg).toContain("Notes/J.md");
  });

  test("a failed insertion is prefixed Error: and names insert_into_note", () => {
    const msg = editDispositionMessage("insert", "Notes/J.md", "failed", "the anchor was not found");
    expect(msg.startsWith("Error:")).toBe(true);
    expect(msg).toContain("insert_into_note");
  });
});
