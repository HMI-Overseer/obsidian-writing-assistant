import type { App, HeadingCache, TFile } from "obsidian";
import type { ToolCall, ToolResult } from "../types";
import type { EditBlock } from "../../editing/editTypes";
import { READ_ONLY_TOOL_NAMES } from "./definition";

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
    parts.push(`Frontmatter: yes (lines ${fmStart}-${fmEnd})`);
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
  const startLine = args.start_line as number;
  if (!startLine || startLine < 1) {
    return {
      content: "Error: start_line must be a positive integer (1-indexed).",
      isReadOnly: true,
      isError: true,
    };
  }

  const content = await app.vault.read(file);
  const lines = content.split("\n");

  let endLine = args.end_line as number | undefined;
  if (!endLine || endLine === -1) {
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
    | Array<{ key: string; value?: string; action: string }>
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

    // Parse inner lines (between the --- delimiters)
    const innerLines = fmLines.slice(1, -1);
    const properties = parseFrontmatterLines(innerLines);

    // Apply operations
    for (const op of operations) {
      if (op.action === "set") {
        properties.set(op.key, op.value ?? "");
      } else if (op.action === "remove") {
        properties.delete(op.key);
      }
    }

    // Rebuild frontmatter
    const newInner = buildFrontmatterLines(properties);
    const replaceText = "---\n" + newInner.join("\n") + "\n---";

    return { ...block, searchText, replaceText };
  } else {
    // No existing frontmatter — insert at top
    const properties = new Map<string, string>();
    for (const op of operations) {
      if (op.action === "set") {
        properties.set(op.key, op.value ?? "");
      }
    }

    if (properties.size === 0) return block;

    const newInner = buildFrontmatterLines(properties);
    const fmBlock = "---\n" + newInner.join("\n") + "\n---";

    // Anchor on the first line to insert before it
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

/** Parse simple YAML key: value lines into an ordered Map. */
function parseFrontmatterLines(lines: string[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of lines) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim();
    if (key) map.set(key, value);
  }
  return map;
}

/** Build YAML lines from a key-value Map. */
function buildFrontmatterLines(properties: Map<string, string>): string[] {
  const lines: string[] = [];
  for (const [key, value] of properties) {
    lines.push(value ? `${key}: ${value}` : `${key}:`);
  }
  return lines;
}

export { getHeadingBoundaries };
export type { HeadingBoundaries };
