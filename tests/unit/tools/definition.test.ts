import { describe, test, expect } from "vitest";
import {
  PROPOSE_EDIT_TOOL,
  UPDATE_FRONTMATTER_TOOL,
  ALL_EDIT_TOOLS,
  toolCallsToEditBlocks,
} from "../../../src/tools/editing/definition";
import type { ToolCall } from "../../../src/tools/types";

describe("PROPOSE_EDIT_TOOL", () => {
  test("has correct name and required params", () => {
    expect(PROPOSE_EDIT_TOOL.name).toBe("propose_edit");
    expect(PROPOSE_EDIT_TOOL.parameters.required).toEqual(["search", "replace"]);
  });

  test("has search, replace, and explanation properties", () => {
    const props = PROPOSE_EDIT_TOOL.parameters.properties;
    expect(props.search).toBeDefined();
    expect(props.replace).toBeDefined();
    expect(props.explanation).toBeDefined();
  });
});

describe("UPDATE_FRONTMATTER_TOOL", () => {
  test("has correct name and requires operations", () => {
    expect(UPDATE_FRONTMATTER_TOOL.name).toBe("update_frontmatter");
    expect(UPDATE_FRONTMATTER_TOOL.parameters.required).toEqual(["operations"]);
  });
});

describe("ALL_EDIT_TOOLS", () => {
  test("contains exactly 2 tools", () => {
    expect(ALL_EDIT_TOOLS).toHaveLength(2);
    const names = ALL_EDIT_TOOLS.map((t) => t.name);
    expect(names).toContain("propose_edit");
    expect(names).toContain("update_frontmatter");
  });
});

describe("toolCallsToEditBlocks", () => {
  test("converts propose_edit tool calls to EditBlocks", () => {
    const toolCalls: ToolCall[] = [
      {
        id: "tc_1",
        name: "propose_edit",
        arguments: { search: "old text", replace: "new text" },
      },
      {
        id: "tc_2",
        name: "propose_edit",
        arguments: { search: "another", replace: "" },
      },
    ];

    const blocks = toolCallsToEditBlocks(toolCalls);

    expect(blocks).toHaveLength(2);
    expect(blocks[0].id).toBe("tc_1");
    expect(blocks[0].searchText).toBe("old text");
    expect(blocks[0].replaceText).toBe("new text");
    expect(blocks[0].rawBlock).toBe("[tool_call:tc_1]");

    expect(blocks[1].id).toBe("tc_2");
    expect(blocks[1].searchText).toBe("another");
    expect(blocks[1].replaceText).toBe("");
  });

  test("converts update_frontmatter tool calls", () => {
    const toolCalls: ToolCall[] = [
      {
        id: "tc_1",
        name: "update_frontmatter",
        arguments: {
          operations: [
            { key: "tags", value: "test", action: "set" },
            { key: "draft", action: "remove" },
          ],
        },
      },
    ];

    const blocks = toolCallsToEditBlocks(toolCalls);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].toolName).toBe("update_frontmatter");
    expect(blocks[0].toolArgs?.operations).toHaveLength(2);
  });

  test("returns empty array for empty input", () => {
    expect(toolCallsToEditBlocks([])).toEqual([]);
  });

  test("normalizes literal \\n escape sequences in propose_edit arguments", () => {
    const toolCalls: ToolCall[] = [
      {
        id: "tc_1",
        name: "propose_edit",
        arguments: {
          search: "line 1\\nline 2",
          replace: "new line 1\\nnew line 2\\n",
        },
      },
    ];

    const blocks = toolCallsToEditBlocks(toolCalls);
    expect(blocks[0].searchText).toBe("line 1\nline 2");
    expect(blocks[0].replaceText).toBe("new line 1\nnew line 2\n");
  });

  test("normalizes literal \\t and \\\\ escapes", () => {
    const toolCalls: ToolCall[] = [
      {
        id: "tc_1",
        name: "propose_edit",
        arguments: { search: "col1\\tcol2", replace: "col1\\tcol2\\\\end" },
      },
    ];

    const blocks = toolCallsToEditBlocks(toolCalls);
    expect(blocks[0].searchText).toBe("col1\tcol2");
    expect(blocks[0].replaceText).toBe("col1\tcol2\\end");
  });

  test("skips tool calls with invalid arguments", () => {
    const toolCalls: ToolCall[] = [
      {
        id: "tc_1",
        name: "propose_edit",
        arguments: { search: 123, replace: "new" }, // search is not a string
      },
      {
        id: "tc_2",
        name: "propose_edit",
        arguments: { search: "valid", replace: "also valid" },
      },
    ];

    const blocks = toolCallsToEditBlocks(toolCalls);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].id).toBe("tc_2");
  });

  test("does not double-normalize actual newlines", () => {
    const toolCalls: ToolCall[] = [
      {
        id: "tc_1",
        name: "propose_edit",
        arguments: { search: "line 1\nline 2", replace: "new\ntext" },
      },
    ];

    const blocks = toolCallsToEditBlocks(toolCalls);
    expect(blocks[0].searchText).toBe("line 1\nline 2");
    expect(blocks[0].replaceText).toBe("new\ntext");
  });

  test("merges multiple update_frontmatter calls into a single EditBlock", () => {
    const toolCalls: ToolCall[] = [
      {
        id: "tc_1",
        name: "update_frontmatter",
        arguments: { operations: [{ key: "aliases", action: "remove" }] },
      },
      {
        id: "tc_2",
        name: "update_frontmatter",
        arguments: { operations: [{ key: "level", action: "remove" }] },
      },
      {
        id: "tc_3",
        name: "update_frontmatter",
        arguments: { operations: [{ key: "karma", action: "remove" }] },
      },
    ];

    const blocks = toolCallsToEditBlocks(toolCalls);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].toolName).toBe("update_frontmatter");
    expect(blocks[0].toolArgs?.operations).toHaveLength(3);
    expect(blocks[0].id).toBe("tc_1"); // Uses first call's ID
  });

  test("deduplicates operations by key (last-write-wins) when merging", () => {
    const toolCalls: ToolCall[] = [
      {
        id: "tc_1",
        name: "update_frontmatter",
        arguments: { operations: [{ key: "status", value: "draft", action: "set" }] },
      },
      {
        id: "tc_2",
        name: "update_frontmatter",
        arguments: { operations: [{ key: "status", value: "published", action: "set" }] },
      },
    ];

    const blocks = toolCallsToEditBlocks(toolCalls);
    expect(blocks).toHaveLength(1);
    const ops = blocks[0].toolArgs?.operations as Array<{ key: string; value?: string; action: string }>;
    expect(ops).toHaveLength(1);
    expect(ops[0].value).toBe("published"); // Last write wins
  });

  test("merges update_frontmatter alongside other tool types", () => {
    const toolCalls: ToolCall[] = [
      { id: "tc_1", name: "propose_edit", arguments: { search: "a", replace: "b" } },
      {
        id: "tc_2",
        name: "update_frontmatter",
        arguments: { operations: [{ key: "tags", value: "test", action: "set" }] },
      },
      {
        id: "tc_3",
        name: "update_frontmatter",
        arguments: { operations: [{ key: "draft", action: "remove" }] },
      },
    ];

    const blocks = toolCallsToEditBlocks(toolCalls);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].id).toBe("tc_1"); // propose_edit first
    expect(blocks[1].toolName).toBe("update_frontmatter"); // merged FM block last
    expect(blocks[1].toolArgs?.operations).toHaveLength(2);
  });

  test("merges flat update_frontmatter calls (auto-wrapped by validator)", () => {
    const toolCalls: ToolCall[] = [
      {
        id: "tc_1",
        name: "update_frontmatter",
        arguments: { key: "status", value: "published", action: "set" },
      },
      {
        id: "tc_2",
        name: "update_frontmatter",
        arguments: { key: "draft", action: "remove" },
      },
    ];

    const blocks = toolCallsToEditBlocks(toolCalls);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].toolArgs?.operations).toHaveLength(2);
  });
});
