import { describe, test, expect } from "vitest";
import { APPLY_EDIT_TOOL, toolCallsToEditBlocks } from "../../../src/tools/editing/definition";
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

  test("filters out non-apply_edit tool calls", () => {
    const toolCalls: ToolCall[] = [
      { id: "tc_1", name: "apply_edit", arguments: { search: "a", replace: "b" } },
      { id: "tc_2", name: "other_tool", arguments: { foo: "bar" } },
    ];

    const blocks = toolCallsToEditBlocks(toolCalls);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].id).toBe("tc_1");
  });

  test("returns empty array for empty input", () => {
    expect(toolCallsToEditBlocks([])).toEqual([]);
  });

  test("returns empty array when no apply_edit calls", () => {
    const toolCalls: ToolCall[] = [
      { id: "tc_1", name: "other", arguments: {} },
    ];
    expect(toolCallsToEditBlocks(toolCalls)).toEqual([]);
  });
});
