import { describe, test, expect, vi } from "vitest";
import {
  resolveStructuralEditBlocks,
} from "../../../src/tools/editing/handlers";
import type { EditBlock } from "../../../src/editing/editTypes";

// ---------------------------------------------------------------------------
// Helpers to build mock App objects
// ---------------------------------------------------------------------------

function mockApp(options: {
  fileContent?: string;
  hasFrontmatter?: boolean;
  frontmatterLines?: [number, number]; // [startLine, endLine]
}) {
  const content = options.fileContent ?? "";

  const cache: Record<string, unknown> = {};

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
// resolveStructuralEditBlocks
// ---------------------------------------------------------------------------

describe("resolveStructuralEditBlocks", () => {
  test("passes through regular propose_edit blocks unchanged", async () => {
    const app = mockApp({});
    const blocks: EditBlock[] = [
      { id: "1", searchText: "old", replaceText: "new", rawBlock: "[tc:1]" },
    ];

    const resolved = await resolveStructuralEditBlocks(blocks, { app, filePath: CTX_PATH });
    expect(resolved).toEqual(blocks);
  });

  test("resolves update_frontmatter with existing frontmatter", async () => {
    const content = "---\ntitle: Old Title\ntags: draft\n---\n# Content";
    const app = mockApp({
      fileContent: content,
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
    const app = mockApp({ fileContent: content });

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
