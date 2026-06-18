import { type App, type TFile, normalizePath } from "obsidian";
import type { EditBlock } from "../../editing/editTypes";
import type { ToolCall, ToolResult } from "../types";
import { toolFailure } from "../toolFailure";
import { EDIT_TOOL_NAMES } from "./definition";
import { validateProposeEdit, validateUpdateFrontmatter } from "./validation";
import type { FrontmatterOperation } from "./validation";
import { normalizeEscapes } from "./conversion";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface ToolExecutionContext {
  app: App;
  /** Vault-relative path to the active file. */
  filePath: string;
}

/**
 * Execute an edit tool inside the tool loop and return a result for the model.
 *
 * Edit tools are validated and checked against the active document so the model
 * gets immediate feedback (e.g. "search text not found") and can self-correct
 * before the loop ends. The actual diff review happens at finalization — this
 * function only validates and acknowledges.
 */
export async function executeEditTool(
  toolCall: ToolCall,
  ctx: ToolExecutionContext,
): Promise<ToolResult> {
  if (!EDIT_TOOL_NAMES.has(toolCall.name)) {
    return unknownEditTool(toolCall.name);
  }

  switch (toolCall.name) {
    case "propose_edit":
      return executeProposeEdit(toolCall.arguments, ctx);
    case "update_frontmatter":
      return executeUpdateFrontmatter(toolCall.arguments);
    default:
      return unknownEditTool(toolCall.name);
  }
}

function unknownEditTool(name: string): ToolResult {
  return toolFailure({
    kind: "invalid-args",
    what: `unknown edit tool "${name}"`,
    recovery: "call one of the advertised edit tools instead",
    isReadOnly: false,
  });
}

/**
 * Resolve the target file for edit operations from the tool call's `path`
 * argument, falling back to the document-context path then the active file.
 * The `path` is the model's explicit target (propose-edit-in-loop-blocking-review).
 */
function resolveTargetFile(ctx: ToolExecutionContext, path?: string) {
  const candidate = path || ctx.filePath;
  if (candidate) {
    const file = ctx.app.vault.getFileByPath(normalizePath(candidate));
    if (file) return { file, path: file.path };
  }
  const active = ctx.app.workspace.getActiveFile();
  if (active) return { file: active, path: active.path };
  return null;
}

async function executeProposeEdit(
  args: Record<string, unknown>,
  ctx: ToolExecutionContext,
): Promise<ToolResult> {
  const v = validateProposeEdit(args);
  if (!v.ok) {
    return toolFailure({
      kind: "invalid-args",
      what: `invalid propose_edit arguments: ${v.error}`,
      isReadOnly: false,
    });
  }

  const searchText = normalizeEscapes(v.args.search);
  if (!searchText) {
    return toolFailure({
      kind: "invalid-args",
      what: "search text is empty",
      recovery: "pass the exact text you want to replace",
      isReadOnly: false,
    });
  }

  const target = resolveTargetFile(ctx, v.args.path);
  if (!target) {
    return toolFailure({
      kind: "invalid-args",
      what: "no target note",
      recovery:
        "pass `path` (the vault-relative path of the note to edit), or open the file you want to edit",
      isReadOnly: false,
    });
  }

  const content = await ctx.app.vault.read(target.file);
  const idx = content.indexOf(searchText);

  if (idx === -1) {
    return toolFailure({
      kind: "no-match",
      what: `search text not found in "${target.path}"`,
      recovery:
        "match the document exactly, including whitespace and indentation, or use read_file to verify the current content",
      isReadOnly: false,
    });
  }

  const lineNumber = content.slice(0, idx).split("\n").length;
  const explanation = v.args.explanation ? ` (${v.args.explanation})` : "";
  return {
    content: `Edit proposed for "${target.path}": matched at line ${lineNumber}${explanation}. Queued for user review.`,
    isReadOnly: false,
  };
}

function executeUpdateFrontmatter(
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const v = validateUpdateFrontmatter(args);
  if (!v.ok) {
    return Promise.resolve(
      toolFailure({
        kind: "invalid-args",
        what: `invalid update_frontmatter arguments: ${v.error}`,
        isReadOnly: false,
      }),
    );
  }

  const summary = v.args.operations
    .map((op) => `${op.action} '${op.key}'`)
    .join(", ");
  const explanation = v.args.explanation ? ` (${v.args.explanation})` : "";
  return Promise.resolve({
    content: `Frontmatter update proposed: ${summary}${explanation}. Queued for user review.`,
    isReadOnly: false,
  });
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
      op.value ? `${op.key}: ${yamlSafeValue(op.value)}` : `${op.key}:`
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
 * Wrap a YAML value in double quotes and escape inner characters when the
 * value contains characters that could alter YAML structure (colons,
 * newlines, comment markers, etc.).  Plain safe scalars are returned as-is.
 */
function yamlSafeValue(value: string): string {
  if (/[\n\r:#{}[\],&*?|>!'"%@`]/.test(value) || value !== value.trim()) {
    return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r")}"`;
  }
  return value;
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
      const newLine = op.value ? `${key}: ${yamlSafeValue(op.value)}` : `${key}:`;
      result.splice(start, end - start, newLine);
    }
  }

  // Append any "set" operations for keys not already in the frontmatter.
  for (const op of operations) {
    if (op.action === "set" && !keysProcessed.has(op.key)) {
      const newLine = op.value ? `${op.key}: ${yamlSafeValue(op.value)}` : `${op.key}:`;
      result.push(newLine);
    }
  }

  return result;
}
