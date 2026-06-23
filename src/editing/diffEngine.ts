import { generateId } from "../utils";
import { toLf } from "./lineEndings";
import type { EditBlock, ResolvedEdit, DiffHunk, MatchType } from "./editTypes";

/** Options controlling how edits are resolved against a document. */
export interface ResolveOptions {
  /** Number of context lines to extract before/after each match. */
  contextLines: number;
  /** Minimum confidence (0–1) to consider a match valid. */
  minConfidence: number;
}

/** Minimum per-line similarity required during fuzzy matching. */
const LINE_SIMILARITY_THRESHOLD = 0.85;

/**
 * On a total miss, the closest window must score at least this to count as a
 * "near miss", similar text that just fell short, worth a "re-read and copy the
 * exact wording" nudge rather than a blind re-read. (Pure whitespace differences are
 * already absorbed by the Tier 2 match, so a near miss is a wording/spelling gap.)
 * Below this we treat the text as simply absent.
 */
const NEAR_MISS_THRESHOLD = 0.5;

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

  // Canonicalize on LF at the boundary so a CRLF-authored note matches an LF search
  // at the exact/whitespace tiers instead of falling through to fuzzy. Every offset,
  // line, and matchedText we return is therefore LF-space; the file-write boundary
  // re-expands to the document's prevailing EOL (diff-engine-real-document-robustness,
  // P1-2).
  const lfDoc = toLf(document);
  const docLines = lfDoc.split("\n");

  return blocks.map((block) => resolveOneBlock(block, lfDoc, docLines, opts));
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
  // `document` is already LF-normalized (see resolveEdits); normalize the model's
  // search text the same way so the two share a line-ending convention before any
  // tier runs. The original block is preserved on `editBlock` for display.
  const searchText = toLf(block.searchText);

  // Tier 0: fence the empty / whitespace-only search before any tier sees it.
  // `document.indexOf("")` returns 0, so an unguarded empty search would resolve as a
  // confident exact match at the top of the file and silently prepend replaceText
  // (diff-engine-real-document-robustness, symptom B / P1-8). Structural inserts carry
  // a toolName and legitimately use an empty search to mean "insert at top" (e.g.
  // frontmatter into a note that has none), so they pass through; a plain prose edit
  // with no anchor is the model dropping its search, so return a clean no-match it can
  // self-correct from. This lives in the engine so every entry — the regex-parse path
  // and the finalize path included — is covered, mirroring the in-loop and tool-preflight
  // guards rather than relying on them.
  if (block.toolName === undefined && searchText.trim().length === 0) {
    return unresolvedEdit(block, false);
  }

  // Tier 1: exact match
  const exactOffset = document.indexOf(searchText);
  if (exactOffset !== -1) {
    return buildResolvedEdit(block, document, docLines, exactOffset, searchText.length, searchText, 1.0, "exact", opts);
  }

  // Tier 2: whitespace-normalized match
  const normalizedResult = findNormalizedMatch(searchText, document);
  if (normalizedResult) {
    return buildResolvedEdit(
      block, document, docLines,
      normalizedResult.offset, normalizedResult.length, normalizedResult.matchedText,
      0.95, "whitespace", opts
    );
  }

  // Tier 3: line-level fuzzy match
  const fuzzyResult = findFuzzyLineMatch(searchText, docLines, opts.minConfidence);
  if (fuzzyResult.match) {
    const lineOffset = getLineOffset(docLines, fuzzyResult.match.startLine);
    const lineEnd = getLineEndOffset(docLines, fuzzyResult.match.endLine);
    const matchedText = document.slice(lineOffset, lineEnd);

    return buildResolvedEdit(
      block, document, docLines,
      lineOffset, lineEnd - lineOffset, matchedText,
      fuzzyResult.match.confidence, "fuzzy", opts
    );
  }

  // No match found, return an unresolved edit. `nearMiss` distinguishes "close but
  // below threshold" (copy the exact wording) from "absent" (re-read), the failure-side
  // signal the channel otherwise collapses to a flat "no match".
  return unresolvedEdit(block, fuzzyResult.bestScore >= NEAR_MISS_THRESHOLD);
}

/**
 * Build a "no match" ResolvedEdit (matchType `none`, confidence 0, offset -1). Shared by
 * the empty-search guard (Tier 0) and the total-miss fall-through so both report a miss
 * identically. `nearMiss` is the total-miss-only "you were close, copy the exact wording"
 * signal; the empty-search guard passes `false` (nothing was scored).
 */
function unresolvedEdit(block: EditBlock, nearMiss: boolean): ResolvedEdit {
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
    matchType: "none",
    nearMiss,
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
  matchType: MatchType,
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
    matchType,
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
      // A run of newlines (one or many) collapses to a single normalized newline.
      while (oi < original.length && original[oi] === "\n") {
        oi++;
      }
      ni++;
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

/**
 * Result of the fuzzy scan: the accepted `match` (or null), plus `bestScore`, the
 * highest whole-window average similarity observed, accepted or not. `bestScore`
 * feeds the near-miss signal on a total miss: a window that scored well but had one
 * line below the per-line gate never becomes a match, yet still tells the model "you
 * were close" rather than "that text is absent."
 */
interface FuzzyScanResult {
  match: FuzzyLineMatch | null;
  bestScore: number;
}

function findFuzzyLineMatch(
  searchText: string,
  docLines: string[],
  minConfidence: number
): FuzzyScanResult {
  const searchLines = searchText.split("\n").map((l) => l.trim());
  if (searchLines.length === 0) return { match: null, bestScore: 0 };

  let bestMatch: FuzzyLineMatch | null = null;
  let bestAccepted = 0;
  let bestObserved = 0;

  // Sliding window over document lines. We score every window fully (no early break)
  // so `bestObserved` reflects the closest candidate even when it can't be accepted.
  for (let start = 0; start <= docLines.length - searchLines.length; start++) {
    let totalSimilarity = 0;
    let allAboveThreshold = true;

    for (let j = 0; j < searchLines.length; j++) {
      const sim = lineSimilarity(searchLines[j], docLines[start + j].trim());
      if (sim < LINE_SIMILARITY_THRESHOLD) allAboveThreshold = false;
      totalSimilarity += sim;
    }

    const avgSimilarity = totalSimilarity / searchLines.length;
    if (avgSimilarity > bestObserved) bestObserved = avgSimilarity;

    if (allAboveThreshold && avgSimilarity > bestAccepted && avgSimilarity >= minConfidence) {
      bestAccepted = avgSimilarity;
      bestMatch = {
        startLine: start + 1,
        endLine: start + searchLines.length,
        confidence: Math.round(avgSimilarity * 100) / 100,
      };
    }
  }

  return { match: bestMatch, bestScore: bestObserved };
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
