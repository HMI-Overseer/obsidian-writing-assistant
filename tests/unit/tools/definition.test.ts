import { describe, test, expect } from "vitest";
import {
  APPLY_EDIT_TOOL,
  GET_DOCUMENT_OUTLINE_TOOL,
  GET_LINE_RANGE_TOOL,
  REPLACE_SECTION_TOOL,
  INSERT_AT_POSITION_TOOL,
  UPDATE_FRONTMATTER_TOOL,
  ALL_EDIT_TOOLS,
  READ_ONLY_TOOL_NAMES,
  toolCallsToEditBlocks,
} from "../../../src/tools/editing/definition";
import type { ToolCall } from "../../../src/tools/types";

describe("APPLY_EDIT_TOOL", () => {
  test("has correct name and required params", () => {
    expect(APPLY_EDIT_TOOL.name).toBe("apply_edit");
    expect(APPLY_EDIT_TOOL.parameters.required).toEqual(["search", "replace"]);
  });

  test("has search, replace, and explanation properties", () => {
    const props = APPLY_EDIT_TOOL.parameters.properties;
    expect(props.search).toBeDefined();
    expect(props.replace).toBeDefined();
    expect(props.explanation).toBeDefined();
  });
});

describe("GET_DOCUMENT_OUTLINE_TOOL", () => {
  test("has correct name and no required params", () => {
    expect(GET_DOCUMENT_OUTLINE_TOOL.name).toBe("get_document_outline");
    expect(GET_DOCUMENT_OUTLINE_TOOL.parameters.required).toEqual([]);
  });
});

describe("GET_LINE_RANGE_TOOL", () => {
  test("has correct name and requires start_line", () => {
    expect(GET_LINE_RANGE_TOOL.name).toBe("get_line_range");
    expect(GET_LINE_RANGE_TOOL.parameters.required).toEqual(["start_line"]);
  });

  test("has start_line and end_line properties", () => {
    const props = GET_LINE_RANGE_TOOL.parameters.properties;
    expect(props.start_line).toBeDefined();
    expect(props.end_line).toBeDefined();
  });
});

describe("REPLACE_SECTION_TOOL", () => {
  test("has correct name and requires heading and new_content", () => {
    expect(REPLACE_SECTION_TOOL.name).toBe("replace_section");
    expect(REPLACE_SECTION_TOOL.parameters.required).toEqual(["heading", "new_content"]);
  });
});

describe("INSERT_AT_POSITION_TOOL", () => {
  test("has correct name and requires text", () => {
    expect(INSERT_AT_POSITION_TOOL.name).toBe("insert_at_position");
    expect(INSERT_AT_POSITION_TOOL.parameters.required).toEqual(["text"]);
  });

  test("has after_heading and line_number as optional locators", () => {
    const props = INSERT_AT_POSITION_TOOL.parameters.properties;
    expect(props.after_heading).toBeDefined();
    expect(props.line_number).toBeDefined();
  });
});

describe("UPDATE_FRONTMATTER_TOOL", () => {
  test("has correct name and requires operations", () => {
    expect(UPDATE_FRONTMATTER_TOOL.name).toBe("update_frontmatter");
    expect(UPDATE_FRONTMATTER_TOOL.parameters.required).toEqual(["operations"]);
  });
});

describe("ALL_EDIT_TOOLS", () => {
  test("contains all 6 tools", () => {
    expect(ALL_EDIT_TOOLS).toHaveLength(6);
    const names = ALL_EDIT_TOOLS.map((t) => t.name);
    expect(names).toContain("get_document_outline");
    expect(names).toContain("get_line_range");
    expect(names).toContain("apply_edit");
    expect(names).toContain("replace_section");
    expect(names).toContain("insert_at_position");
    expect(names).toContain("update_frontmatter");
  });

  test("read-only tools come first", () => {
    expect(ALL_EDIT_TOOLS[0].name).toBe("get_document_outline");
    expect(ALL_EDIT_TOOLS[1].name).toBe("get_line_range");
  });
});

describe("READ_ONLY_TOOL_NAMES", () => {
  test("contains only read-only tools", () => {
    expect(READ_ONLY_TOOL_NAMES.has("get_document_outline")).toBe(true);
    expect(READ_ONLY_TOOL_NAMES.has("get_line_range")).toBe(true);
    expect(READ_ONLY_TOOL_NAMES.has("apply_edit")).toBe(false);
    expect(READ_ONLY_TOOL_NAMES.has("replace_section")).toBe(false);
  });
});

describe("toolCallsToEditBlocks", () => {
  test("converts apply_edit tool calls to EditBlocks", () => {
    const toolCalls: ToolCall[] = [
      {
        id: "tc_1",
        name: "apply_edit",
        arguments: { search: "old text", replace: "new text" },
      },
      {
        id: "tc_2",
        name: "apply_edit",
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

  test("filters out read-only tool calls", () => {
    const toolCalls: ToolCall[] = [
      { id: "tc_1", name: "apply_edit", arguments: { search: "a", replace: "b" } },
      { id: "tc_2", name: "get_document_outline", arguments: {} },
      { id: "tc_3", name: "get_line_range", arguments: { start_line: 1 } },
    ];

    const blocks = toolCallsToEditBlocks(toolCalls);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].id).toBe("tc_1");
  });

  test("converts replace_section tool calls", () => {
    const toolCalls: ToolCall[] = [
      {
        id: "tc_1",
        name: "replace_section",
        arguments: { heading: "Introduction", new_content: "New intro text" },
      },
    ];

    const blocks = toolCallsToEditBlocks(toolCalls);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].id).toBe("tc_1");
    expect(blocks[0].toolName).toBe("replace_section");
    expect(blocks[0].replaceText).toBe("New intro text");
    expect(blocks[0].toolArgs).toEqual({ heading: "Introduction" });
  });

  test("converts insert_at_position tool calls with after_heading", () => {
    const toolCalls: ToolCall[] = [
      {
        id: "tc_1",
        name: "insert_at_position",
        arguments: { after_heading: "Summary", text: "New paragraph" },
      },
    ];

    const blocks = toolCallsToEditBlocks(toolCalls);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].toolName).toBe("insert_at_position");
    expect(blocks[0].replaceText).toBe("New paragraph");
    expect(blocks[0].toolArgs?.after_heading).toBe("Summary");
  });

  test("converts insert_at_position tool calls with line_number", () => {
    const toolCalls: ToolCall[] = [
      {
        id: "tc_1",
        name: "insert_at_position",
        arguments: { line_number: 5, text: "Inserted line" },
      },
    ];

    const blocks = toolCallsToEditBlocks(toolCalls);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].toolArgs?.line_number).toBe(5);
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

  test("handles mixed tool call types", () => {
    const toolCalls: ToolCall[] = [
      { id: "tc_1", name: "get_document_outline", arguments: {} },
      { id: "tc_2", name: "apply_edit", arguments: { search: "a", replace: "b" } },
      { id: "tc_3", name: "replace_section", arguments: { heading: "H", new_content: "C" } },
      { id: "tc_4", name: "get_line_range", arguments: { start_line: 1 } },
    ];

    const blocks = toolCallsToEditBlocks(toolCalls);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].id).toBe("tc_2");
    expect(blocks[1].id).toBe("tc_3");
  });

  test("normalizes literal \\n escape sequences in apply_edit arguments", () => {
    const toolCalls: ToolCall[] = [
      {
        id: "tc_1",
        name: "apply_edit",
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

  test("normalizes literal \\n in insert_at_position text", () => {
    const toolCalls: ToolCall[] = [
      {
        id: "tc_1",
        name: "insert_at_position",
        arguments: {
          line_number: -1,
          text: "---\\n\\nFooter content:\\n- Item 1\\n- Item 2",
        },
      },
    ];

    const blocks = toolCallsToEditBlocks(toolCalls);
    expect(blocks[0].replaceText).toBe("---\n\nFooter content:\n- Item 1\n- Item 2");
  });

  test("normalizes literal \\t and \\\\ escapes", () => {
    const toolCalls: ToolCall[] = [
      {
        id: "tc_1",
        name: "apply_edit",
        arguments: { search: "col1\\tcol2", replace: "col1\\tcol2\\\\end" },
      },
    ];

    const blocks = toolCallsToEditBlocks(toolCalls);
    expect(blocks[0].searchText).toBe("col1\tcol2");
    expect(blocks[0].replaceText).toBe("col1\tcol2\\end");
  });

  test("does not double-normalize actual newlines", () => {
    const toolCalls: ToolCall[] = [
      {
        id: "tc_1",
        name: "apply_edit",
        arguments: { search: "line 1\nline 2", replace: "new\ntext" },
      },
    ];

    const blocks = toolCallsToEditBlocks(toolCalls);
    // Actual newlines should pass through unchanged
    expect(blocks[0].searchText).toBe("line 1\nline 2");
    expect(blocks[0].replaceText).toBe("new\ntext");
  });
});
