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
import { toolFailure } from "../toolFailure";
import { refuseOutsideVault } from "../pathBoundary";
import { escapesVault, outsideVaultMessage } from "../../vault-ops/pathSafety";
import type { RagContextBlock } from "../../shared/chatRequest";
import { RagRetrievalError } from "../../rag/ragService";
import type { RagService } from "../../rag/ragService";
import { VAULT_TOOL_NAMES, SEMANTIC_SEARCH_UNAVAILABLE_MESSAGE } from "./definition";

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
    case "search_content":
      return executeSearchContent(toolCall.arguments, ctx);
    case "get_backlinks":
      return executeGetBacklinks(toolCall.arguments, ctx);
    case "find_notes_by_tag":
      return executeFindNotesByTag(toolCall.arguments, ctx);
    case "get_frontmatter":
      return executeGetFrontmatter(toolCall.arguments, ctx);
    default:
      return toolFailure({
        kind: "invalid-args",
        what: `unknown vault tool "${toolCall.name}"`,
        recovery: "call one of the advertised vault tools instead",
      });
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
    return toolFailure({ kind: "invalid-args", what: "query is required" });
  }

  // Branch the "can't run" cases on the exact reason, so the model is never told
  // the vault is empty when search merely couldn't run, and never pointed at a
  // recovery it can't perform (e.g. "build the index" for a no-backend user). The
  // curated message already reads as a full recovery contract, so it passes through
  // verbatim as `content`; `failure.kind` makes the unavailability machine-readable.
  const availability = ctx.ragService.availability();
  if (availability !== "ready") {
    return toolFailure({
      kind: "unavailable",
      content: SEMANTIC_SEARCH_UNAVAILABLE_MESSAGE[availability],
      recovery: "use search_content for an exact-string lookup instead",
    });
  }

  let results: RagContextBlock[] | null;
  try {
    results = await ctx.ragService.retrieve(query, ctx.activeFilePath);
  } catch (e) {
    // A live backend that failed at call time — a failure to run, reported as such
    // (isError) rather than laundered into "found nothing".
    if (e instanceof RagRetrievalError) {
      return toolFailure({
        kind: "unavailable",
        content: SEMANTIC_SEARCH_UNAVAILABLE_MESSAGE.unreachable,
        recovery: "use search_content for an exact-string lookup instead",
      });
    }
    throw e;
  }

  if (!results || results.length === 0) {
    // Ran fine, found nothing — a valid empty result, not a failure (no `isError`).
    // Still recovery-shaped per the contract's wording rule.
    return {
      content:
        `No results found for query: "${query}". ` +
        "Retry once with a more specific query, or use search_content for an exact-string lookup.",
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
    return toolFailure({ kind: "invalid-args", what: "path is required" });
  }

  // Name the vault boundary before the index lookup, so an out-of-vault path is
  // reported as such instead of a dead-end "not found" (the lookup below stays as
  // the security backstop — it can only ever resolve an in-vault file).
  const outside = refuseOutsideVault(rawPath);
  if (outside) return outside;

  const path = normalizePath(rawPath);
  const file = ctx.app.vault.getFileByPath(path);
  if (!file) {
    return toolFailure({
      kind: "not-found",
      what: `no note found at path "${path}"`,
      recovery: "call list_directory or search_files to find the correct path",
    });
  }

  const content = await ctx.app.vault.read(file);

  return { content: `[${path}]\n\n${content}`, isReadOnly: true };
}

async function executeListDirectory(
  args: Record<string, unknown>,
  ctx: VaultToolContext,
): Promise<ToolResult> {
  const rawPath = typeof args.path === "string" ? args.path.trim() : "";

  // An out-of-vault folder path is named at the boundary; an omitted path still
  // lists the vault root.
  if (rawPath) {
    const outside = refuseOutsideVault(rawPath);
    if (outside) return outside;
  }

  const folder = rawPath
    ? ctx.app.vault.getAbstractFileByPath(normalizePath(rawPath))
    : ctx.app.vault.getRoot();

  if (!folder || !(folder instanceof TFolder)) {
    return toolFailure({
      kind: "not-found",
      what: `folder not found at path "${rawPath || "/"}"`,
      recovery: "list a parent folder, or omit path to list the vault root",
    });
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

  // Boundary first; an omitted path still walks the whole vault tree.
  if (rawPath) {
    const outside = refuseOutsideVault(rawPath);
    if (outside) return outside;
  }

  const folder = rawPath
    ? ctx.app.vault.getAbstractFileByPath(normalizePath(rawPath))
    : ctx.app.vault.getRoot();

  if (!folder || !(folder instanceof TFolder)) {
    return toolFailure({
      kind: "not-found",
      what: `folder not found at path "${rawPath || "/"}"`,
      recovery: "list a parent folder, or omit path for the whole vault tree",
    });
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
    return toolFailure({ kind: "invalid-args", what: "pattern is required" });
  }

  const rawPath = typeof args.path === "string" ? args.path.trim() : "";
  // A scope path that escapes the vault is named at the boundary, not laundered
  // into a silent "no matches".
  if (rawPath) {
    const outside = refuseOutsideVault(rawPath);
    if (outside) return outside;
  }
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
      content:
        `No notes found matching pattern "${rawPattern}" ${scope}. ` +
        "Loosen the glob (e.g. *term*), drop the path scope, or use search_content to match on body text.",
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

/** Cap matches shown by search_content so a broad pattern can't flood context. */
const MAX_CONTENT_HITS = 50;
/** Window (chars) kept around a match when the matching line is long. */
const SNIPPET_WINDOW = 120;
/** Upper bound on the contextLines argument, so one hit can't pull in a whole note. */
const MAX_CONTEXT_LINES = 5;

async function executeSearchContent(
  args: Record<string, unknown>,
  ctx: VaultToolContext,
): Promise<ToolResult> {
  const query = typeof args.query === "string" ? args.query.trim() : "";
  if (!query) {
    return toolFailure({ kind: "invalid-args", what: "query is required" });
  }

  const useRegex = args.regex === true;
  const caseSensitive = args.caseSensitive === true;
  const contextLines =
    typeof args.contextLines === "number" && Number.isFinite(args.contextLines)
      ? Math.min(MAX_CONTEXT_LINES, Math.max(0, Math.floor(args.contextLines)))
      : 0;
  const rawPath = typeof args.path === "string" ? args.path.trim() : "";
  // A scope path that escapes the vault is named at the boundary, not laundered
  // into a silent "no matches".
  if (rawPath) {
    const outside = refuseOutsideVault(rawPath);
    if (outside) return outside;
  }
  const scopePath = rawPath ? normalizePath(rawPath) : "";
  const excludePatterns = Array.isArray(args.excludePatterns)
    ? (args.excludePatterns as unknown[]).filter((p): p is string => typeof p === "string")
    : [];
  const excludeRegexes = excludePatterns.map(globToRegex);

  // Build the per-line matcher. Regex is opt-in and validated up front so a
  // malformed pattern is a correctable error, not a thrown scan. No `g` flag,
  // so each exec() searches the line from the start — first match per line.
  let matcher: (line: string) => number;
  if (useRegex) {
    let rx: RegExp;
    try {
      rx = new RegExp(query, caseSensitive ? "" : "i");
    } catch (e) {
      const reason = e instanceof Error ? e.message : "invalid pattern";
      return toolFailure({
        kind: "invalid-args",
        what: `invalid regex "${query}": ${reason}`,
        recovery: "fix the pattern, or set regex to false for a literal substring search",
      });
    }
    matcher = (line) => {
      const m = rx.exec(line);
      return m ? m.index : -1;
    };
  } else {
    const needle = caseSensitive ? query : query.toLowerCase();
    matcher = (line) => (caseSensitive ? line : line.toLowerCase()).indexOf(needle);
  }

  // Collect snippets up to the display cap, but keep counting *every* match so
  // the model gets an honest "showing N of M" when the result set overflows —
  // the signal it needs to decide whether to narrow or just read what it got.
  const blocks: string[] = [];
  let totalMatches = 0;
  let shownMatches = 0;

  for (const file of ctx.app.vault.getMarkdownFiles()) {
    if (scopePath && !file.path.startsWith(scopePath + "/") && file.path !== scopePath) {
      continue;
    }
    if (excludeRegexes.some((rx) => rx.test(file.name) || rx.test(file.path))) continue;

    // cachedRead keeps the scan off the user's edit hot path.
    const content = await ctx.app.vault.cachedRead(file);
    const lines = content.split("\n");

    const fileMatches: { line: number; col: number }[] = [];
    for (let i = 0; i < lines.length; i++) {
      const idx = matcher(lines[i]);
      if (idx < 0) continue;
      totalMatches++;
      if (shownMatches < MAX_CONTENT_HITS) {
        fileMatches.push({ line: i, col: idx });
        shownMatches++;
      }
    }

    if (fileMatches.length > 0) {
      blocks.push(renderFileMatches(file.path, lines, fileMatches, contextLines));
    }
  }

  if (totalMatches === 0) {
    const scope = rawPath ? ` in "${rawPath}"` : "";
    return {
      content:
        `No matches found for ${useRegex ? "pattern" : "text"} "${query}"${scope}. ` +
        "Try a shorter or differently-spelled term, drop the path scope, or use semantic_search for a meaning-based lookup.",
      isReadOnly: true,
    };
  }

  const truncated = totalMatches > shownMatches;
  const kind = useRegex ? "pattern" : "text";
  const header = truncated
    ? `Matches for ${kind} "${query}" — showing first ${shownMatches} of ${totalMatches}:`
    : `Matches for ${kind} "${query}" (${totalMatches}):`;
  const footer = truncated
    ? `\n\n[Showing ${shownMatches} of ${totalMatches} matches — narrow the query or scope with path to see the rest.]`
    : "";
  const joiner = contextLines > 0 ? "\n\n" : "\n";
  return { content: `${header}\n${blocks.join(joiner)}${footer}`, isReadOnly: true };
}

/**
 * Render one file's matches. With no context, each match is a single
 * `path:line: snippet` line (grep default). With contextLines > 0, surrounding
 * lines are shown — and overlapping windows are merged into one hunk per file,
 * so a model gets the sentence before/after without a follow-up read_file and
 * shared context is never printed twice.
 */
function renderFileMatches(
  path: string,
  lines: string[],
  matches: { line: number; col: number }[],
  contextLines: number,
): string {
  if (contextLines === 0) {
    return matches
      .map((m) => `${path}:${m.line + 1}: ${makeSnippet(lines[m.line], m.col)}`)
      .join("\n");
  }

  const colByLine = new Map(matches.map((m) => [m.line, m.col]));
  const ranges = mergeContextRanges(matches.map((m) => m.line), lines.length, contextLines);

  const hunks = ranges.map(([start, end]) => {
    const rendered: string[] = [];
    for (let i = start; i <= end; i++) {
      const col = colByLine.get(i);
      const isMatch = col !== undefined;
      const text = isMatch ? makeSnippet(lines[i], col) : clipLine(lines[i]);
      rendered.push(`${isMatch ? ">" : " "} ${i + 1}: ${text}`);
    }
    return rendered.join("\n");
  });

  return `[${path}]\n${hunks.join("\n  --\n")}`;
}

/**
 * Expand each match into a [start, end] line window and merge overlapping or
 * adjacent windows, so shared context is never printed twice.
 */
function mergeContextRanges(
  matchLines: number[],
  totalLines: number,
  context: number,
): [number, number][] {
  const sorted = [...matchLines].sort((a, b) => a - b);
  const ranges: [number, number][] = [];
  for (const ln of sorted) {
    const start = Math.max(0, ln - context);
    const end = Math.min(totalLines - 1, ln + context);
    const last = ranges[ranges.length - 1];
    if (last && start <= last[1] + 1) {
      last[1] = Math.max(last[1], end);
    } else {
      ranges.push([start, end]);
    }
  }
  return ranges;
}

/**
 * Trim a matching line to a readable snippet, windowing around the match when
 * the line is long so a hit never dumps a whole paragraph into context.
 */
function makeSnippet(line: string, matchIndex: number): string {
  const trimmed = line.trim();
  if (trimmed.length <= SNIPPET_WINDOW * 2) return trimmed;

  // Re-locate the match within the trimmed line to window around it.
  const leadingWs = line.length - line.trimStart().length;
  const idxInTrimmed = Math.max(0, matchIndex - leadingWs);
  const start = Math.max(0, idxInTrimmed - SNIPPET_WINDOW);
  const end = Math.min(trimmed.length, idxInTrimmed + SNIPPET_WINDOW);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < trimmed.length ? "…" : "";
  return `${prefix}${trimmed.slice(start, end)}${suffix}`;
}

/** Trim a context line and cap its length so a long paragraph stays bounded. */
function clipLine(line: string): string {
  const trimmed = line.trim();
  const max = SNIPPET_WINDOW * 2;
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max)}…`;
}

async function executeGetBacklinks(
  args: Record<string, unknown>,
  ctx: VaultToolContext,
): Promise<ToolResult> {
  const rawPath = typeof args.path === "string" ? args.path.trim() : "";
  if (!rawPath) {
    return toolFailure({ kind: "invalid-args", what: "path is required" });
  }

  const outside = refuseOutsideVault(rawPath);
  if (outside) return outside;

  const path = normalizePath(rawPath);
  const file = ctx.app.vault.getFileByPath(path);
  if (!file) {
    return toolFailure({
      kind: "not-found",
      what: `no note found at path "${path}"`,
      recovery: "call list_directory or search_files to find the correct path",
    });
  }

  const backlinks = (ctx.app.metadataCache as ExtendedMetadataCache).getBacklinksForFile(file);
  const paths = Object.keys(backlinks.data).sort();

  if (paths.length === 0) {
    return {
      content: `No notes link to "${path}". This note has no incoming wikilinks; nothing to follow up.`,
      isReadOnly: true,
    };
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
    return toolFailure({ kind: "invalid-args", what: "tag is required" });
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
    const hint =
      similar.length > 0
        ? `\nSimilar tags in vault: ${similar.join(", ")} — try one of those.`
        : " No similar tags exist; call list_directory to discover which tags the vault uses.";
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
    return toolFailure({
      kind: "invalid-args",
      what: "a non-empty paths array is required",
      recovery: "pass one or more vault-relative note paths",
    });
  }

  const results: Record<string, unknown> = {};
  for (const rawPath of paths) {
    if (typeof rawPath !== "string") continue;
    const trimmed = rawPath.trim();
    const p = normalizePath(trimmed);
    // Per-entry boundary message (consistent with this tool's other per-path
    // errors), so an out-of-vault path names the boundary instead of "not found".
    if (escapesVault(trimmed)) {
      results[p] = { error: outsideVaultMessage(trimmed) };
      continue;
    }
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
