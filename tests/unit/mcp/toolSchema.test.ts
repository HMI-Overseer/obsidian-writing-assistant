import { describe, it, expect } from "vitest";
import { toMcpToolSchema } from "../../../src/mcp/toolSchema";
import type { CanonicalToolDefinition } from "../../../src/tools/types";

const TOOL: CanonicalToolDefinition = {
  name: "read_file",
  description: "Read a note.",
  parameters: {
    type: "object",
    properties: { path: { type: "string", description: "Vault path" } },
    required: ["path"],
  },
  strategyHint: "ignored",
  errorGuidance: "ignored",
};

describe("toMcpToolSchema", () => {
  it("maps a canonical tool to the MCP inputSchema shape", () => {
    expect(toMcpToolSchema(TOOL)).toEqual({
      name: "read_file",
      description: "Read a note.",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string", description: "Vault path" } },
        required: ["path"],
      },
    });
  });

  it("drops system-prompt-only fields (strategyHint, errorGuidance)", () => {
    const schema = toMcpToolSchema(TOOL) as Record<string, unknown>;
    expect(schema.strategyHint).toBeUndefined();
    expect(schema.errorGuidance).toBeUndefined();
  });
});
