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
  READ_TOOL,
  GET_LINKS_TOOL,
  LIST_DIRECTORY_TOOL,
  LINK_DIRECTIONS,
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

describe("READ_TOOL / GET_OUTLINE_TOOL", () => {
  test("get_outline requires only a path", () => {
    expect(GET_OUTLINE_TOOL.name).toBe("get_outline");
    expect(GET_OUTLINE_TOOL.parameters.required).toEqual(["path"]);
  });

  // D4: one required locator, and the section read is what an optional headingPath
  // selects. There is no mode, no enum, and nothing to mis-select.
  test("read requires only a path, and headingPath is the optional narrowing", () => {
    expect(READ_TOOL.name).toBe("read");
    expect(READ_TOOL.parameters.required).toEqual(["path"]);
    expect(READ_TOOL.parameters.properties.path).toBeDefined();
    expect(READ_TOOL.parameters.properties.headingPath).toBeDefined();
  });

  test("read_section is retired, and no advertised tool answers to it", () => {
    const names = ALL_VAULT_TOOLS.map((t) => t.name);
    expect(names).not.toContain("read_section");
    expect(names).not.toContain("read_file");
    expect(VAULT_TOOL_NAMES.has("read_section")).toBe(false);
    expect(VAULT_TOOL_NAMES.has("read_file")).toBe(false);
  });

  // The merged text is the union of both predecessors' guidance organised by pathway
  // (RFC-0015's additive rule). The section pathway keeps every piece of its
  // heading-ambiguity guidance; the wrong-sibling clause is the one thing that goes.
  test("read's guidance carries both pathways and names no retired tool", () => {
    const text = [READ_TOOL.description, READ_TOOL.strategyHint, READ_TOOL.errorGuidance]
      .join("\n");
    expect(text).not.toContain("read_file");
    expect(text).not.toContain("read_section");
    // Whole-note pathway.
    expect(READ_TOOL.description).toContain("whole note");
    // Image pathway (RFC-0021 D1). Static and in the description, not the errorGuidance:
    // the guidance rides the system prompt and the Claude Code config fingerprint, where a
    // change cold-rebuilds every live session. Measured load-bearing, not cosmetic: without
    // this sentence Claude Code read the description, concluded `read` was for text notes,
    // and refused to call it on a PNG at all.
    expect(READ_TOOL.description).toContain("image");
    expect(READ_TOOL.description).toContain("png, jpg, jpeg, gif, webp");
    expect(READ_TOOL.description).toContain("not guess what the image shows");
    expect(READ_TOOL.errorGuidance).not.toContain("image");
    // Section pathway, including both halves of the ambiguity guidance.
    expect(READ_TOOL.description).toContain("duplicated");
    expect(READ_TOOL.errorGuidance).toContain("ambiguous");
    expect(READ_TOOL.errorGuidance).toContain("get_outline");
    // The rewritten wrong-sibling clause names the parameter, not a tool.
    expect(READ_TOOL.errorGuidance).toContain("omit headingPath");
  });

  test("both have a strategyHint so the prompt auto-derives", () => {
    expect(GET_OUTLINE_TOOL.strategyHint).toBeTruthy();
    expect(READ_TOOL.strategyHint).toBeTruthy();
  });

  test("get_outline stays out of the local CORE tier until the benchmark decides", () => {
    const core = CORE_VAULT_TOOLS.map((t) => t.name);
    expect(core).not.toContain("get_outline");
    // read travelled the other way: it was already core, and the section pathway
    // arrived with it rather than staying cloud-only.
    expect(core).toContain("read");
  });
});

describe("GET_LINKS_TOOL", () => {
  test("requires only a path, and direction is the optional narrowing (D7)", () => {
    expect(GET_LINKS_TOOL.name).toBe("get_links");
    expect(GET_LINKS_TOOL.parameters.required).toEqual(["path"]);
    expect(GET_LINKS_TOOL.parameters.properties.path).toBeDefined();
    expect(GET_LINKS_TOOL.parameters.properties.direction).toBeDefined();
    expect(GET_LINKS_TOOL.parameters.properties.direction.enum).toEqual(LINK_DIRECTIONS);
  });

  test("has a strategyHint so the prompt auto-derives", () => {
    expect(GET_LINKS_TOOL.strategyHint).toBeTruthy();
  });

  test("is advertised in ALL_VAULT_TOOLS and registered in VAULT_TOOL_NAMES", () => {
    const names = ALL_VAULT_TOOLS.map((t) => t.name);
    expect(names).toContain("get_links");
    expect(VAULT_TOOL_NAMES.has("get_links")).toBe(true);
  });

  test("keeps both predecessors' tiering: cloud-only, not in the local CORE tier", () => {
    const core = CORE_VAULT_TOOLS.map((t) => t.name);
    expect(core).not.toContain("get_links");
  });

  // RFC-0015's additive rule: a merged tool's guidance is the union of its
  // predecessors', organised by pathway, so neither direction loses its own advice.
  test("its description carries both directions' guidance", () => {
    expect(GET_LINKS_TOOL.description).toContain("Incoming links");
    expect(GET_LINKS_TOOL.description).toContain("Outgoing links");
    expect(GET_LINKS_TOOL.description).toContain("Omit direction");
  });
});

describe("LIST_DIRECTORY_TOOL (directory_tree absorbed, D5/D6)", () => {
  test("keeps path optional and adds depth, also optional", () => {
    expect(LIST_DIRECTORY_TOOL.name).toBe("list_directory");
    expect(LIST_DIRECTORY_TOOL.parameters.required).toEqual([]);
    expect(LIST_DIRECTORY_TOOL.parameters.properties.depth).toBeDefined();
  });

  test("its description states the default and names no ceiling", () => {
    const depth = LIST_DIRECTORY_TOOL.parameters.properties.depth.description ?? "";
    expect(depth).toContain("Defaults to 1");
    expect(depth).not.toMatch(/1 to [0-9]/);
  });

  // D5: one output shape at every depth. The retired JSON tree left no trace on the
  // advertised surface, and nothing offers a second encoding to select.
  test("no tool advertises a directory tree or an output-format switch", () => {
    const names = ALL_VAULT_TOOLS.map((t) => t.name);
    expect(names).not.toContain("directory_tree");
    for (const tool of ALL_VAULT_TOOLS) {
      expect(Object.keys(tool.parameters.properties)).not.toContain("format");
    }
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

// The naming rule as a test (ADR-0034). RFC-0015's sharpest self-identified drawback is
// that the one-rule story "lives in a doc rather than in the names, so this will be
// re-raised". These two assertions are that rule at the smallest size that is still
// mechanical: the shape every advertised name has, and the register of names that break
// the surface's word order, which holds exactly one. Sibling of the camelCase parameter
// guard above; the two are deliberately separate assertions.
describe("advertised tool names (ADR-0034)", () => {
  const advertised = cloudStableToolSet(true).map((tool) => tool.name);

  /**
   * `semantic_search` is the surface's only qualifier-first name, settled knowingly by
   * RFC-0015 rather than left as an inconsistency. Written down at length one so the
   * exception is a decision on the record and a second one cannot arrive quietly.
   */
  const QUALIFIER_FIRST_EXCEPTIONS = ["semantic_search"];

  /**
   * The leading words the surface uses today. This is a **tripwire, not a vocabulary**:
   * a genuinely new verb is a legitimate red here (add it, deliberately), and a leading
   * word that is a qualifier rather than a verb is the violation it exists to catch. It
   * has weak discriminating power on its own (18 words for 22 tools), and the value is
   * the conversation the red forces at the moment a tool is named, which is exactly the
   * maintenance cost RFC-0015 opened on.
   */
  const LEADING_VERBS = [
    "add", "ask", "create", "edit", "find", "forget", "get", "insert", "list",
    "move", "read", "recall", "replace", "search", "think", "trash", "update", "write",
  ];

  test("every advertised name is lowercase words joined by single underscores", () => {
    const offenders = advertised.filter((name) => !/^[a-z]+(_[a-z]+)*$/.test(name));
    expect(
      offenders,
      "a tool name is lowercase words joined by single underscores (ADR-0034)",
    ).toEqual([]);
  });

  test("the qualifier-first register holds exactly one advertised name", () => {
    expect(QUALIFIER_FIRST_EXCEPTIONS).toEqual(["semantic_search"]);
    for (const name of QUALIFIER_FIRST_EXCEPTIONS) expect(advertised).toContain(name);
  });

  test("every other advertised name leads with a verb", () => {
    const offenders = advertised
      .filter((name) => !QUALIFIER_FIRST_EXCEPTIONS.includes(name))
      .map((name) => ({ name, word: name.split("_")[0] }))
      .filter(({ word }) => !LEADING_VERBS.includes(word))
      .map(({ name, word }) => `${name} leads with "${word}"`);
    expect(
      offenders,
      "the surface is verb-first (ADR-0034): if the leading word is a new verb, add it to " +
        "LEADING_VERBS deliberately; if it is a qualifier, the name is the second exception " +
        "to a rule whose exception list is semantic_search and nothing else",
    ).toEqual([]);
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
