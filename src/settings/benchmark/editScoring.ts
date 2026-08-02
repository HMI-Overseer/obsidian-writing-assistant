import { resolveEdits } from "../../editing/diffEngine";
import { parseEditBlocks } from "../../editing/parseEditBlocks";
import type { EditBlock, ResolvedEdit } from "../../editing/editTypes";
import { check, buildResultFromChecks } from "./checks";
import type { BenchmarkResult, BenchmarkTestCase, DocRegion, EvaluationCheck } from "./types";

/**
 * Ground-truth scoring for edit-block tests.
 *
 * Instead of guessing intent from keywords, blocks are resolved against the
 * fixture document with the same diff engine the real pipeline uses. Each
 * resolved match is classified by which document region it lands in, so the
 * verdict reflects what would actually happen if the user applied the edits.
 */

// ---------------------------------------------------------------------------
// Region location
// ---------------------------------------------------------------------------

interface RegionSpan {
  label: string;
  start: number;
  end: number;
}

/** Locates a region's exact text in the document. Returns null if the fixture has drifted. */
function locateRegion(document: string, region: DocRegion): RegionSpan | null {
  const start = document.indexOf(region.text);
  if (start === -1) return null;
  return { label: region.label, start, end: start + region.text.length };
}

// ---------------------------------------------------------------------------
// Block assessment
// ---------------------------------------------------------------------------

export interface BlockAssessment {
  resolved: ResolvedEdit;
  /** True when the diff engine found a match (exact, normalized, or fuzzy). */
  applies: boolean;
  /** True when the search text matched character-for-character. */
  exact: boolean;
  /** Labels of the regions the match overlaps. */
  overlaps: string[];
}

function overlapsSpan(edit: ResolvedEdit, span: RegionSpan): boolean {
  const start = edit.matchOffset;
  const end = edit.matchOffset + edit.matchLength;
  return start < span.end && end > span.start;
}

/**
 * Resolves bare search texts (e.g. edit arguments) against the document
 * and classifies each match by region. Regions whose text is absent from the
 * document are ignored.
 */
export function assessSearchTexts(
  searches: string[],
  document: string,
  regions: DocRegion[] = []
): BlockAssessment[] {
  const spans = regions
    .map((r) => locateRegion(document, r))
    .filter((s): s is RegionSpan => s !== null);
  const blocks: EditBlock[] = searches.map((searchText) => ({
    id: "",
    searchText,
    replaceText: "",
    rawBlock: "",
  }));
  return assessBlocks(blocks, document, spans);
}

function assessBlocks(
  blocks: EditBlock[],
  document: string,
  spans: RegionSpan[]
): BlockAssessment[] {
  const resolved = resolveEdits(blocks, document);
  return resolved.map((edit) => {
    const applies = edit.confidence > 0;
    return {
      resolved: edit,
      applies,
      exact: edit.confidence === 1,
      overlaps: applies ? spans.filter((s) => overlapsSpan(edit, s)).map((s) => s.label) : [],
    };
  });
}

// ---------------------------------------------------------------------------
// Failure diagnosis: closest paragraph by word overlap
// ---------------------------------------------------------------------------

interface Paragraph {
  text: string;
  index: number;
}

function splitParagraphs(document: string): Paragraph[] {
  return document
    .split(/\n{2,}/)
    .map((text, index) => ({ text: text.trim(), index: index + 1 }))
    .filter((p) => p.text.length > 0);
}

function wordSet(text: string): Set<string> {
  return new Set(text.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? []);
}

/** Word-level Jaccard-style similarity (shared / larger set), 0–1. */
function wordOverlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const w of a) if (b.has(w)) shared++;
  return shared / Math.max(a.size, b.size);
}

function snippet(text: string, maxLength = 60): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= maxLength ? flat : flat.slice(0, maxLength) + "…";
}

/**
 * Explains why a search text found no match: names the document paragraph it
 * most resembles, which distinguishes "paraphrased the document" from
 * "invented text that isn't in the document at all".
 */
export function closestParagraphDiagnosis(searchText: string, document: string): string {
  const searchWords = wordSet(searchText);
  let best: Paragraph | null = null;
  let bestScore = 0;

  for (const para of splitParagraphs(document)) {
    const score = wordOverlap(searchWords, wordSet(para.text));
    if (score > bestScore) {
      bestScore = score;
      best = para;
    }
  }

  if (!best || bestScore < 0.2) {
    return "search text resembles nothing in the document, the model invented content";
  }

  const pct = Math.round(bestScore * 100);
  return `closest is paragraph ${best.index} ("${snippet(best.text)}") at ${pct}% word overlap, the model likely paraphrased instead of quoting exactly`;
}

// ---------------------------------------------------------------------------
// Evidence formatting
// ---------------------------------------------------------------------------

function matchQuality(edit: ResolvedEdit): string {
  if (edit.confidence === 1) return "exact match";
  if (edit.confidence >= 0.95) return "whitespace-normalized match";
  return `fuzzy match, ${Math.round(edit.confidence * 100)}% confidence`;
}

/** One evidence line per block/search: where it landed (or why it found no match). */
export function describeAssessment(
  assessment: BlockAssessment,
  index: number,
  document: string,
  noun = "Block"
): string {
  const { resolved, applies, overlaps } = assessment;
  const search = resolved.editBlock.searchText;

  if (!applies) {
    return `${noun} ${index + 1} → NO MATCH for "${snippet(search)}", ${closestParagraphDiagnosis(search, document)}`;
  }

  const location =
    overlaps.length > 0
      ? overlaps.join(" + ")
      : `lines ${resolved.startLine}–${resolved.endLine} (outside labeled regions)`;
  return `${noun} ${index + 1} → ${location} (${matchQuality(resolved)})`;
}

// ---------------------------------------------------------------------------
// Region-based evaluator for edit-block tests
// ---------------------------------------------------------------------------

const list = (items: string[]): string => items.join("; ");

/**
 * Shared evaluator for all annotation-suite edit tests. Reads the ground-truth
 * region spec from `testCase.regions` and the fixture from `testCase.document`.
 */
export function evaluateEditRegions(
  response: string,
  testCase: BenchmarkTestCase
): BenchmarkResult {
  const spec = testCase.regions;
  if (!spec) {
    return buildResultFromChecks(
      [check("fixture-valid", "Test case declares ground-truth regions", false, "missing `regions` spec, fixture bug, not a model failure")],
      [],
      ""
    );
  }

  const document = testCase.document;
  const targetSpan = locateRegion(document, spec.target);
  const forbiddenSpans = spec.forbidden.map((r) => ({ region: r, span: locateRegion(document, r) }));

  const missing = [
    ...(targetSpan ? [] : [spec.target.label]),
    ...forbiddenSpans.filter((f) => !f.span).map((f) => f.region.label),
  ];
  if (missing.length > 0) {
    return buildResultFromChecks(
      [check("fixture-valid", "Ground-truth regions exist in the document", false, `region text not found for: ${list(missing)}, fixture bug, not a model failure`)],
      [],
      ""
    );
  }

  const spans = [targetSpan as RegionSpan, ...forbiddenSpans.map((f) => f.span as RegionSpan)];
  const checks: EvaluationCheck[] = [];

  // 1. The model produced edit blocks at all.
  const { blocks } = parseEditBlocks(response);
  if (blocks.length === 0) {
    checks.push(
      check("produced-blocks", "Produced SEARCH/REPLACE edit blocks", false, "the response contains no edit blocks, the model answered in prose or used the wrong format")
    );
    return buildResultFromChecks(checks, [`Response: "${snippet(response, 200)}"`], "");
  }
  checks.push(check("produced-blocks", "Produced SEARCH/REPLACE edit blocks", true, `${blocks.length} block(s)`));

  const assessments = assessBlocks(blocks, document, spans);
  const evidence = assessments.map((a, i) => describeAssessment(a, i, document));

  // 2. Every block would actually apply to the document.
  const dead = assessments.filter((a) => !a.applies);
  checks.push(
    check(
      "blocks-apply",
      "Every block's search text matches the document",
      dead.length === 0,
      dead.length === 0
        ? `${assessments.length}/${assessments.length} blocks resolve`
        : `${dead.length} of ${assessments.length} block(s) would fail to apply, see evidence for the closest-paragraph diagnosis`
    )
  );

  // 3. (Informational) Matches were exact, not rescued by fuzzy matching.
  const fuzzy = assessments.filter((a) => a.applies && !a.exact);
  checks.push(
    check(
      "exact-match",
      "Search text matched the document exactly",
      fuzzy.length === 0,
      fuzzy.length === 0
        ? undefined
        : `${fuzzy.length} block(s) only matched via fuzzy/whitespace-normalized matching, works, but the model is not quoting the document precisely`,
      false
    )
  );

  // 4. At least one applying block edits the target region.
  const applying = assessments.filter((a) => a.applies);
  const hitsTarget = applying.some((a) => a.overlaps.includes(spec.target.label));
  const landedIn = [...new Set(applying.flatMap((a) => (a.overlaps.length > 0 ? a.overlaps : ["unlabeled text"])))];
  checks.push(
    check(
      "edits-target",
      `Edits the ${spec.target.label}`,
      hitsTarget,
      hitsTarget
        ? undefined
        : applying.length === 0
          ? "no block resolved against the document, so nothing reached the target"
          : `the edits landed in: ${list(landedIn)}`
    )
  );

  // 5. One check per protected region: nothing may touch it.
  for (const { region, span } of forbiddenSpans) {
    const offenders = assessments
      .map((a, i) => ({ a, i }))
      .filter(({ a }) => a.applies && a.overlaps.includes((span as RegionSpan).label));
    checks.push(
      check(
        `avoids-${region.label}`,
        `Leaves the ${region.label} untouched`,
        offenders.length === 0,
        offenders.length === 0
          ? undefined
          : `block ${offenders.map(({ i }) => i + 1).join(", ")} would rewrite it`
      )
    );
  }

  return buildResultFromChecks(
    checks,
    evidence,
    `Edited the ${spec.target.label} with ${applying.length} applying block(s) and left protected regions untouched.`
  );
}
