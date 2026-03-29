import { parseEditBlocks } from "../../editing/parseEditBlocks";
import {
  ACCEPTED_REPLACEMENT_TEXT,
  POST_EDIT_MARKER,
  LONG_REJECTED_KEYWORDS,
  LONG_ACCEPTED_P2_KEYWORDS,
  LONG_R2_INK_KEYWORDS,
  LONG_ATLAS_KEYWORDS,
} from "./testCases";
import type { BenchmarkResult, BenchmarkTestCase } from "./types";

// =========================================================================
// Helpers
// =========================================================================

function searchContains(searchText: string, keywords: string[]): boolean {
  const lower = searchText.toLowerCase();
  return keywords.some((kw) => lower.includes(kw.toLowerCase()));
}

function truncateBlock(block: { searchText: string }): string {
  return `SEARCH: "${block.searchText.slice(0, 80)}..."`;
}

// =========================================================================
// Short doc evaluators
// =========================================================================

/**
 * Test: "Respect rejected edits"
 * Model should target the fountain/children paragraph (rejected), not the opening (accepted).
 */
export function evaluateRejectedRework(
  response: string,
  _testCase: BenchmarkTestCase
): BenchmarkResult {
  const { blocks } = parseEditBlocks(response);
  const evidence: string[] = [];

  if (blocks.length === 0) {
    return { passed: false, reason: "Model did not produce any SEARCH/REPLACE blocks.", evidence: [response.slice(0, 200)] };
  }

  const targetsRejected = blocks.some((b) =>
    searchContains(b.searchText, ["children", "fountain", "pebbles", "old woman", "bench"])
  );
  const targetsAccepted = blocks.some((b) =>
    searchContains(b.searchText, ["dawn broke golden", "cobblestones", "whispered invitation"])
  );

  for (const b of blocks) evidence.push(truncateBlock(b));

  if (targetsRejected && !targetsAccepted) {
    return { passed: true, reason: "Correctly targeted the rejected fountain paragraph and left the accepted opening alone.", evidence };
  }
  if (targetsRejected && targetsAccepted) {
    return { passed: false, reason: "Targeted the rejected paragraph but also re-edited the already-accepted opening.", evidence };
  }
  return { passed: false, reason: "Did not target the rejected fountain paragraph.", evidence };
}

/**
 * Test: "Don't re-propose accepted edits"
 * Model should target the market-day paragraph, not re-do accepted content.
 */
export function evaluateNoRepropose(
  response: string,
  _testCase: BenchmarkTestCase
): BenchmarkResult {
  const { blocks } = parseEditBlocks(response);
  const evidence: string[] = [];

  if (blocks.length === 0) {
    return { passed: false, reason: "Model did not produce any SEARCH/REPLACE blocks.", evidence: [response.slice(0, 200)] };
  }

  const targetsMarket = blocks.some((b) =>
    searchContains(b.searchText, ["church bell", "merchants", "market day", "stalls", "eastern wall"])
  );
  const reproposesAccepted = blocks.some((b) =>
    searchContains(b.searchText, [ACCEPTED_REPLACEMENT_TEXT]) &&
    b.replaceText.toLowerCase() !== b.searchText.toLowerCase()
  );

  for (const b of blocks) evidence.push(truncateBlock(b));

  if (targetsMarket && !reproposesAccepted) {
    return { passed: true, reason: "Correctly targeted the market-day paragraph without re-proposing accepted edits.", evidence };
  }
  if (reproposesAccepted) {
    return { passed: false, reason: "Re-proposed changes to already-accepted content.", evidence };
  }
  return { passed: false, reason: "Did not target the requested market-day paragraph.", evidence };
}

/**
 * Test: "Awareness of current document state"
 * Model should distinguish accepted vs rejected when describing document state.
 */
export function evaluateStateAwareness(
  response: string,
  _testCase: BenchmarkTestCase
): BenchmarkResult {
  const lower = response.toLowerCase();
  const evidence: string[] = [];

  const mentionsAccepted =
    lower.includes("accepted") || lower.includes("applied") ||
    lower.includes("first change") || lower.includes("opening paragraph") ||
    lower.includes(POST_EDIT_MARKER.toLowerCase().slice(0, 30));

  const mentionsRejected =
    lower.includes("rejected") || lower.includes("not applied") ||
    lower.includes("unchanged") || lower.includes("original") ||
    lower.includes("second change") || lower.includes("fountain");

  if (mentionsAccepted) evidence.push("References accepted/applied changes");
  if (mentionsRejected) evidence.push("References rejected/unchanged content");

  const sentences = response.split(/[.!?]\s+/);
  for (const s of sentences) {
    const sl = s.toLowerCase();
    if (sl.includes("accept") || sl.includes("reject") || sl.includes("applied") || sl.includes("unchanged")) {
      evidence.push(`"${s.trim().slice(0, 120)}..."`);
      break;
    }
  }

  if (mentionsAccepted && mentionsRejected) {
    return { passed: true, reason: "Correctly distinguished between accepted and rejected edits.", evidence };
  }
  if (mentionsAccepted) {
    return { passed: false, reason: "Acknowledged accepted edits but did not mention the unchanged fountain paragraph.", evidence };
  }
  return { passed: false, reason: "Did not clearly distinguish between accepted and rejected edit outcomes.", evidence };
}

// =========================================================================
// Long doc evaluators
// =========================================================================

/**
 * Test: "Long document — edit precision"
 * Model should rework the rejected midmorning paragraph (P4) without touching accepted or untouched paragraphs.
 */
export function evaluateLongDocPrecision(
  response: string,
  _testCase: BenchmarkTestCase
): BenchmarkResult {
  const { blocks } = parseEditBlocks(response);
  const evidence: string[] = [];

  if (blocks.length === 0) {
    return { passed: false, reason: "Model did not produce any SEARCH/REPLACE blocks.", evidence: [response.slice(0, 200)] };
  }

  const targetsRejectedP4 = blocks.some((b) =>
    searchContains(b.searchText, LONG_REJECTED_KEYWORDS)
  );
  const targetsAcceptedP2 = blocks.some((b) =>
    searchContains(b.searchText, LONG_ACCEPTED_P2_KEYWORDS)
  );
  const targetsAtlas = blocks.some((b) =>
    searchContains(b.searchText, LONG_ATLAS_KEYWORDS)
  );

  for (const b of blocks) evidence.push(truncateBlock(b));

  if (targetsRejectedP4 && !targetsAcceptedP2 && !targetsAtlas) {
    return { passed: true, reason: "Correctly targeted the rejected midmorning paragraph without disturbing accepted or untouched content.", evidence };
  }
  if (!targetsRejectedP4) {
    return { passed: false, reason: "Did not target the rejected midmorning paragraph.", evidence };
  }
  if (targetsAcceptedP2) {
    return { passed: false, reason: "Targeted the rejected paragraph but also re-edited already-accepted content.", evidence };
  }
  return { passed: false, reason: "Targeted the rejected paragraph but also edited unrelated untouched paragraphs.", evidence };
}

/**
 * Test: "Multi-round edit continuity"
 * After 2 rounds, model should target the still-rejected P4 or untouched paragraphs, not any accepted content.
 */
export function evaluateMultiRoundContinuity(
  response: string,
  _testCase: BenchmarkTestCase
): BenchmarkResult {
  const { blocks } = parseEditBlocks(response);
  const evidence: string[] = [];

  if (blocks.length === 0) {
    return { passed: false, reason: "Model did not produce any SEARCH/REPLACE blocks.", evidence: [response.slice(0, 200)] };
  }

  // Should target the midmorning paragraph (still original / previously rejected)
  const targetsRejectedP4 = blocks.some((b) =>
    searchContains(b.searchText, LONG_REJECTED_KEYWORDS)
  );
  // Should NOT touch accepted P2, P5, or P7
  const targetsAcceptedP2 = blocks.some((b) =>
    searchContains(b.searchText, LONG_ACCEPTED_P2_KEYWORDS)
  );
  const targetsAcceptedR2Ink = blocks.some((b) =>
    searchContains(b.searchText, LONG_R2_INK_KEYWORDS)
  );

  for (const b of blocks) evidence.push(truncateBlock(b));

  const touchesAccepted = targetsAcceptedP2 || targetsAcceptedR2Ink;

  if (targetsRejectedP4 && !touchesAccepted) {
    return { passed: true, reason: "Correctly targeted the still-rejected midmorning paragraph across 2 rounds without revisiting accepted edits.", evidence };
  }
  if (!targetsRejectedP4) {
    return { passed: false, reason: "Did not target the midmorning paragraph that was still in its original form.", evidence };
  }
  return { passed: false, reason: "Targeted the midmorning paragraph but also re-edited content accepted in a previous round.", evidence };
}

/**
 * Test: "Long conversation — context retention"
 * After extended conversation, model should target the atlas/deadline paragraph (P8) as requested.
 */
export function evaluateConversationContext(
  response: string,
  _testCase: BenchmarkTestCase
): BenchmarkResult {
  const { blocks } = parseEditBlocks(response);
  const evidence: string[] = [];

  if (blocks.length === 0) {
    return { passed: false, reason: "Model did not produce any SEARCH/REPLACE blocks.", evidence: [response.slice(0, 200)] };
  }

  const targetsAtlas = blocks.some((b) =>
    searchContains(b.searchText, LONG_ATLAS_KEYWORDS)
  );
  const targetsAcceptedP2 = blocks.some((b) =>
    searchContains(b.searchText, LONG_ACCEPTED_P2_KEYWORDS)
  );
  const targetsAcceptedR2Ink = blocks.some((b) =>
    searchContains(b.searchText, LONG_R2_INK_KEYWORDS)
  );

  for (const b of blocks) evidence.push(truncateBlock(b));

  const touchesAccepted = targetsAcceptedP2 || targetsAcceptedR2Ink;

  if (targetsAtlas && !touchesAccepted) {
    return { passed: true, reason: "Correctly targeted the atlas/deadline paragraph after extended conversation without revisiting accepted edits.", evidence };
  }
  if (!targetsAtlas) {
    return { passed: false, reason: "Did not target the requested atlas/deadline paragraph.", evidence };
  }
  return { passed: false, reason: "Targeted the atlas paragraph but also re-edited previously accepted content.", evidence };
}

// =========================================================================
// Control
// =========================================================================

/**
 * Control: same as "Respect rejected" but without annotations.
 */
export function evaluateControlNoAnnotations(
  response: string,
  _testCase: BenchmarkTestCase
): BenchmarkResult {
  const { blocks } = parseEditBlocks(response);
  const evidence: string[] = [];

  if (blocks.length === 0) {
    return { passed: false, reason: "Model did not produce any SEARCH/REPLACE blocks (no annotations, no edits).", evidence: [response.slice(0, 200)] };
  }

  const targetsRejected = blocks.some((b) =>
    searchContains(b.searchText, ["children", "fountain", "pebbles", "old woman"])
  );
  const targetsAccepted = blocks.some((b) =>
    searchContains(b.searchText, ["dawn broke golden", "cobblestones"])
  );

  for (const b of blocks) evidence.push(truncateBlock(b));

  if (targetsRejected && !targetsAccepted) {
    return { passed: true, reason: "Control: Model correctly inferred the rejected edit even without annotations (may rely on user message context).", evidence };
  }
  return { passed: false, reason: "Control: Without annotations, the model did not correctly target the rejected paragraph.", evidence };
}
