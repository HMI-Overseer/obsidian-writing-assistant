import { describe, test, expect, vi } from "vitest";
import {
  executeReadOnlyTool,
  resolveStructuralEditBlocks,
} from "../../../src/tools/editing/handlers";
import type { ToolCall } from "../../../src/tools/types";
import type { EditBlock } from "../../../src/editing/editTypes";

// ---------------------------------------------------------------------------
// Helpers to build mock App objects
// ---------------------------------------------------------------------------

function mockApp(options: {
  fileContent?: string;
  headings?: Array<{ heading: string; level: number; line: number }>;
  hasFrontmatter?: boolean;
  frontmatterLines?: [number, number]; // [startLine, endLine]
}) {
  const content = options.fileContent ?? "";
  const headings = (options.headings ?? []).map((h) => ({
    heading: h.heading,
    level: h.level,
    position: { start: { line: h.line, col: 0, offset: 0 }, end: { line: h.line, col: 0, offset: 0 } },
  }));

  const cache: Record<string, unknown> = { headings };

  if (options.hasFrontmatter && options.frontmatterLines) {
    cache.frontmatter = {};
    cache.frontmatterPosition = {
      start: { line: options.frontmatterLines[0], col: 0, offset: 0 },
      end: { line: options.frontmatterLines[1], col: 0, offset: 0 },
    };
  }

  const file = { name: "test.md", path: "folder/test.md" };

  return {
    vault: {
      getFileByPath: vi.fn().mockReturnValue(file),
      read: vi.fn().mockResolvedValue(content),
    },
    metadataCache: {
      getFileCache: vi.fn().mockReturnValue(cache),
    },
  } as unknown as import("obsidian").App;
}

const CTX_PATH = "folder/test.md";

// ---------------------------------------------------------------------------
// executeReadOnlyTool
// ---------------------------------------------------------------------------

describe("executeReadOnlyTool", () => {
  test("returns isReadOnly: false for write tools", async () => {
    const app = mockApp({});
    const tc: ToolCall = { id: "1", name: "apply_edit", arguments: { search: "a", replace: "b" } };
    const result = await executeReadOnlyTool(tc, { app, filePath: CTX_PATH });
    expect(result.isReadOnly).toBe(false);
  });

  test("returns error when file not found", async () => {
    const app = mockApp({});
    (app.vault.getFileByPath as ReturnType<typeof vi.fn>).mockReturnValue(null);

    const tc: ToolCall = { id: "1", name: "get_document_outline", arguments: {} };
    const result = await executeReadOnlyTool(tc, { app, filePath: "missing.md" });
    expect(result.isReadOnly).toBe(true);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("file not found");
  });

  describe("get_document_outline", () => {
    test("returns outline with headings", async () => {
      const app = mockApp({
        fileContent: "# Title\n\nSome text\n\n## Section 1\n\nContent\n\n## Section 2\n\nMore",
        headings: [
          { heading: "Title", level: 1, line: 0 },
          { heading: "Section 1", level: 2, line: 4 },
          { heading: "Section 2", level: 2, line: 8 },
        ],
      });

      const tc: ToolCall = { id: "1", name: "get_document_outline", arguments: {} };
      const result = await executeReadOnlyTool(tc, { app, filePath: CTX_PATH });

      expect(result.isReadOnly).toBe(true);
      expect(result.isError).toBeUndefined();
      expect(result.content).toContain("test.md");
      expect(result.content).toContain("# Title (line 1)");
      expect(result.content).toContain("## Section 1 (line 5)");
      expect(result.content).toContain("## Section 2 (line 9)");
    });

    test("reports frontmatter presence", async () => {
      const app = mockApp({
        fileContent: "---\ntitle: Test\n---\n# Content",
        headings: [{ heading: "Content", level: 1, line: 3 }],
        hasFrontmatter: true,
        frontmatterLines: [0, 2],
      });

      const tc: ToolCall = { id: "1", name: "get_document_outline", arguments: {} };
      const result = await executeReadOnlyTool(tc, { app, filePath: CTX_PATH });

      expect(result.content).toContain("Frontmatter: yes");
    });

    test("reports no frontmatter", async () => {
      const app = mockApp({
        fileContent: "# Just a heading",
        headings: [{ heading: "Just a heading", level: 1, line: 0 }],
      });

      const tc: ToolCall = { id: "1", name: "get_document_outline", arguments: {} };
      const result = await executeReadOnlyTool(tc, { app, filePath: CTX_PATH });

      expect(result.content).toContain("Frontmatter: none");
    });

    test("reports no headings", async () => {
      const app = mockApp({ fileContent: "Just plain text\nwith no headings" });

      const tc: ToolCall = { id: "1", name: "get_document_outline", arguments: {} };
      const result = await executeReadOnlyTool(tc, { app, filePath: CTX_PATH });

      expect(result.content).toContain("No headings found");
    });
  });

  describe("get_line_range", () => {
    const fileContent = "Line 1\nLine 2\nLine 3\nLine 4\nLine 5";

    test("returns requested line range with numbers", async () => {
      const app = mockApp({ fileContent });
      const tc: ToolCall = {
        id: "1",
        name: "get_line_range",
        arguments: { start_line: 2, end_line: 4 },
      };
      const result = await executeReadOnlyTool(tc, { app, filePath: CTX_PATH });

      expect(result.isReadOnly).toBe(true);
      expect(result.content).toContain("2\tLine 2");
      expect(result.content).toContain("3\tLine 3");
      expect(result.content).toContain("4\tLine 4");
      expect(result.content).not.toContain("1\tLine 1");
      expect(result.content).not.toContain("5\tLine 5");
    });

    test("defaults to end of file when end_line is -1", async () => {
      const app = mockApp({ fileContent });
      const tc: ToolCall = {
        id: "1",
        name: "get_line_range",
        arguments: { start_line: 4, end_line: -1 },
      };
      const result = await executeReadOnlyTool(tc, { app, filePath: CTX_PATH });

      expect(result.content).toContain("4\tLine 4");
      expect(result.content).toContain("5\tLine 5");
    });

    test("defaults to end of file when end_line is omitted", async () => {
      const app = mockApp({ fileContent });
      const tc: ToolCall = {
        id: "1",
        name: "get_line_range",
        arguments: { start_line: 4 },
      };
      const result = await executeReadOnlyTool(tc, { app, filePath: CTX_PATH });

      expect(result.content).toContain("4\tLine 4");
      expect(result.content).toContain("5\tLine 5");
    });

    test("clamps out-of-bounds range", async () => {
      const app = mockApp({ fileContent });
      const tc: ToolCall = {
        id: "1",
        name: "get_line_range",
        arguments: { start_line: 1, end_line: 100 },
      };
      const result = await executeReadOnlyTool(tc, { app, filePath: CTX_PATH });

      const lines = result.content.split("\n");
      expect(lines).toHaveLength(5);
    });

    test("returns error for invalid start_line", async () => {
      const app = mockApp({ fileContent });
      const tc: ToolCall = {
        id: "1",
        name: "get_line_range",
        arguments: { start_line: 0 },
      };
      const result = await executeReadOnlyTool(tc, { app, filePath: CTX_PATH });

      expect(result.isError).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// resolveStructuralEditBlocks
// ---------------------------------------------------------------------------

describe("resolveStructuralEditBlocks", () => {
  test("passes through regular apply_edit blocks unchanged", async () => {
    const app = mockApp({});
    const blocks: EditBlock[] = [
      { id: "1", searchText: "old", replaceText: "new", rawBlock: "[tc:1]" },
    ];

    const resolved = await resolveStructuralEditBlocks(blocks, { app, filePath: CTX_PATH });
    expect(resolved).toEqual(blocks);
  });

  test("resolves replace_section blocks", async () => {
    const content = "# Title\n\nIntro text.\n\n## Section\n\nOld content here.\n\n## Next\n\nAfter.";
    const app = mockApp({
      fileContent: content,
      headings: [
        { heading: "Title", level: 1, line: 0 },
        { heading: "Section", level: 2, line: 4 },
        { heading: "Next", level: 2, line: 8 },
      ],
    });

    const blocks: EditBlock[] = [
      {
        id: "1",
        searchText: "",
        replaceText: "New section content.",
        rawBlock: "[tc:1]",
        toolName: "replace_section",
        toolArgs: { heading: "Section" },
      },
    ];

    const resolved = await resolveStructuralEditBlocks(blocks, { app, filePath: CTX_PATH });

    expect(resolved).toHaveLength(1);
    // searchText should contain the original section content (heading + body)
    expect(resolved[0].searchText).toContain("## Section");
    expect(resolved[0].searchText).toContain("Old content here.");
    // replaceText should preserve heading and add new content
    expect(resolved[0].replaceText).toContain("## Section");
    expect(resolved[0].replaceText).toContain("New section content.");
  });

  test("resolves insert_at_position with line_number", async () => {
    const content = "Line 1\nLine 2\nLine 3";
    const app = mockApp({ fileContent: content });

    const blocks: EditBlock[] = [
      {
        id: "1",
        searchText: "",
        replaceText: "Inserted text",
        rawBlock: "[tc:1]",
        toolName: "insert_at_position",
        toolArgs: { line_number: 2 },
      },
    ];

    const resolved = await resolveStructuralEditBlocks(blocks, { app, filePath: CTX_PATH });

    expect(resolved).toHaveLength(1);
    // Anchored on line 2, insert after it
    expect(resolved[0].searchText).toBe("Line 2");
    expect(resolved[0].replaceText).toBe("Line 2\nInserted text");
  });

  test("resolves insert_at_position at end of file", async () => {
    const content = "Line 1\nLine 2\nLine 3";
    const app = mockApp({ fileContent: content });

    const blocks: EditBlock[] = [
      {
        id: "1",
        searchText: "",
        replaceText: "Appended text",
        rawBlock: "[tc:1]",
        toolName: "insert_at_position",
        toolArgs: { line_number: -1 },
      },
    ];

    const resolved = await resolveStructuralEditBlocks(blocks, { app, filePath: CTX_PATH });

    expect(resolved[0].searchText).toBe("Line 3");
    expect(resolved[0].replaceText).toBe("Line 3\nAppended text");
  });

  test("resolves insert_at_position at end of file with trailing newlines", async () => {
    const content = "Line 1\nLine 2\nLine 3\n\n";
    const app = mockApp({ fileContent: content });

    const blocks: EditBlock[] = [
      {
        id: "1",
        searchText: "",
        replaceText: "Appended text",
        rawBlock: "[tc:1]",
        toolName: "insert_at_position",
        toolArgs: { line_number: -1 },
      },
    ];

    const resolved = await resolveStructuralEditBlocks(blocks, { app, filePath: CTX_PATH });

    // Should anchor on "Line 3" (last non-empty line), not ""
    expect(resolved[0].searchText).toBe("Line 3");
    expect(resolved[0].replaceText).toContain("Line 3\nAppended text");
  });

  test("resolves insert_at_position at top of file", async () => {
    const content = "Line 1\nLine 2";
    const app = mockApp({ fileContent: content });

    const blocks: EditBlock[] = [
      {
        id: "1",
        searchText: "",
        replaceText: "Prepended text",
        rawBlock: "[tc:1]",
        toolName: "insert_at_position",
        toolArgs: { line_number: 0 },
      },
    ];

    const resolved = await resolveStructuralEditBlocks(blocks, { app, filePath: CTX_PATH });

    expect(resolved[0].searchText).toBe("Line 1");
    expect(resolved[0].replaceText).toBe("Prepended text\nLine 1");
  });

  test("resolves update_frontmatter with existing frontmatter", async () => {
    const content = "---\ntitle: Old Title\ntags: draft\n---\n# Content";
    const app = mockApp({
      fileContent: content,
      headings: [{ heading: "Content", level: 1, line: 4 }],
      hasFrontmatter: true,
      frontmatterLines: [0, 3],
    });

    const blocks: EditBlock[] = [
      {
        id: "1",
        searchText: "",
        replaceText: "",
        rawBlock: "[tc:1]",
        toolName: "update_frontmatter",
        toolArgs: {
          operations: [
            { key: "title", value: "New Title", action: "set" },
            { key: "tags", action: "remove" },
          ],
        },
      },
    ];

    const resolved = await resolveStructuralEditBlocks(blocks, { app, filePath: CTX_PATH });

    expect(resolved).toHaveLength(1);
    // searchText should be the original frontmatter block
    expect(resolved[0].searchText).toContain("---");
    expect(resolved[0].searchText).toContain("title: Old Title");
    // replaceText should have updated frontmatter
    expect(resolved[0].replaceText).toContain("title: New Title");
    expect(resolved[0].replaceText).not.toContain("tags");
  });

  test("preserves complex YAML values in frontmatter when modifying other keys", async () => {
    const content = "---\ntitle: My Title\ntags:\n  - fiction\n  - draft\naliases:\n  - alt-name\nstatus: wip\n---\n# Content";
    const app = mockApp({
      fileContent: content,
      headings: [{ heading: "Content", level: 1, line: 9 }],
      hasFrontmatter: true,
      frontmatterLines: [0, 8],
    });

    const blocks: EditBlock[] = [
      {
        id: "1",
        searchText: "",
        replaceText: "",
        rawBlock: "[tc:1]",
        toolName: "update_frontmatter",
        toolArgs: {
          operations: [
            { key: "status", value: "published", action: "set" },
            { key: "title", action: "remove" },
          ],
        },
      },
    ];

    const resolved = await resolveStructuralEditBlocks(blocks, { app, filePath: CTX_PATH });

    expect(resolved).toHaveLength(1);
    // Complex YAML values (lists) should be preserved
    expect(resolved[0].replaceText).toContain("tags:");
    expect(resolved[0].replaceText).toContain("  - fiction");
    expect(resolved[0].replaceText).toContain("  - draft");
    expect(resolved[0].replaceText).toContain("aliases:");
    expect(resolved[0].replaceText).toContain("  - alt-name");
    // Modified key should be updated
    expect(resolved[0].replaceText).toContain("status: published");
    // Removed key should be gone
    expect(resolved[0].replaceText).not.toContain("title:");
  });

  test("resolves update_frontmatter when no frontmatter exists", async () => {
    const content = "# My Note\n\nSome content.";
    const app = mockApp({
      fileContent: content,
      headings: [{ heading: "My Note", level: 1, line: 0 }],
    });

    const blocks: EditBlock[] = [
      {
        id: "1",
        searchText: "",
        replaceText: "",
        rawBlock: "[tc:1]",
        toolName: "update_frontmatter",
        toolArgs: {
          operations: [
            { key: "title", value: "My Note", action: "set" },
          ],
        },
      },
    ];

    const resolved = await resolveStructuralEditBlocks(blocks, { app, filePath: CTX_PATH });

    expect(resolved).toHaveLength(1);
    // Should anchor on first line and prepend frontmatter
    expect(resolved[0].searchText).toBe("# My Note");
    expect(resolved[0].replaceText).toContain("---");
    expect(resolved[0].replaceText).toContain("title: My Note");
    expect(resolved[0].replaceText).toContain("# My Note");
  });
});
