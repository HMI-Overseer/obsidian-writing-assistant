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
    case "read_file":
      return executeReadFile(toolCall.arguments, ctx);
    case "list_directory":
      return executeListDirectory(toolCall.arguments, ctx);
    case "directory_tree":
      return executeDirectoryTree(toolCall.arguments, ctx);
    case "search_files":
      return executeSearchFiles(toolCall.arguments, ctx);
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

async function executeReadFile(
  args: Record<string, unknown>,
  ctx: VaultToolContext,
): Promise<ToolResult> {
  const rawPath = typeof args.path === "string" ? args.path.trim() : "";
  if (!rawPath) {
    return { content: "Error: path is required.", isReadOnly: true, isError: true };
  }

  const path = normalizePath(rawPath);
  const file = ctx.app.vault.getFileByPath(path);
  if (!file) {
    return {
      content: `Error: no note found at path "${path}".`,
      isReadOnly: true,
      isError: true,
    };
  }

  const content = await ctx.app.vault.read(file);

  return { content: `[${path}]\n\n${content}`, isReadOnly: true };
}

async function executeListDirectory(
  args: Record<string, unknown>,
  ctx: VaultToolContext,
): Promise<ToolResult> {
  const rawPath = typeof args.path === "string" ? args.path.trim() : "";

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
  for (const child of folder.children) {
    if (child instanceof TFolder) {
      items.push(`[DIR] ${child.path}`);
    } else if (child instanceof TFile && child.extension === "md") {
      items.push(`[FILE] ${child.path}`);
    }
  }
  items.sort();

  const header = rawPath ? `Contents of "${rawPath}"` : "Vault root";
  if (items.length === 0) {
    return { content: `${header}: (empty)`, isReadOnly: true };
  }
  return { content: `${header}:\n${items.join("\n")}`, isReadOnly: true };
}

async function executeDirectoryTree(
  args: Record<string, unknown>,
  ctx: VaultToolContext,
): Promise<ToolResult> {
  const rawPath = typeof args.path === "string" ? args.path.trim() : "";

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

  const tree = buildDirectoryTree(folder);
  return { content: JSON.stringify(tree, null, 2), isReadOnly: true };
}

interface TreeNode {
  name: string;
  path: string;
  type: "file" | "directory";
  children?: TreeNode[];
}

function buildDirectoryTree(folder: TFolder): TreeNode {
  const children: TreeNode[] = [];

  for (const child of folder.children) {
    if (child instanceof TFolder) {
      children.push(buildDirectoryTree(child));
    } else if (child instanceof TFile && child.extension === "md") {
      children.push({ name: child.name, path: child.path, type: "file" });
    }
  }

  children.sort((a, b) => {
    if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  return {
    name: folder.name || "/",
    path: folder.path || "/",
    type: "directory",
    children,
  };
}

async function executeSearchFiles(
  args: Record<string, unknown>,
  ctx: VaultToolContext,
): Promise<ToolResult> {
  const rawPattern = typeof args.pattern === "string" ? args.pattern.trim() : "";
  if (!rawPattern) {
    return { content: "Error: pattern is required.", isReadOnly: true, isError: true };
  }

  const rawPath = typeof args.path === "string" ? args.path.trim() : "";
  const scopePath = rawPath ? normalizePath(rawPath) : "";
  const excludePatterns = Array.isArray(args.excludePatterns)
    ? (args.excludePatterns as unknown[]).filter((p): p is string => typeof p === "string")
    : [];

  const patternRegex = globToRegex(rawPattern);
  const excludeRegexes = excludePatterns.map(globToRegex);

  const matches: string[] = [];
  for (const file of ctx.app.vault.getMarkdownFiles()) {
    if (scopePath && !file.path.startsWith(scopePath + "/") && file.path !== scopePath) {
      continue;
    }
    if (!patternRegex.test(file.name)) continue;
    if (excludeRegexes.some((rx) => rx.test(file.name) || rx.test(file.path))) continue;
    matches.push(file.path);
  }

  matches.sort();

  if (matches.length === 0) {
    const scope = rawPath ? `in "${rawPath}"` : "in vault";
    return {
      content: `No notes found matching pattern "${rawPattern}" ${scope}.`,
      isReadOnly: true,
    };
  }

  const scope = rawPath ? `in "${rawPath}"` : "in vault";
  return {
    content: `Notes matching "${rawPattern}" ${scope} (${matches.length}):\n${matches.join("\n")}`,
    isReadOnly: true,
  };
}

function globToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const regexStr = escaped.replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${regexStr}$`, "i");
}

async function executeGetBacklinks(
  args: Record<string, unknown>,
  ctx: VaultToolContext,
): Promise<ToolResult> {
  const rawPath = typeof args.path === "string" ? args.path.trim() : "";
  if (!rawPath) {
    return { content: "Error: path is required.", isReadOnly: true, isError: true };
  }

  const path = normalizePath(rawPath);
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
    const p = normalizePath(rawPath.trim());
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
