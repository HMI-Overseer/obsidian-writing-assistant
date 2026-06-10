import { describe, it, expect } from "vitest";
import {
  evaluateEditRegions,
  closestParagraphDiagnosis,
} from "../../../src/settings/benchmark/editScoring";
import {
  getTestCases,
  SHORT_P1_ACCEPTED,
  SHORT_P2_ORIGINAL,
} from "../../../src/settings/benchmark/testCases";
import type { BenchmarkTestCase, EvaluationCheck } from "../../../src/settings/benchmark/types";

function findCase(id: string): BenchmarkTestCase {
  const tc = getTestCases().find((t) => t.id === id);
  if (!tc) throw new Error(`Missing test case ${id}`);
  return tc;
}

function getCheck(checks: EvaluationCheck[] | undefined, id: string): EvaluationCheck {
  const c = checks?.find((x) => x.id === id);
  if (!c) throw new Error(`Missing check ${id}`);
  return c;
}

function block(search: string, replace: string): string {
  return `<<<<<<< SEARCH\n${search}\n=======\n${replace}\n>>>>>>> REPLACE`;
}

describe("fixture integrity", () => {
  it("every region's text is an exact substring of its test document", () => {
    for (const tc of getTestCases()) {
      if (!tc.regions) continue;
      expect(tc.document, `${tc.id}: target "${tc.regions.target.label}"`).toContain(tc.regions.target.text);
      for (const region of tc.regions.forbidden) {
        expect(tc.document, `${tc.id}: forbidden "${region.label}"`).toContain(region.text);
      }
    }
  });

  it("every edit-block test case declares regions", () => {
    for (const tc of getTestCases()) {
      if (tc.id === "state-awareness") continue;
      expect(tc.regions, tc.id).toBeDefined();
    }
  });
});

describe("evaluateEditRegions", () => {
  const respectRejected = findCase("respect-rejected");

  it("passes when an exact block targets the rejected paragraph", () => {
    const response =
      "Here's a new take on the fountain scene:\n\n" +
      block(SHORT_P2_ORIGINAL, "By the fountain, children skipped stones across the shallow basin.");
    const result = evaluateEditRegions(response, respectRejected);

    expect(result.passed).toBe(true);
    expect(getCheck(result.checks, "exact-match").passed).toBe(true);
    expect(getCheck(result.checks, "edits-target").passed).toBe(true);
  });

  it("fails when the response contains no edit blocks", () => {
    const result = evaluateEditRegions("Sure! What would you like me to change?", respectRejected);

    expect(result.passed).toBe(false);
    expect(getCheck(result.checks, "produced-blocks").passed).toBe(false);
  });

  it("fails when the search text paraphrases the document, with a diagnosis", () => {
    const response = block(
      "Children played near the fountain, throwing stones into the water while an old woman watched.",
      "New text."
    );
    const result = evaluateEditRegions(response, respectRejected);

    expect(result.passed).toBe(false);
    expect(getCheck(result.checks, "blocks-apply").passed).toBe(false);
    expect(result.evidence.join("\n")).toContain("NO MATCH");
    expect(result.evidence.join("\n")).toContain("word overlap");
  });

  it("fails when an additional block rewrites the accepted paragraph", () => {
    const response =
      block(SHORT_P2_ORIGINAL, "New fountain text.") +
      "\n\n" +
      block(SHORT_P1_ACCEPTED, "A different opening.");
    const result = evaluateEditRegions(response, respectRejected);

    expect(result.passed).toBe(false);
    expect(getCheck(result.checks, "edits-target").passed).toBe(true);
    expect(result.reason).toContain("accepted opening paragraph");
  });

  it("fails when the only block edits the wrong region, reporting where it landed", () => {
    const response = block(SHORT_P1_ACCEPTED, "A different opening.");
    const result = evaluateEditRegions(response, respectRejected);

    expect(result.passed).toBe(false);
    expect(getCheck(result.checks, "edits-target").passed).toBe(false);
    expect(getCheck(result.checks, "edits-target").detail).toContain("accepted opening paragraph");
  });

  it("passes on a whitespace-normalized match but flags the informational exact-match check", () => {
    const sloppySearch = SHORT_P2_ORIGINAL.replace(/ /g, "  ");
    const result = evaluateEditRegions(block(sloppySearch, "New fountain text."), respectRejected);

    expect(result.passed).toBe(true);
    expect(getCheck(result.checks, "exact-match").passed).toBe(false);
    expect(getCheck(result.checks, "exact-match").required).toBe(false);
  });

  it("reports a fixture error instead of a model failure when regions are missing", () => {
    const broken = { ...respectRejected, regions: undefined };
    const result = evaluateEditRegions("anything", broken);

    expect(result.passed).toBe(false);
    expect(result.reason).toContain("fixture bug");
  });
});

describe("closestParagraphDiagnosis", () => {
  const doc = findCase("respect-rejected").document;

  it("names the most similar paragraph for a paraphrase", () => {
    const diagnosis = closestParagraphDiagnosis(
      "Children gathered near the fountain, tossing stones into the water.",
      doc
    );
    expect(diagnosis).toContain("paragraph 2");
    expect(diagnosis).toContain("paraphrased");
  });

  it("reports invented content when nothing is similar", () => {
    const diagnosis = closestParagraphDiagnosis(
      "The dragon soared over the mountains, breathing emerald fire.",
      doc
    );
    expect(diagnosis).toContain("invented");
  });
});
