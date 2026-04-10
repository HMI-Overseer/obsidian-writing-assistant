import type { App } from "obsidian";
import type { ToolCall, ToolResult } from "../types";
import type { RagService } from "../../rag/ragService";
import { VAULT_TOOL_NAMES } from "./definition";

export interface VaultToolContext {
  app: App;
  ragService: RagService;
  /** Vault-relative path of the active file, for `search_vault` relevance boosting. */
  activeFilePath?: string;
}

/**
 * Execute a vault read-only tool and return its result.
 * All vault tools are read-only — results are returned to the model for reasoning.
 */
export async function executeVaultTool(
  toolCall: ToolCall,
  ctx: VaultToolContext,
): Promise<ToolResult> {
  if (!VAULT_TOOL_NAMES.has(toolCall.name)) {
    return { content: "", isReadOnly: false };
  }

  switch (toolCall.name) {
    case "search_vault":
      return executeSearchVault(toolCall.arguments, ctx);
    case "read_note":
      return executeReadNote(toolCall.arguments, ctx);
    default:
      return {
        content: `Unknown vault tool: ${toolCall.name}`,
        isReadOnly: true,
        isError: true,
      };
  }
}

// ---------------------------------------------------------------------------
// Implementations
// ---------------------------------------------------------------------------

async function executeSearchVault(
  args: Record<string, unknown>,
  ctx: VaultToolContext,
): Promise<ToolResult> {
  const query = typeof args.query === "string" ? args.query.trim() : "";
  if (!query) {
    return { content: "Error: query is required.", isReadOnly: true, isError: true };
  }

  if (!ctx.ragService.isReady()) {
    return {
      content: "Vault index is not available. The RAG index may not be built yet.",
      isReadOnly: true,
      isError: true,
    };
  }

  const results = await ctx.ragService.retrieve(query, ctx.activeFilePath);
  if (!results || results.length === 0) {
    return {
      content: `No results found for query: "${query}"`,
      isReadOnly: true,
    };
  }

  const parts: string[] = [`Search results for: "${query}"`, ""];
  for (const block of results) {
    const heading = block.headingPath ? ` > ${block.headingPath}` : "";
    parts.push(`[${block.filePath}${heading}] (score: ${block.score.toFixed(3)})`);
    parts.push(block.content);
    parts.push("");
  }

  return { content: parts.join("\n").trimEnd(), isReadOnly: true };
}

async function executeReadNote(
  args: Record<string, unknown>,
  ctx: VaultToolContext,
): Promise<ToolResult> {
  const path = typeof args.path === "string" ? args.path.trim() : "";
  if (!path) {
    return { content: "Error: path is required.", isReadOnly: true, isError: true };
  }

  const file = ctx.app.vault.getFileByPath(path);
  if (!file) {
    return {
      content: `Error: no note found at path "${path}".`,
      isReadOnly: true,
      isError: true,
    };
  }

  const content = await ctx.app.vault.read(file);
  const cache = ctx.app.metadataCache.getFileCache(file);

  const parts: string[] = [`[${path}]`];

  if (cache?.frontmatter) {
    const fm = cache.frontmatter;
    const keys = Object.keys(fm).filter((k) => k !== "position");
    if (keys.length > 0) {
      parts.push(`Frontmatter: ${keys.map((k) => `${k}: ${String(fm[k])}`).join(", ")}`);
    }
  }

  parts.push("");
  parts.push(content);

  return { content: parts.join("\n"), isReadOnly: true };
}
