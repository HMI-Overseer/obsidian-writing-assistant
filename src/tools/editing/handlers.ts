import type { App, TFile } from "obsidian";
import type { EditBlock } from "../../editing/editTypes";
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
    if (block.toolName === "update_frontmatter") {
      resolved.push(await resolveUpdateFrontmatter(ctx.app, file, block));
    } else {
      resolved.push(block);
    }
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// Structural edit block resolution
// ---------------------------------------------------------------------------

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
