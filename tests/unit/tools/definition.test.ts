import { describe, test, expect } from "vitest";
import {
  EDIT_TOOL,
  UPDATE_FRONTMATTER_TOOL,
  ALL_EDIT_TOOLS,
} from "../../../src/tools/editing/definition";
import {
  ALL_VAULT_TOOLS,
  CORE_VAULT_TOOLS,
  GET_OUTLINE_TOOL,
  READ_SECTION_TOOL,
  GET_OUTGOING_LINKS_TOOL,
  SEARCH_VAULT_TOOL,
  VAULT_TOOL_NAMES,
  filterSemanticSearchByAvailability,
  SEMANTIC_SEARCH_UNAVAILABLE_MESSAGE,
} from "../../../src/tools/vault/definition";
import { cloudStableToolSet } from "../../../src/tools/toolSurface";
import { toolCallsToEditBlocks } from "../../../src/tools/editing/conversion";
import type { ToolCall } from "../../../src/tools/types";

describe("EDIT_TOOL", () => {
  test("has correct name and required params", () => {
    expect(EDIT_TOOL.name).toBe("edit");
    expect(EDIT_TOOL.parameters.required).toEqual(["path", "search", "replace"]);
  });

  test("has path, search, replace, and explanation properties", () => {
    const props = EDIT_TOOL.parameters.properties;
    expect(props.path).toBeDefined();
    expect(props.search).toBeDefined();
    expect(props.replace).toBeDefined();
    expect(props.explanation).toBeDefined();
  });
});

describe("UPDATE_FRONTMATTER_TOOL", () => {
  test("has correct name and requires path + operations", () => {
    expect(UPDATE_FRONTMATTER_TOOL.name).toBe("update_frontmatter");
    expect(UPDATE_FRONTMATTER_TOOL.parameters.required).toEqual(["path", "operations"]);
    expect(UPDATE_FRONTMATTER_TOOL.parameters.properties.path).toBeDefined();
  });
});

describe("ALL_EDIT_TOOLS", () => {
  test("contains exactly 3 tools", () => {
    expect(ALL_EDIT_TOOLS).toHaveLength(3);
    const names = ALL_EDIT_TOOLS.map((t) => t.name);
    expect(names).toContain("edit");
    expect(names).toContain("update_frontmatter");
    expect(names).toContain("insert_into_note");
  });
});

describe("GET_OUTLINE_TOOL / READ_SECTION_TOOL", () => {
  test("get_outline requires only a path", () => {
    expect(GET_OUTLINE_TOOL.name).toBe("get_outline");
    expect(GET_OUTLINE_TOOL.parameters.required).toEqual(["path"]);
  });

  test("read_section requires path and headingPath", () => {
    expect(READ_SECTION_TOOL.name).toBe("read_section");
    expect(READ_SECTION_TOOL.parameters.required).toEqual(["path", "headingPath"]);
    expect(READ_SECTION_TOOL.parameters.properties.headingPath).toBeDefined();
  });

  test("both pair tools have a strategyHint so the prompt auto-derives", () => {
    expect(GET_OUTLINE_TOOL.strategyHint).toBeTruthy();
    expect(READ_SECTION_TOOL.strategyHint).toBeTruthy();
  });

  test("both are advertised in ALL_VAULT_TOOLS and registered in VAULT_TOOL_NAMES", () => {
    const names = ALL_VAULT_TOOLS.map((t) => t.name);
    expect(names).toContain("get_outline");
    expect(names).toContain("read_section");
    expect(VAULT_TOOL_NAMES.has("get_outline")).toBe(true);
    expect(VAULT_TOOL_NAMES.has("read_section")).toBe(true);
  });

  test("the pair stays out of the local CORE tier until the benchmark decides", () => {
    const core = CORE_VAULT_TOOLS.map((t) => t.name);
    expect(core).not.toContain("get_outline");
    expect(core).not.toContain("read_section");
  });
});

describe("GET_OUTGOING_LINKS_TOOL (M3)", () => {
  test("has correct name and requires only a path", () => {
    expect(GET_OUTGOING_LINKS_TOOL.name).toBe("get_outgoing_links");
    expect(GET_OUTGOING_LINKS_TOOL.parameters.required).toEqual(["path"]);
    expect(GET_OUTGOING_LINKS_TOOL.parameters.properties.path).toBeDefined();
  });

  test("has a strategyHint so the prompt auto-derives", () => {
    expect(GET_OUTGOING_LINKS_TOOL.strategyHint).toBeTruthy();
  });

  test("is advertised in ALL_VAULT_TOOLS and registered in VAULT_TOOL_NAMES", () => {
    const names = ALL_VAULT_TOOLS.map((t) => t.name);
    expect(names).toContain("get_outgoing_links");
    expect(VAULT_TOOL_NAMES.has("get_outgoing_links")).toBe(true);
  });

  test("mirrors get_backlinks' tiering: cloud-only, not in the local CORE tier", () => {
    const core = CORE_VAULT_TOOLS.map((t) => t.name);
    expect(core).not.toContain("get_outgoing_links");
  });
});

describe("SEARCH_VAULT_TOOL", () => {
  test("names the retrieval limit topK, matching every other multi-word parameter", () => {
    const props = SEARCH_VAULT_TOOL.parameters.properties;
    expect(props.topK).toBeDefined();
    expect(props.top_k).toBeUndefined();
  });
});

// Drift guard for the parameter vocabulary RFC-0015 settled. `top_k` was the surface's
// only snake_case parameter, and nothing typechecks a schema key, so the next tool can
// reintroduce one invisibly. Top-level names only, the level the RFC surveyed.
describe("advertised parameter names", () => {
  test("every top-level parameter is camelCase", () => {
    const offenders: string[] = [];
    for (const tool of cloudStableToolSet(true)) {
      for (const name of Object.keys(tool.parameters.properties)) {
        if (!/^[a-z][a-zA-Z0-9]*$/.test(name)) offenders.push(`${tool.name}.${name}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("filterSemanticSearchByAvailability", () => {
  test("keeps semantic_search only when availability is 'ready'", () => {
    const ready = filterSemanticSearchByAvailability(ALL_VAULT_TOOLS, "ready");
    expect(ready.map((t) => t.name)).toContain("semantic_search");
  });

  test.each(["no-backend", "index-empty"] as const)(
    "drops semantic_search when availability is '%s'",
    (availability) => {
      const filtered = filterSemanticSearchByAvailability(ALL_VAULT_TOOLS, availability);
      expect(filtered.map((t) => t.name)).not.toContain("semantic_search");
      // The lexical fallback must survive so the model still has a content search.
      expect(filtered.map((t) => t.name)).toContain("search_content");
    },
  );

  test("does not mutate the input array", () => {
    const before = ALL_VAULT_TOOLS.length;
    filterSemanticSearchByAvailability(ALL_VAULT_TOOLS, "no-backend");
    expect(ALL_VAULT_TOOLS).toHaveLength(before);
    expect(CORE_VAULT_TOOLS.map((t) => t.name)).toContain("semantic_search");
  });
});

describe("SEMANTIC_SEARCH_UNAVAILABLE_MESSAGE", () => {
  test("every reason points the model at the lexical fallback", () => {
    for (const message of Object.values(SEMANTIC_SEARCH_UNAVAILABLE_MESSAGE)) {
      expect(message).toContain("search_content");
    }
  });

  test("no-backend does not prescribe building an index (the impossible recovery)", () => {
    expect(SEMANTIC_SEARCH_UNAVAILABLE_MESSAGE["no-backend"]).not.toContain("Build index");
  });

  test("unreachable explicitly distinguishes a failure to run from an empty result", () => {
    expect(SEMANTIC_SEARCH_UNAVAILABLE_MESSAGE.unreachable).toMatch(/failure to run/i);
  });
});

describe("toolCallsToEditBlocks", () => {
  test("converts edit tool calls to EditBlocks", () => {
    const toolCalls: ToolCall[] = [
      {
        id: "tc_1",
        name: "edit",
        arguments: { search: "old text", replace: "new text" },
      },
      {
        id: "tc_2",
        name: "edit",
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

  test("threads the path argument onto the block's targetPath", () => {
    const toolCalls: ToolCall[] = [
      {
        id: "tc_1",
        name: "edit",
        arguments: { path: "Lore/The Fold.md", search: "a", replace: "b" },
      },
      {
        id: "tc_2",
        name: "update_frontmatter",
        arguments: { path: "Lore/The Fold.md", operations: [{ key: "tags", value: "x", action: "set" }] },
      },
    ];

    const blocks = toolCallsToEditBlocks(toolCalls);
    expect(blocks[0].targetPath).toBe("Lore/The Fold.md");
    expect(blocks[1].targetPath).toBe("Lore/The Fold.md");
  });

  test("normalizes literal \\n escape sequences in edit arguments", () => {
    const toolCalls: ToolCall[] = [
      {
        id: "tc_1",
        name: "edit",
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
        name: "edit",
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
        name: "edit",
        arguments: { search: 123, replace: "new" }, // search is not a string
      },
      {
        id: "tc_2",
        name: "edit",
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
        name: "edit",
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
      { id: "tc_1", name: "edit", arguments: { search: "a", replace: "b" } },
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
    expect(blocks[0].id).toBe("tc_1"); // edit first
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
