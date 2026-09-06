import type { App } from "obsidian";
import { TFile, TFolder, normalizePath } from "obsidian";
import type { ToolCall, ToolResult } from "../types";
import { toolFailure } from "../toolFailure";
import { refuseOutsideVault } from "../pathBoundary";
import { escapesVault, outsideVaultMessage } from "../../vault-ops/pathSafety";
import { backlinkSources } from "../../vault-ops/metadata";
import type { ExtendedMetadataCache } from "../../vault-ops/metadata";
import type { RagContextBlock } from "../../shared/chatRequest";
import { RagRetrievalError } from "../../rag/ragService";
import type { RagService } from "../../rag/ragService";
import {
  VAULT_TOOL_NAMES,
  SEMANTIC_SEARCH_UNAVAILABLE_MESSAGE,
} from "./definition";
import { formatWithLineNumbers } from "./readFormat";
import { buildOutline, sectionLines, matchSection, countWords } from "./outline";
import { readImageDimensions } from "./imageHeader";
import {
  MAX_NOTE_CONTEXT_IMAGE_SIZE_BYTES,
  SUPPORTED_IMAGE_MIME_BY_EXTENSION,
} from "../../constants";
import { arrayBufferToBase64, formatByteCount } from "../../utils";
import type { ImageMimeType } from "../../shared/types";

/**
 * Whether an image `read` can put the picture in front of the model, and when it
 * cannot, which of the two reasons applies (RFC-0021 D3, P1). Three-valued so the
 * handler names the right refusal without knowing the provider: the model has no
 * image input, or this runtime's wire shape carries no image at all.
 */
export type ImageDelivery = "inline" | "model-cannot-see" | "transport-cannot-carry";

export interface VaultToolContext {
  app: App;
  ragService: RagService;
  /** Vault-relative path of the active file, for `semantic_search` relevance boosting. */
  activeFilePath?: string;
  /**
   * Required, not optional: an omitted flag would silently default one of the two
   * construction sites and drop images on a path that could carry them, so `tsc`
   * names every site instead (RFC-0021 P1).
   */
  imageDelivery: ImageDelivery;
}

/**
 * Execute a vault read-only tool and return its result.
 * All vault tools are read-only, results are returned to the model for reasoning.
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
    case "read":
      return executeRead(toolCall.arguments, ctx);
    case "get_outline":
      return executeGetOutline(toolCall.arguments, ctx);
    case "list_directory":
      return executeListDirectory(toolCall.arguments, ctx);
    case "search_files":
      return executeSearchFiles(toolCall.arguments, ctx);
    case "search_content":
      return executeSearchContent(toolCall.arguments, ctx);
    case "get_links":
      return executeGetLinks(toolCall.arguments, ctx);
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

/** Upper bound on semantic_search's topK, matching the Retrieval setting's own range. */
const MAX_SEMANTIC_SEARCH_TOP_K = 20;

async function executeSearchVault(
  args: Record<string, unknown>,
  ctx: VaultToolContext,
): Promise<ToolResult> {
  const query = typeof args.query === "string" ? args.query.trim() : "";
  if (!query) {
    return toolFailure({ kind: "invalid-args", what: "query is required" });
  }

  // An out-of-range topK clamps rather than erroring, exactly as contextLines does
  // below: the model named a breadth, and the nearest legal breadth is a better answer
  // than spending a round trip on a refusal. Absent or unusable, the configured
  // retrieval limit stays in charge and nothing about the call changes.
  const topK =
    typeof args.topK === "number" && Number.isFinite(args.topK)
      ? Math.min(MAX_SEMANTIC_SEARCH_TOP_K, Math.max(1, Math.floor(args.topK)))
      : undefined;

  // Branch "can't run" on the exact reason, so the model is never told the vault is
  // empty when search merely couldn't run, nor pointed at a recovery it can't perform
  // (e.g. "build the index" for a no-backend user). The curated message is already a
  // full recovery contract; `failure.kind` makes the unavailability machine-readable.
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
    results = await ctx.ragService.retrieve(query, ctx.activeFilePath, topK);
  } catch (e) {
    // A live backend that failed at call time, a failure to run, reported as such
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
    // Ran fine, found nothing, a valid empty result, not a failure (no `isError`).
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

/**
 * `read` (RFC-0015), the merged whole-note and single-section read. The two
 * predecessors shared everything up to the file handle, so the merge is one entry
 * point that validates and resolves once, then branches on whether `headingPath` was
 * given (D4). `formatWithLineNumbers`' `startLine` already gives both pathways one
 * line vocabulary, so there is one output shape and nothing to reconcile: the only
 * difference is the header line, `[path]` against `[path > headingPath]`.
 */
async function executeRead(
  args: Record<string, unknown>,
  ctx: VaultToolContext,
): Promise<ToolResult> {
  const rawPath = typeof args.path === "string" ? args.path.trim() : "";
  if (!rawPath) {
    return toolFailure({ kind: "invalid-args", what: "path is required" });
  }

  // Name the vault boundary before the index lookup, so an out-of-vault path is
  // reported as such instead of a dead-end "not found" (the lookup below stays as
  // the security backstop, it can only ever resolve an in-vault file).
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

  // One tool, one dispatch: `read` is the path-to-content tool and an image is content
  // at a path (RFC-0021 D1, ADR-0041). The five extensions are the ones the attachment
  // pipeline already accepts, so anything else, a `.canvas` included, keeps today's
  // text behaviour rather than becoming an unsupported-image error.
  const imageMimeType = SUPPORTED_IMAGE_MIME_BY_EXTENSION[file.extension.toLowerCase()];
  if (imageMimeType) {
    return readImage(file, path, imageMimeType, args, ctx);
  }

  // A blank headingPath is an absent one, so it widens to the whole note rather than
  // refusing: there is no value here that returns a plausible wrong answer.
  const headingPath = typeof args.headingPath === "string" ? args.headingPath.trim() : "";
  if (!headingPath) {
    const content = await ctx.app.vault.read(file);
    return { content: `[${path}]\n\n${formatWithLineNumbers(content)}`, isReadOnly: true };
  }

  const headings = ctx.app.metadataCache.getFileCache(file)?.headings ?? [];
  if (headings.length === 0) {
    // No sections to address; name the parameter to drop, not a sibling tool. This is
    // the one piece of guidance the merge rewrites rather than keeps (RFC-0015).
    return toolFailure({
      kind: "not-found",
      what: `note "${path}" has no headings to read a section from`,
      recovery: "omit headingPath to read it whole",
    });
  }

  const lines = (await ctx.app.vault.read(file)).split("\n");
  const outline = buildOutline(headings, lines.length);
  const match = matchSection(outline, headingPath);

  if (match.kind === "ambiguous") {
    return toolFailure({
      kind: "ambiguous",
      what: `heading "${headingPath}" matches ${match.candidates.length} sections in "${path}"`,
      recovery: `pass one of these full headingPaths: ${match.candidates.join(" | ")}`,
    });
  }
  if (match.kind === "not-found") {
    return toolFailure({
      kind: "not-found",
      what: `no heading matching "${headingPath}" in "${path}"`,
      recovery: "call get_outline to see the note's exact heading paths",
    });
  }

  const section = sectionLines(lines, match.heading);
  // startLine is 1-indexed so a section carries the note's own line numbers, the same
  // ones the whole-note pathway shows for those lines.
  const numbered = formatWithLineNumbers(section.join("\n"), match.heading.startLine + 1);
  return {
    content: `[${path} > ${match.heading.headingPath}]\n\n${numbered}`,
    isReadOnly: true,
  };
}

/**
 * `read`'s image pathway (RFC-0021,
 * {@link ../../../docs/03-decisions/ADR-0041-read-returns-vault-images-to-vision-models.md ADR-0041}):
 * the picture itself for a model that can
 * see it, and a failure that says why not for one that cannot. Before this existed the
 * bytes were decoded as UTF-8 and line-numbered, so an image read cost thousands of
 * tokens of replacement characters and told the model nothing.
 *
 * The order of the checks is the contract. `headingPath` is a call the model got wrong
 * whatever the delivery, so it is named first. The delivery gate then runs BEFORE any
 * read: composing "cannot be viewed" out of bytes nobody will look at is waste, and
 * the dimensions of a refused picture are not the model's business (P5). The size gate
 * reads `stat.size`, so an oversized file is refused without loading it either.
 */
async function readImage(
  file: TFile,
  path: string,
  mimeType: ImageMimeType,
  args: Record<string, unknown>,
  ctx: VaultToolContext,
): Promise<ToolResult> {
  const format = imageFormatLabel(mimeType);

  const headingPath = typeof args.headingPath === "string" ? args.headingPath.trim() : "";
  if (headingPath) {
    return toolFailure({
      kind: "invalid-args",
      what: `an image has no sections to read: "${path}" is a ${format} image`,
      recovery: "omit headingPath to read the image itself",
    });
  }

  if (ctx.imageDelivery !== "inline") {
    // Two refusals, one shape (RFC-0021 D4). The handler picks the clause from the
    // delivery value and never asks which provider is running: the model's own limit
    // and the runtime's wire format are different facts, and telling the user the
    // wrong one is worse than saying nothing.
    const size = formatByteCount(file.stat.size);
    const cannotSee = ctx.imageDelivery === "model-cannot-see";
    return toolFailure({
      kind: "unavailable",
      what:
        `the image at "${path}" (${format}, ${size}) ` +
        (cannotSee
          ? "cannot be viewed by the current model"
          : "cannot be delivered on this runtime"),
      recovery: cannotSee
        ? "tell the user this model has no image input, they can switch to a " +
          "vision-capable model or describe the image, and you should not guess its contents"
        : "tell the user this runtime cannot pass images to the model, they can describe " +
          "the image, and you should not guess its contents",
    });
  }

  if (file.stat.size > MAX_NOTE_CONTEXT_IMAGE_SIZE_BYTES) {
    // A named failure, not a silent downscale: there is no image codec in this process
    // and this RFC does not add one (RFC-0021 D8, RFC-0010).
    return toolFailure({
      kind: "precondition",
      what:
        `the image at "${path}" is ${formatByteCount(file.stat.size)}, over the ` +
        `${formatByteCount(MAX_NOTE_CONTEXT_IMAGE_SIZE_BYTES)} limit for one image`,
      recovery:
        "ask the user to resize or crop it, or to describe what it shows, and read a " +
        "smaller image instead",
    });
  }

  const binary = await ctx.app.vault.readBinary(file);
  const dimensions = readImageDimensions(new Uint8Array(binary));
  return {
    content: imageStub(path, format, binary.byteLength, dimensions, mimeType),
    isReadOnly: true,
    images: [
      {
        path,
        mimeType,
        data: arrayBufferToBase64(binary),
        byteLength: binary.byteLength,
        ...(dimensions ?? {}),
      },
    ],
  };
}

/**
 * The text beside the picture (RFC-0021 D2, P13). It states what was attached and, in
 * the same breath, what to do if it did not arrive: on the one provider where the
 * vision flag can be unknown, a server that drops the image part would otherwise leave
 * the model holding a promise of a picture it never got, which is exactly the guessing
 * the refusal above exists to prevent. So the stub never asserts delivery.
 */
function imageStub(
  path: string,
  format: string,
  byteLength: number,
  dimensions: { width: number; height: number } | null,
  mimeType: ImageMimeType,
): string {
  const size = dimensions
    ? `${dimensions.width}x${dimensions.height}, ${formatByteCount(byteLength)}`
    : formatByteCount(byteLength);
  // Static for every GIF, animated or not: counting frames means walking every image
  // descriptor in the file, which is a parser for one sentence (RFC-0021 P9).
  const gifCaveat =
    mimeType === "image/gif" ? " Animated GIFs may be read as their first frame only." : "";
  return (
    `[${path}]\n\nImage: ${format}, ${size}, attached as an image block. If no image is ` +
    "visible to you, this model has no image input: tell the user and do not guess its " +
    `contents.${gifCaveat}`
  );
}

/** The format name a human reads, from the media type rather than the extension. */
function imageFormatLabel(mimeType: ImageMimeType): string {
  return mimeType.slice("image/".length).toUpperCase();
}

async function executeGetOutline(
  args: Record<string, unknown>,
  ctx: VaultToolContext,
): Promise<ToolResult> {
  const rawPath = typeof args.path === "string" ? args.path.trim() : "";
  if (!rawPath) {
    return toolFailure({ kind: "invalid-args", what: "path is required" });
  }

  // Name the vault boundary before the index lookup (the lookup below stays the
  // security backstop, it can only ever resolve an in-vault file).
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

  const headings = ctx.app.metadataCache.getFileCache(file)?.headings ?? [];
  if (headings.length === 0) {
    return {
      content: `Note "${path}" has no headings; read it whole with read.`,
      isReadOnly: true,
    };
  }

  const lines = (await ctx.app.vault.read(file)).split("\n");
  const outline = buildOutline(headings, lines.length);

  const payload = {
    path,
    headingCount: outline.length,
    headings: outline.map((o) => {
      const section = sectionLines(lines, o);
      return {
        depth: o.depth,
        headingPath: o.headingPath,
        words: countWords(section.join("\n")),
        lines: section.length,
      };
    }),
  };

  return { content: JSON.stringify(payload, null, 2), isReadOnly: true };
}

/** Cap on the entries one listing shows, so a deep call cannot flood context. */
const MAX_LIST_ENTRIES = 500;

function executeListDirectory(
  args: Record<string, unknown>,
  ctx: VaultToolContext,
): ToolResult {
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

  // Depth has no ceiling: the model named a reach, and MAX_LIST_ENTRIES bounds the
  // output whatever it asks for, so a cap on the walk itself would name no failure
  // (RFC-0010). Below one it floors to a level; absent or non-numeric, one level stands.
  const depth =
    typeof args.depth === "number" && Number.isFinite(args.depth)
      ? Math.max(1, Math.floor(args.depth))
      : 1;

  const items: string[] = [];
  collectDirectoryEntries(folder, depth, items);
  items.sort();

  const header = rawPath ? `Contents of "${rawPath}"` : "Vault root";
  if (items.length === 0) {
    return { content: `${header}: (empty)`, isReadOnly: true };
  }
  // Over the bound, the listing is clamped and says how to narrow. It is never refused:
  // a bound on our own output clamps at write time and does not gate a read (RFC-0010),
  // and the same shape already serves search_content's hit cap.
  if (items.length > MAX_LIST_ENTRIES) {
    const shown = items.slice(0, MAX_LIST_ENTRIES);
    return {
      content:
        `${header}, showing first ${MAX_LIST_ENTRIES} of ${items.length}:\n${shown.join("\n")}` +
        `\n\n[Showing ${MAX_LIST_ENTRIES} of ${items.length} entries, narrow path to a ` +
        "subfolder or lower depth to see the rest.]",
      isReadOnly: true,
    };
  }
  return { content: `${header}:\n${items.join("\n")}`, isReadOnly: true };
}

/**
 * Collect one folder's `[DIR]` / `[FILE]` / `[IMAGE]` lines, recursing while levels
 * remain. Full paths, so the flat sorted list still encodes the tree, and a listed path
 * is the exact on-disk path `read` takes.
 *
 * Images are listed because `read` can now open one (RFC-0021). Only the five extensions
 * that pathway accepts, never every non-Markdown file: a `.pdf` or a `.canvas` in the
 * listing would be a path the model can do nothing with, which is the dead end this
 * change exists to close, pointed the other way.
 */
function collectDirectoryEntries(folder: TFolder, levels: number, into: string[]): void {
  for (const child of folder.children) {
    if (child instanceof TFolder) {
      into.push(`[DIR] ${child.path}`);
      if (levels > 1) collectDirectoryEntries(child, levels - 1, into);
    } else if (child instanceof TFile && child.extension === "md") {
      into.push(`[FILE] ${child.path}`);
    } else if (child instanceof TFile && isReadableImage(child)) {
      into.push(`[IMAGE] ${child.path}`);
    }
  }
}

/** Whether `read` would take its image pathway for this file. */
function isReadableImage(file: TFile): boolean {
  return SUPPORTED_IMAGE_MIME_BY_EXTENSION[file.extension.toLowerCase()] !== undefined;
}

function executeSearchFiles(
  args: Record<string, unknown>,
  ctx: VaultToolContext,
): ToolResult {
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

  // Notes plus the images `read` can open (RFC-0021): a `*.png` pattern used to find
  // nothing, which is the same dead end one tool over. Everything else the vault holds
  // stays unlisted, because no read tool can do anything with it.
  const matches: string[] = [];
  for (const file of ctx.app.vault.getFiles()) {
    if (file.extension !== "md" && !isReadableImage(file)) continue;
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
  // so each exec() searches the line from the start, first match per line.
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
  // the model gets an honest "showing N of M" when the result set overflows,
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
    ? `Matches for ${kind} "${query}", showing first ${shownMatches} of ${totalMatches}:`
    : `Matches for ${kind} "${query}" (${totalMatches}):`;
  const footer = truncated
    ? `\n\n[Showing ${shownMatches} of ${totalMatches} matches, narrow the query or scope with path to see the rest.]`
    : "";
  const joiner = contextLines > 0 ? "\n\n" : "\n";
  return { content: `${header}\n${blocks.join(joiner)}${footer}`, isReadOnly: true };
}

/**
 * Render one file's matches. With no context, each match is a single
 * `path:line: snippet` line (grep default). With contextLines > 0, surrounding
 * lines are shown, and overlapping windows are merged into one hunk per file,
 * so a model gets the sentence before/after without a follow-up read and
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

function executeGetLinks(
  args: Record<string, unknown>,
  ctx: VaultToolContext,
): ToolResult {
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

  // Omitting direction asks for both, and so does any value that is not one of the two
  // (D7): the answer is then a superset of what was meant, so there is no wrong value
  // to pick and no round trip spent correcting one.
  const direction = typeof args.direction === "string" ? args.direction.trim().toLowerCase() : "";
  const wantIncoming = direction !== "outgoing";
  const wantOutgoing = direction !== "incoming";

  const sections: string[] = [];

  if (wantIncoming) {
    const incoming = backlinkSources(ctx.app, file).sort();
    sections.push(
      incoming.length === 0
        ? `No notes link to "${path}". This note has no incoming wikilinks; nothing to follow up.`
        : `Notes linking to "${path}" (${incoming.length}):\n${incoming.join("\n")}`,
    );
  }

  if (wantOutgoing) {
    // resolvedLinks maps each source path to its resolved targets (a Record<target,
    // count>), the forward-link mirror of getBacklinksForFile. Resolved-only, so it
    // matches the incoming shape and never lists a link whose target is missing.
    const outgoing = Object.keys(ctx.app.metadataCache.resolvedLinks[file.path] ?? {}).sort();
    sections.push(
      outgoing.length === 0
        ? `"${path}" has no outgoing links. This note links to no other notes; nothing to follow up.`
        : `Notes "${path}" links to (${outgoing.length}):\n${outgoing.join("\n")}`,
    );
  }

  return { content: sections.join("\n\n"), isReadOnly: true };
}

function executeFindNotesByTag(
  args: Record<string, unknown>,
  ctx: VaultToolContext,
): ToolResult {
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

    // Frontmatter tags array (e.g. tags: [character, location]). Frontmatter is
    // untyped (any) user YAML, so treat it as unknown and narrow.
    const fmTags: unknown = cache.frontmatter?.tags;
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
        ? `\nSimilar tags in vault: ${similar.join(", ")}, try one of those.`
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

function executeGetFrontmatter(
  args: Record<string, unknown>,
  ctx: VaultToolContext,
): ToolResult {
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
    // Remove Obsidian's internal position metadata, not useful to the model.
    delete fm["position"];
    results[p] = fm;
  }

  return { content: JSON.stringify(results, null, 2), isReadOnly: true };
}
