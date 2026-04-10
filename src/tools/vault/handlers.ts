import type { App, MetadataCache } from "obsidian";
import { TFile, TFolder, normalizePath } from "obsidian";

/**
 * Obsidian exposes these methods at runtime but they are not part of the
 * official published TypeScript definitions.
 */
interface ExtendedMetadataCache extends MetadataCache {
  getBacklinksForFile(file: TFile): { data: Record<string, unknown[]> };
  getTags(): Record<string, number>;
}
import type { ToolCall, ToolResult } from "../types";
import type { RagService } from "../../rag/ragService";
import { VAULT_TOOL_NAMES } from "./definition";

export interface VaultToolContext {
  app: App;
  ragService: RagService;
  /** Vault-relative path of the active file, for `semantic_search` relevance boosting. */
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
    case "semantic_search":
      return executeSearchVault(toolCall.arguments, ctx);
    case "read_note":
      return executeReadNote(toolCall.arguments, ctx);
    case "list_folder":
      return executeListFolder(toolCall.arguments, ctx);
    case "get_backlinks":
      return executeGetBacklinks(toolCall.arguments, ctx);
    case "find_notes_by_tag":
      return executeFindNotesByTag(toolCall.arguments, ctx);
    case "get_frontmatter":
      return executeGetFrontmatter(toolCall.arguments, ctx);
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

  return { content: parts.join("\n").replace(/\s+$/, ""), isReadOnly: true };
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

async function executeListFolder(
  args: Record<string, unknown>,
  ctx: VaultToolContext,
): Promise<ToolResult> {
  const rawPath = typeof args.path === "string" ? args.path.trim() : "";
  const rawDepth = typeof args.depth === "number" ? args.depth : 1;
  const depth = Math.max(1, Math.min(3, Math.round(rawDepth)));

  const folder = rawPath
    ? ctx.app.vault.getAbstractFileByPath(normalizePath(rawPath))
    : ctx.app.vault.getRoot();

  if (!folder || !(folder instanceof TFolder)) {
    return {
      content: `Error: folder not found at path "${rawPath || "/"}".`,
      isReadOnly: true,
      isError: true,
    };
  }

  const items: string[] = [];
  collectFolderItems(folder, 1, depth, items);
  items.sort();

  const header = rawPath ? `Contents of "${rawPath}"` : "Vault root";
  const depthNote = depth > 1 ? ` (depth ${depth})` : "";
  if (items.length === 0) {
    return { content: `${header}${depthNote}: (empty)`, isReadOnly: true };
  }
  return { content: `${header}${depthNote}:\n${items.join("\n")}`, isReadOnly: true };
}

function collectFolderItems(
  folder: TFolder,
  currentDepth: number,
  maxDepth: number,
  items: string[],
): void {
  for (const child of folder.children) {
    if (child instanceof TFolder) {
      items.push(`${child.path}/ [folder]`);
      if (currentDepth < maxDepth) {
        collectFolderItems(child, currentDepth + 1, maxDepth, items);
      }
    } else if (child instanceof TFile && child.extension === "md") {
      items.push(`${child.path} [note]`);
    }
  }
}

async function executeGetBacklinks(
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

  const backlinks = (ctx.app.metadataCache as ExtendedMetadataCache).getBacklinksForFile(file);
  const paths = Object.keys(backlinks.data).sort();

  if (paths.length === 0) {
    return { content: `No notes link to "${path}".`, isReadOnly: true };
  }

  return {
    content: `Notes linking to "${path}" (${paths.length}):\n${paths.join("\n")}`,
    isReadOnly: true,
  };
}

async function executeFindNotesByTag(
  args: Record<string, unknown>,
  ctx: VaultToolContext,
): Promise<ToolResult> {
  const rawTag = typeof args.tag === "string" ? args.tag.trim() : "";
  if (!rawTag) {
    return { content: "Error: tag is required.", isReadOnly: true, isError: true };
  }

  // Normalise to #tag form for comparison.
  const normalizedTag = rawTag.startsWith("#") ? rawTag : `#${rawTag}`;
  const tagLower = normalizedTag.toLowerCase();

  const matching: string[] = [];
  for (const file of ctx.app.vault.getMarkdownFiles()) {
    const cache = ctx.app.metadataCache.getFileCache(file);
    if (!cache) continue;

    // Frontmatter tags array (e.g. tags: [character, location]).
    const fmTags = cache.frontmatter?.tags;
    if (fmTags) {
      const tagList = Array.isArray(fmTags) ? fmTags : [fmTags];
      if (tagList.some((t) => `#${String(t)}`.toLowerCase() === tagLower)) {
        matching.push(file.path);
        continue;
      }
    }

    // Inline tags parsed from note body (e.g. #character).
    if (cache.tags?.some((t) => t.tag.toLowerCase() === tagLower)) {
      matching.push(file.path);
    }
  }

  if (matching.length === 0) {
    // Surface similar tags to help the model correct itself.
    const allTags = (ctx.app.metadataCache as ExtendedMetadataCache).getTags();
    const stem = rawTag.replace(/^#/, "");
    const similar = Object.keys(allTags)
      .filter((t) => t.toLowerCase().includes(stem.toLowerCase()))
      .slice(0, 5);
    const hint = similar.length > 0 ? `\nSimilar tags in vault: ${similar.join(", ")}` : "";
    return {
      content: `No notes found with tag "${normalizedTag}".${hint}`,
      isReadOnly: true,
    };
  }

  matching.sort();
  return {
    content: `Notes tagged "${normalizedTag}" (${matching.length}):\n${matching.join("\n")}`,
    isReadOnly: true,
  };
}

async function executeGetFrontmatter(
  args: Record<string, unknown>,
  ctx: VaultToolContext,
): Promise<ToolResult> {
  const paths = Array.isArray(args.paths) ? args.paths : [];
  if (paths.length === 0) {
    return { content: "Error: paths array is required.", isReadOnly: true, isError: true };
  }

  const results: Record<string, unknown> = {};
  for (const rawPath of paths) {
    if (typeof rawPath !== "string") continue;
    const p = rawPath.trim();
    const file = ctx.app.vault.getFileByPath(p);
    if (!file) {
      results[p] = { error: `No note found at "${p}".` };
      continue;
    }
    const cache = ctx.app.metadataCache.getFileCache(file);
    const fm = { ...(cache?.frontmatter ?? {}) };
    // Remove Obsidian's internal position metadata — not useful to the model.
    delete fm["position"];
    results[p] = fm;
  }

  return { content: JSON.stringify(results, null, 2), isReadOnly: true };
}
