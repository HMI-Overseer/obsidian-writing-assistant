import { generateId } from "../utils";
import type { EditBlock, ResolvedEdit, DiffHunk } from "./editTypes";

/** Options controlling how edits are resolved against a document. */
export interface ResolveOptions {
  /** Number of context lines to extract before/after each match. */
  contextLines: number;
  /** Minimum confidence (0–1) to consider a match valid. */
  minConfidence: number;
}

/** Minimum per-line similarity required during fuzzy matching. */
const LINE_SIMILARITY_THRESHOLD = 0.85;

const DEFAULT_OPTIONS: ResolveOptions = {
  contextLines: 3,
  minConfidence: 0.7,
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Resolve an array of EditBlocks against the document text.
 * Returns ResolvedEdits with match locations, context, and confidence scores.
 */
export function resolveEdits(
  blocks: EditBlock[],
  document: string,
  options: Partial<ResolveOptions> = {}
): ResolvedEdit[] {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const docLines = document.split("\n");

  return blocks.map((block) => resolveOneBlock(block, document, docLines, opts));
}

/**
 * Build DiffHunks from resolved edits (all start as "pending").
 */
export function buildHunks(resolvedEdits: ResolvedEdit[]): DiffHunk[] {
  return resolvedEdits.map((edit) => ({
    id: edit.id,
    resolvedEdit: edit,
    status: "pending",
  }));
}

/**
 * Detect overlapping hunks. Returns pairs of hunk IDs that conflict.
 */
export function detectOverlaps(hunks: DiffHunk[]): [string, string][] {
  const sorted = [...hunks]
    .filter((h) => h.resolvedEdit.confidence > 0)
    .sort((a, b) => a.resolvedEdit.matchOffset - b.resolvedEdit.matchOffset);

  const overlaps: [string, string][] = [];

  for (let i = 0; i < sorted.length - 1; i++) {
    const current = sorted[i].resolvedEdit;
    const next = sorted[i + 1].resolvedEdit;
    const currentEnd = current.matchOffset + current.matchLength;

    if (currentEnd > next.matchOffset) {
      overlaps.push([sorted[i].id, sorted[i + 1].id]);
    }
  }

  return overlaps;
}

// ---------------------------------------------------------------------------
// Internal: resolve a single block
// ---------------------------------------------------------------------------

function resolveOneBlock(
  block: EditBlock,
  document: string,
  docLines: string[],
  opts: ResolveOptions
): ResolvedEdit {
  // Tier 1: exact match
  const exactOffset = document.indexOf(block.searchText);
  if (exactOffset !== -1) {
    return buildResolvedEdit(block, document, docLines, exactOffset, block.searchText.length, block.searchText, 1.0, opts);
  }

  // Tier 2: whitespace-normalized match
  const normalizedResult = findNormalizedMatch(block.searchText, document);
  if (normalizedResult) {
    return buildResolvedEdit(
      block, document, docLines,
      normalizedResult.offset, normalizedResult.length, normalizedResult.matchedText,
      0.95, opts
    );
  }

  // Tier 3: line-level fuzzy match
  const fuzzyResult = findFuzzyLineMatch(block.searchText, docLines, opts.minConfidence);
  if (fuzzyResult) {
    const lineOffset = getLineOffset(docLines, fuzzyResult.startLine);
    const lineEnd = getLineEndOffset(docLines, fuzzyResult.endLine);
    const matchedText = document.slice(lineOffset, lineEnd);

    return buildResolvedEdit(
      block, document, docLines,
      lineOffset, lineEnd - lineOffset, matchedText,
      fuzzyResult.confidence, opts
    );
  }

  // No match found — return an unresolved edit
  return {
    id: block.id || generateId(),
    editBlock: block,
    matchOffset: -1,
    matchLength: 0,
    matchedText: "",
    startLine: 0,
    endLine: 0,
    contextBefore: [],
    contextAfter: [],
    confidence: 0,
  };
}

function buildResolvedEdit(
  block: EditBlock,
  document: string,
  docLines: string[],
  offset: number,
  length: number,
  matchedText: string,
  confidence: number,
  opts: ResolveOptions
): ResolvedEdit {
  const startLine = offsetToLine(document, offset);
  const endLine = offsetToLine(document, offset + length - 1);

  const contextBefore = docLines.slice(
    Math.max(0, startLine - 1 - opts.contextLines),
    startLine - 1
  );
  const contextAfter = docLines.slice(
    endLine,
    endLine + opts.contextLines
  );

  return {
    id: block.id || generateId(),
    editBlock: block,
    matchOffset: offset,
    matchLength: length,
    matchedText,
    startLine,
    endLine,
    contextBefore,
    contextAfter,
    confidence,
  };
}

// ---------------------------------------------------------------------------
// Tier 2: whitespace-normalized matching
// ---------------------------------------------------------------------------

interface NormalizedMatch {
  offset: number;
  length: number;
  matchedText: string;
}

function findNormalizedMatch(searchText: string, document: string): NormalizedMatch | null {
  const normalizedSearch = collapseWhitespace(searchText);
  const normalizedDoc = collapseWhitespace(document);

  const idx = normalizedDoc.indexOf(normalizedSearch);
  if (idx === -1) return null;

  // Map normalized offset back to original document offset
  const originalOffset = mapNormalizedOffset(document, idx);
  const originalEnd = mapNormalizedOffset(document, idx + normalizedSearch.length);

  return {
    offset: originalOffset,
    length: originalEnd - originalOffset,
    matchedText: document.slice(originalOffset, originalEnd),
  };
}

function collapseWhitespace(text: string): string {
  return text.replace(/[ \t]+/g, " ").replace(/\n{2,}/g, "\n");
}

/**
 * Map an offset in the collapsed-whitespace string back to the
 * corresponding offset in the original string.
 */
function mapNormalizedOffset(original: string, normalizedOffset: number): number {
  let ni = 0; // position in normalized stream
  let oi = 0; // position in original

  while (ni < normalizedOffset && oi < original.length) {
    const ch = original[oi];

    if (ch === " " || ch === "\t") {
      // Consume the full run of spaces/tabs in original, advance 1 in normalized
      while (oi < original.length && (original[oi] === " " || original[oi] === "\t")) {
        oi++;
      }
      ni++;
    } else if (ch === "\n") {
      // Consume consecutive newlines in original, advance 1 in normalized
      const start = oi;
      while (oi < original.length && original[oi] === "\n") {
        oi++;
      }
      // Only collapse if there were 2+ newlines; single newlines map 1:1
      if (oi - start === 1) {
        ni++;
      } else {
        ni++;
      }
    } else {
      oi++;
      ni++;
    }
  }

  return oi;
}

// ---------------------------------------------------------------------------
// Tier 3: line-level fuzzy matching
// ---------------------------------------------------------------------------

interface FuzzyLineMatch {
  startLine: number; // 1-indexed
  endLine: number;   // 1-indexed
  confidence: number;
}

function findFuzzyLineMatch(
  searchText: string,
  docLines: string[],
  minConfidence: number
): FuzzyLineMatch | null {
  const searchLines = searchText.split("\n").map((l) => l.trim());
  if (searchLines.length === 0) return null;

  let bestMatch: FuzzyLineMatch | null = null;
  let bestScore = 0;

  // Sliding window over document lines
  for (let start = 0; start <= docLines.length - searchLines.length; start++) {
    let totalSimilarity = 0;
    let allAboveThreshold = true;

    for (let j = 0; j < searchLines.length; j++) {
      const sim = lineSimilarity(searchLines[j], docLines[start + j].trim());
      if (sim < LINE_SIMILARITY_THRESHOLD) {
        allAboveThreshold = false;
        break;
      }
      totalSimilarity += sim;
    }

    if (!allAboveThreshold) continue;

    const avgSimilarity = totalSimilarity / searchLines.length;
    if (avgSimilarity > bestScore && avgSimilarity >= minConfidence) {
      bestScore = avgSimilarity;
      bestMatch = {
        startLine: start + 1,
        endLine: start + searchLines.length,
        confidence: Math.round(avgSimilarity * 100) / 100,
      };
    }
  }

  return bestMatch;
}

/**
 * Simple character-level similarity using Levenshtein distance.
 * Returns 0–1 where 1.0 means identical.
 */
function lineSimilarity(a: string, b: string): number {
  if (a === b) return 1.0;
  if (a.length === 0 || b.length === 0) return 0;

  const maxLen = Math.max(a.length, b.length);
  const dist = levenshtein(a, b);

  return 1 - dist / maxLen;
}

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;

  // Use single-row optimization for memory efficiency
  const row = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) row[j] = j;

  for (let i = 1; i <= m; i++) {
    let prev = row[0];
    row[0] = i;

    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const temp = row[j];
      row[j] = Math.min(
        row[j] + 1,         // deletion
        row[j - 1] + 1,     // insertion
        prev + cost          // substitution
      );
      prev = temp;
    }
  }

  return row[n];
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/** Convert a character offset to a 1-indexed line number. */
function offsetToLine(document: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < document.length; i++) {
    if (document[i] === "\n") line++;
  }
  return line;
}

/** Get the character offset of the start of a 1-indexed line. */
function getLineOffset(lines: string[], lineNumber: number): number {
  let offset = 0;
  for (let i = 0; i < lineNumber - 1 && i < lines.length; i++) {
    offset += lines[i].length + 1; // +1 for \n
  }
  return offset;
}

/** Get the character offset of the end of a 1-indexed line (exclusive). */
function getLineEndOffset(lines: string[], lineNumber: number): number {
  let offset = 0;
  for (let i = 0; i < lineNumber && i < lines.length; i++) {
    offset += lines[i].length + 1;
  }
  // Remove trailing \n to get the end of the last line's content
  return Math.max(0, offset - 1);
}
