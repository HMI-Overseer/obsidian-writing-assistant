import type { CanonicalToolDefinition } from "../tools/types";

/** An MCP tool advertised via `tools/list`. */
export interface McpToolSchema {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required: string[];
  };
}

/**
 * Converts a provider-agnostic {@link CanonicalToolDefinition} into the MCP
 * `tools/list` shape. Sibling to `tools/formatters/anthropic.ts`, same source of
 * truth, different wire format, so Claude Code sees the exact same tools the API
 * providers do.
 */
export function toMcpToolSchema(tool: CanonicalToolDefinition): McpToolSchema {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: {
      type: "object",
      properties: tool.parameters.properties,
      required: tool.parameters.required,
    },
  };
}
