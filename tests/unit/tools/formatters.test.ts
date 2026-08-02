import { describe, test, expect } from "vitest";
import {
  formatAnthropicTools,
  formatAnthropicToolsWithSearch,
  TOOL_SEARCH_REGEX_ENTRY,
  type AnthropicTool,
} from "../../../src/tools/formatters/anthropic";
import { formatOpenAITools } from "../../../src/tools/formatters/openai";
import type { CanonicalToolDefinition } from "../../../src/tools/types";

const SAMPLE_TOOL: CanonicalToolDefinition = {
  name: "edit",
  description: "Propose an edit.",
  parameters: {
    type: "object",
    properties: {
      search: { type: "string", description: "Text to find." },
      replace: { type: "string", description: "Replacement text." },
    },
    required: ["search", "replace"],
  },
};

describe("formatAnthropicTools", () => {
  test("converts canonical tool to Anthropic format", () => {
    const result = formatAnthropicTools([SAMPLE_TOOL]);

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("edit");
    expect(result[0].description).toBe("Propose an edit.");
    expect(result[0].input_schema.type).toBe("object");
    expect(result[0].input_schema.properties).toEqual(SAMPLE_TOOL.parameters.properties);
    expect(result[0].input_schema.required).toEqual(["search", "replace"]);
  });

  test("handles empty array", () => {
    expect(formatAnthropicTools([])).toEqual([]);
  });

  test("handles multiple tools", () => {
    const tools: CanonicalToolDefinition[] = [
      SAMPLE_TOOL,
      { name: "other", description: "Another tool.", parameters: { type: "object", properties: {}, required: [] } },
    ];
    const result = formatAnthropicTools(tools);
    expect(result).toHaveLength(2);
    expect(result[0].name).toBe("edit");
    expect(result[1].name).toBe("other");
  });

  // Layer 1 (no tool search): the flat formatter must never set defer_loading, or every
  // tool would be excluded from the cached prefix even when caching is off.
  test("never sets defer_loading", () => {
    const result = formatAnthropicTools([SAMPLE_TOOL]);
    expect(result[0]).not.toHaveProperty("defer_loading");
  });
});

describe("formatAnthropicToolsWithSearch (Layer 2 defer split)", () => {
  const READ_TOOL: CanonicalToolDefinition = {
    name: "read_file",
    description: "Read a file.",
    parameters: { type: "object", properties: {}, required: [] },
  };
  const TAIL_TOOL: CanonicalToolDefinition = {
    name: "write_file",
    description: "Write a file.",
    parameters: { type: "object", properties: {}, required: [] },
  };

  function build() {
    return formatAnthropicToolsWithSearch([READ_TOOL, TAIL_TOOL], {
      variant: "regex",
      nonDeferredToolNames: ["read_file"],
    });
  }

  test("prepends the regex tool-search entry, non-deferred", () => {
    const result = build();
    expect(result[0]).toEqual(TOOL_SEARCH_REGEX_ENTRY);
    expect(result[0]).not.toHaveProperty("defer_loading");
    // The wire ids are the regex variant (ADR-0009 settled, the one swappable entry).
    expect(TOOL_SEARCH_REGEX_ENTRY).toEqual({
      type: "tool_search_tool_regex_20251119",
      name: "tool_search_tool_regex",
    });
  });

  test("keeps a non-deferred-listed tool out of the deferred set", () => {
    const read = build().find((t) => t.name === "read_file") as AnthropicTool;
    expect(read).toBeDefined();
    expect(read).not.toHaveProperty("defer_loading");
    // Still a fully formatted tool (schema intact), just non-deferred.
    expect(read.input_schema.type).toBe("object");
  });

  test("marks every tool outside the non-deferred set with defer_loading", () => {
    const write = build().find((t) => t.name === "write_file") as AnthropicTool;
    expect(write.defer_loading).toBe(true);
  });

  test("keeps at least one non-deferred tool so the wire 'all deferred' rule cannot trip", () => {
    // The search entry must not defer, and at least one tool must stay non-deferred, else
    // the API 400s with "All tools have defer_loading set". Here: search entry + read_file.
    const nonDeferred = build().filter((t) => !("defer_loading" in t && t.defer_loading));
    expect(nonDeferred.length).toBeGreaterThanOrEqual(2);
  });
});

describe("formatOpenAITools", () => {
  test("converts canonical tool to OpenAI format", () => {
    const result = formatOpenAITools([SAMPLE_TOOL]);

    expect(result).toHaveLength(1);
    expect(result[0].type).toBe("function");
    expect(result[0].function.name).toBe("edit");
    expect(result[0].function.description).toBe("Propose an edit.");
    expect(result[0].function.parameters).toEqual(SAMPLE_TOOL.parameters);
  });

  test("handles empty array", () => {
    expect(formatOpenAITools([])).toEqual([]);
  });
});
