import { describe, test, expect } from "vitest";
import { formatAnthropicTools } from "../../../src/tools/formatters/anthropic";
import { formatOpenAITools } from "../../../src/tools/formatters/openai";
import type { CanonicalToolDefinition } from "../../../src/tools/types";

const SAMPLE_TOOL: CanonicalToolDefinition = {
  name: "propose_edit",
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
    expect(result[0].name).toBe("propose_edit");
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
    expect(result[0].name).toBe("propose_edit");
    expect(result[1].name).toBe("other");
  });
});

describe("formatOpenAITools", () => {
  test("converts canonical tool to OpenAI format", () => {
    const result = formatOpenAITools([SAMPLE_TOOL]);

    expect(result).toHaveLength(1);
    expect(result[0].type).toBe("function");
    expect(result[0].function.name).toBe("propose_edit");
    expect(result[0].function.description).toBe("Propose an edit.");
    expect(result[0].function.parameters).toEqual(SAMPLE_TOOL.parameters);
  });

  test("handles empty array", () => {
    expect(formatOpenAITools([])).toEqual([]);
  });
});
