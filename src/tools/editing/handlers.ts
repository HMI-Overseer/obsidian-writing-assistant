import type { App, HeadingCache, TFile } from "obsidian";
import type { ToolCall, ToolResult } from "../types";
import type { EditBlock } from "../../editing/editTypes";
import { READ_ONLY_TOOL_NAMES } from "./definition";
import { validateGetLineRange } from "./validation";
import type { FrontmatterOperation } from "./validation";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface ToolExecutionContext {
  app: App;
  /** Vault-relative path to the active file. */
  filePath: string;
}

/**
 * Execute a read-only edit tool and return its result.
 * Write tools are not executed here — they are converted to EditBlocks later.
 */
export async function executeReadOnlyTool(
  toolCall: ToolCall,
  ctx: ToolExecutionContext,
): Promise<ToolResult> {
  if (!READ_ONLY_TOOL_NAMES.has(toolCall.name)) {
    return { content: "", isReadOnly: false };
  }

  const file = ctx.app.vault.getFileByPath(ctx.filePath);
  if (!file) {
    return {
      content: `Error: file not found at "${ctx.filePath}".`,
      isReadOnly: true,
      isError: true,
    };
  }

  switch (toolCall.name) {
    case "get_document_outline":
      return executeGetDocumentOutline(ctx.app, file);
    case "get_line_range":
      return executeGetLineRange(ctx.app, file, toolCall.arguments);
    default:
      return {
        content: `Unknown read-only tool: ${toolCall.name}`,
        isReadOnly: true,
        isError: true,
      };
  }
}

/**
 * Resolve structure-aware EditBlocks that need MetadataCache or document
 * content to populate their searchText / replaceText.
 *
 * This must be called before blocks are passed to `resolveEdits()`.
 */
export async function resolveStructuralEditBlocks(
  blocks: EditBlock[],
  ctx: ToolExecutionContext,
): Promise<EditBlock[]> {
  const file = ctx.app.vault.getFileByPath(ctx.filePath);
  if (!file) return blocks;

  const resolved: EditBlock[] = [];
  for (const block of blocks) {
    if (!block.toolName) {
      resolved.push(block);
      continue;
    }

    switch (block.toolName) {
      case "replace_section":
        resolved.push(await resolveReplaceSection(ctx.app, file, block));
        break;
      case "insert_at_position":
        resolved.push(await resolveInsertAtPosition(ctx.app, file, block));
        break;
      case "update_frontmatter":
        resolved.push(await resolveUpdateFrontmatter(ctx.app, file, block));
        break;
      default:
        resolved.push(block);
    }
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// Read-only tool implementations
// ---------------------------------------------------------------------------

async function executeGetDocumentOutline(
  app: App,
  file: TFile,
): Promise<ToolResult> {
  const content = await app.vault.read(file);
  const lines = content.split("\n");
  const cache = app.metadataCache.getFileCache(file);

  const parts: string[] = [];
  parts.push(`Document: "${file.name}" (${lines.length} lines)`);

  const hasFrontmatter = !!cache?.frontmatter;
  if (hasFrontmatter && cache?.frontmatterPosition) {
    const fmStart = cache.frontmatterPosition.start.line + 1;
    const fmEnd = cache.frontmatterPosition.end.line + 1;
    const keys = Object.keys(cache.frontmatter).filter((k) => k !== "position");
    parts.push(`Frontmatter: yes (lines ${fmStart}-${fmEnd}), keys: ${keys.join(", ")}`);
  } else {
    parts.push("Frontmatter: none");
  }

  parts.push("");

  const headings = cache?.headings;
  if (headings && headings.length > 0) {
    parts.push("## Heading Outline");
    for (const h of headings) {
      const prefix = "#".repeat(h.level);
      const line = h.position.start.line + 1;
      parts.push(`- L${h.level}: ${prefix} ${h.heading} (line ${line})`);
    }
  } else {
    parts.push("No headings found.");
  }

  return { content: parts.join("\n"), isReadOnly: true };
}

async function executeGetLineRange(
  app: App,
  file: TFile,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const validation = validateGetLineRange(args);
  if (!validation.ok) {
    return { content: `Error: ${validation.error}`, isReadOnly: true, isError: true };
  }

  const { start_line: startLine } = validation.args;

  const content = await app.vault.read(file);
  const lines = content.split("\n");

  let endLine = validation.args.end_line;
  if (endLine === undefined || endLine === -1) {
    endLine = lines.length;
  }

  const clampedStart = Math.max(1, Math.min(startLine, lines.length));
  const clampedEnd = Math.max(clampedStart, Math.min(endLine, lines.length));

  const result: string[] = [];
  for (let i = clampedStart; i <= clampedEnd; i++) {
    result.push(`${i}\t${lines[i - 1]}`);
  }

  return { content: result.join("\n"), isReadOnly: true };
}

// ---------------------------------------------------------------------------
// Structural edit block resolution
// ---------------------------------------------------------------------------

async function resolveReplaceSection(
  app: App,
  file: TFile,
  block: EditBlock,
): Promise<EditBlock> {
  const heading = block.toolArgs?.heading as string | undefined;
  if (!heading) return block;

  const content = await app.vault.read(file);
  const boundaries = getHeadingBoundaries(app, file, heading);
  if (!boundaries) {
    // Can't resolve — leave searchText empty; diffEngine will assign confidence 0
    return block;
  }

  const lines = content.split("\n");
  const { headingLine, bodyStartLine, endLine } = boundaries;

  // searchText = heading line + body (everything from heading to section end)
  const sectionLines = lines.slice(headingLine, endLine);
  const searchText = sectionLines.join("\n");

  // replaceText = original heading line + new content
  const headingLineText = lines[headingLine];
  const replaceText = headingLineText + "\n" + block.replaceText;

  // Ensure trailing newline matches if the section had one
  const bodyLines = lines.slice(bodyStartLine, endLine);
  const originalBody = bodyLines.join("\n");

  return { ...block, searchText, replaceText: replaceText, toolArgs: { ...block.toolArgs, originalBody } };
}

async function resolveInsertAtPosition(
  app: App,
  file: TFile,
  block: EditBlock,
): Promise<EditBlock> {
  const content = await app.vault.read(file);
  const lines = content.split("\n");

  const afterHeading = block.toolArgs?.after_heading as string | undefined;
  const lineNumber = block.toolArgs?.line_number as number | undefined;

  let insertAfterLine: number; // 0-indexed line after which to insert

  if (afterHeading) {
    const boundaries = getHeadingBoundaries(app, file, afterHeading);
    if (!boundaries) return block;
    insertAfterLine = boundaries.headingLine; // Insert right after the heading line
  } else if (lineNumber !== undefined) {
    if (lineNumber === 0) {
      // Insert at very top: anchor on the first non-empty line for unambiguous matching.
      const firstIdx = lines.findIndex((l) => l.trim() !== "");
      if (firstIdx === -1) {
        // Document is entirely empty/whitespace — just prepend.
        return { ...block, searchText: "", replaceText: block.replaceText };
      }
      const anchor = lines[firstIdx];
      const prefix = lines.slice(0, firstIdx).join("\n");
      return {
        ...block,
        searchText: anchor,
        replaceText: (prefix ? prefix + "\n" : "") + block.replaceText + "\n" + anchor,
      };
    } else if (lineNumber === -1) {
      // Insert at end: anchor on the last non-empty line for unambiguous matching.
      let lastIdx = lines.length - 1;
      while (lastIdx >= 0 && lines[lastIdx].trim() === "") {
        lastIdx--;
      }
      if (lastIdx < 0) {
        // Document is entirely empty/whitespace — just append.
        return { ...block, searchText: "", replaceText: block.replaceText };
      }
      const anchor = lines[lastIdx];
      const suffix = lines.slice(lastIdx + 1).join("\n");
      return {
        ...block,
        searchText: anchor,
        replaceText: anchor + "\n" + block.replaceText + (suffix ? "\n" + suffix : ""),
      };
    } else {
      insertAfterLine = Math.min(lineNumber, lines.length) - 1; // Convert 1-indexed to 0-indexed
    }
  } else {
    return block; // Neither locator provided
  }

  // Use the line at insertAfterLine as anchor context
  const anchorLine = lines[insertAfterLine];
  return {
    ...block,
    searchText: anchorLine,
    replaceText: anchorLine + "\n" + block.replaceText,
  };
}

async function resolveUpdateFrontmatter(
  app: App,
  file: TFile,
  block: EditBlock,
): Promise<EditBlock> {
  const operations = block.toolArgs?.operations as
    | FrontmatterOperation[]
    | undefined;
  if (!operations || operations.length === 0) return block;

  const content = await app.vault.read(file);
  const cache = app.metadataCache.getFileCache(file);

  // Extract current frontmatter block
  const hasFrontmatter = !!cache?.frontmatterPosition;

  if (hasFrontmatter && cache?.frontmatterPosition) {
    const fmStart = cache.frontmatterPosition.start.line;
    const fmEnd = cache.frontmatterPosition.end.line;
    const lines = content.split("\n");

    // Full frontmatter block including --- delimiters
    const fmLines = lines.slice(fmStart, fmEnd + 1);
    const searchText = fmLines.join("\n");

    // Apply operations to the inner lines, preserving complex YAML
    // structures (lists, nested objects) for keys that aren't modified.
    const innerLines = fmLines.slice(1, -1);
    const newInner = applyFrontmatterOperations(innerLines, operations);
    const replaceText = "---\n" + newInner.join("\n") + "\n---";

    return { ...block, searchText, replaceText };
  } else {
    // No existing frontmatter — build a new block from set operations.
    const setOps = operations.filter((op) => op.action === "set");
    if (setOps.length === 0) return block;

    const newInner = setOps.map((op) =>
      op.value ? `${op.key}: ${op.value}` : `${op.key}:`
    );
    const fmBlock = "---\n" + newInner.join("\n") + "\n---";

    // Anchor on the first line to insert before it.
    const lines = content.split("\n");
    if (lines.length === 0) {
      return { ...block, searchText: "", replaceText: fmBlock };
    }

    const firstLine = lines[0];
    return {
      ...block,
      searchText: firstLine,
      replaceText: fmBlock + "\n" + firstLine,
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface HeadingBoundaries {
  /** 0-indexed line of the heading itself. */
  headingLine: number;
  /** 0-indexed line where the body starts (line after heading). */
  bodyStartLine: number;
  /** 0-indexed exclusive end line (next sibling heading or EOF). */
  endLine: number;
}

/**
 * Find the boundaries of a heading section using MetadataCache.
 * Returns null if the heading is not found.
 */
function getHeadingBoundaries(
  app: App,
  file: TFile,
  headingText: string,
): HeadingBoundaries | null {
  const cache = app.metadataCache.getFileCache(file);
  if (!cache?.headings) return null;

  const headings = cache.headings;
  const idx = headings.findIndex((h: HeadingCache) => h.heading === headingText);
  if (idx === -1) return null;

  const heading = headings[idx];
  const headingLine = heading.position.start.line;
  const bodyStartLine = headingLine + 1;

  // Find the next heading of equal or higher level
  let endLine: number | undefined;
  for (let i = idx + 1; i < headings.length; i++) {
    if (headings[i].level <= heading.level) {
      endLine = headings[i].position.start.line;
      break;
    }
  }

  // If no sibling found, the section extends to EOF.
  // We'll need the line count — estimate from cache or use a sentinel.
  if (endLine === undefined) {
    // Use a large number; callers will clamp to actual line count.
    endLine = Number.MAX_SAFE_INTEGER;
  }

  return { headingLine, bodyStartLine, endLine };
}

/**
 * Apply frontmatter operations to raw YAML lines, preserving complex
 * values (lists, nested objects, multi-line strings) for keys that
 * are not being modified.
 *
 * This replaces the naive parseFrontmatterLines + buildFrontmatterLines
 * approach which dropped non-scalar YAML values.
 */
function applyFrontmatterOperations(
  innerLines: string[],
  operations: FrontmatterOperation[],
): string[] {
  const result = [...innerLines];

  // Build a map of operations by key for efficient lookup.
  const opsByKey = new Map<string, FrontmatterOperation>();
  for (const op of operations) {
    opsByKey.set(op.key, op);
  }

  // Identify which lines belong to which top-level key.
  // A top-level key starts at column 0 with `key:`. Continuation lines
  // (indented, or list items) belong to the preceding key.
  const keyRanges: Array<{ key: string; start: number; end: number }> = [];
  for (let i = 0; i < result.length; i++) {
    const line = result[i];
    // Top-level key: starts at column 0, has a colon not inside a quote.
    const colonIdx = line.indexOf(":");
    if (colonIdx > 0 && !line.startsWith(" ") && !line.startsWith("\t")) {
      const key = line.slice(0, colonIdx).trim();
      if (key) {
        keyRanges.push({ key, start: i, end: i + 1 });
      }
    }
  }

  // Extend each key range to include continuation lines (indented lines
  // and list items that belong to the previous key's value).
  for (let i = 0; i < keyRanges.length; i++) {
    const nextStart = i + 1 < keyRanges.length
      ? keyRanges[i + 1].start
      : result.length;
    keyRanges[i].end = nextStart;
  }

  // Process operations in reverse order so splicing doesn't shift indices.
  const keysProcessed = new Set<string>();

  for (let i = keyRanges.length - 1; i >= 0; i--) {
    const { key, start, end } = keyRanges[i];
    const op = opsByKey.get(key);
    if (!op) continue;

    keysProcessed.add(key);

    if (op.action === "remove") {
      result.splice(start, end - start);
    } else if (op.action === "set") {
      // Replace the entire key block with a simple key: value line.
      const newLine = op.value ? `${key}: ${op.value}` : `${key}:`;
      result.splice(start, end - start, newLine);
    }
  }

  // Append any "set" operations for keys not already in the frontmatter.
  for (const op of operations) {
    if (op.action === "set" && !keysProcessed.has(op.key)) {
      const newLine = op.value ? `${op.key}: ${op.value}` : `${op.key}:`;
      result.push(newLine);
    }
  }

  return result;
}

export { getHeadingBoundaries };
export type { HeadingBoundaries };
