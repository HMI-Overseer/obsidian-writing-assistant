import type { CanonicalToolDefinition } from "../types";
import type { ToolSearchConfig } from "../../shared/chatRequest";

export interface AnthropicTool {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, unknown>;
    required: string[];
  };
  /**
   * Layer 2 (ADR-0009 / prompt-cache design §6.2). When true, the tool is excluded from
   * the cached system-prompt prefix; its schema is appended inline (as a `tool_reference`
   * block) only once the model discovers it via tool search. Deferring the long tail keeps
   * the cached prefix small without ever voiding it.
   */
  defer_loading?: boolean;
}

/**
 * The native tool-search entry. It rides in `tools` NON-deferred: the API returns a 400
 * ("All tools have defer_loading set…") if the search tool itself defers or if every tool
 * defers, so the search entry plus the non-deferred core are what keep a request valid.
 * The wire IDs live here as the single swappable constant ({@link TOOL_SEARCH_REGEX_ENTRY},
 * the regex variant settled in ADR-0009); swap that one constant to change variants.
 */
export interface AnthropicToolSearchEntry {
  type: string;
  name: string;
}

/**
 * The regex tool-search entry, the one place the wire IDs are written
 * (`tool_search_tool_regex_20251119` / `tool_search_tool_regex`). Verified against the
 * claude-api skill (Server Tools) and platform.claude.com.
 */
export const TOOL_SEARCH_REGEX_ENTRY: AnthropicToolSearchEntry = {
  type: "tool_search_tool_regex_20251119",
  name: "tool_search_tool_regex",
};

/** Any entry that may appear in the Anthropic `tools` array: a tool or the search entry. */
export type AnthropicToolEntry = AnthropicTool | AnthropicToolSearchEntry;

function formatAnthropicTool(tool: CanonicalToolDefinition): AnthropicTool {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: {
      type: "object" as const,
      properties: tool.parameters.properties,
      required: tool.parameters.required,
    },
  };
}

export function formatAnthropicTools(tools: CanonicalToolDefinition[]): AnthropicTool[] {
  return tools.map(formatAnthropicTool);
}

/**
 * Layer-2 builder (ADR-0009 / §6.2.5): prepends the non-deferred tool-search entry, then
 * emits each canonical tool with `defer_loading: true` unless its name is in
 * `config.nonDeferredToolNames` (the small always-loaded core, the core reads + `think`,
 * that stays in the cached prefix). The search entry and that core are the only
 * non-deferred entries, which satisfies the "not all tools deferred" wire rule.
 *
 * The `config.variant` is `"regex"` today (the only variant), so the regex entry is used
 * directly; a future BM25 variant would select a different entry here.
 */
export function formatAnthropicToolsWithSearch(
  tools: CanonicalToolDefinition[],
  config: ToolSearchConfig,
): AnthropicToolEntry[] {
  const nonDeferred = new Set(config.nonDeferredToolNames);
  const entries: AnthropicToolEntry[] = tools.map((tool) => {
    const formatted = formatAnthropicTool(tool);
    return nonDeferred.has(tool.name) ? formatted : { ...formatted, defer_loading: true };
  });
  return [TOOL_SEARCH_REGEX_ENTRY, ...entries];
}
