import { describe, it, expect } from "vitest";
import { resolveEdits } from "../../../src/editing/diffEngine";
import type { EditBlock } from "../../../src/editing/editTypes";

function block(searchText: string, replaceText = "REPLACED"): EditBlock {
  return { id: "b0", searchText, replaceText, rawBlock: "" };
}

function resolveOne(doc: string, searchText: string) {
  const [r] = resolveEdits([block(searchText)], doc, { contextLines: 1, minConfidence: 0.7 });
  return r;
}

describe("resolveEdits, match type", () => {
  it("labels a verbatim hit as an exact match", () => {
    const r = resolveOne("The quick brown fox.", "quick brown");
    expect(r.matchType).toBe("exact");
    expect(r.confidence).toBe(1.0);
  });

  it("labels a spacing-only hit as a whitespace match", () => {
    // Same words, collapsed extra spaces, tier 2.
    const r = resolveOne("The quick    brown fox.", "quick brown");
    expect(r.matchType).toBe("whitespace");
  });

  it("labels a close-but-not-identical hit as a fuzzy match", () => {
    // Two substitutions across a ~30-char line: above the per-line gate (0.85) but
    // below the whitespace tier (0.95), tier 3 fuzzy.
    const r = resolveOne(
      "The quack brown fix jumps over.",
      "The quick brown fox jumps over.",
    );
    expect(r.matchType).toBe("fuzzy");
    expect(r.confidence).toBeGreaterThan(0);
    expect(r.confidence).toBeLessThan(0.95);
  });

  it("labels a total miss as no match", () => {
    const r = resolveOne("Entirely unrelated content here.", "the flux capacitor hums");
    expect(r.matchType).toBe("none");
    expect(r.confidence).toBe(0);
  });

  it("flags a near miss when the closest text was similar but below threshold", () => {
    // ~60% similar line: rejected by the per-line gate, but close enough to nudge
    // "fix spelling/spacing" rather than "re-read".
    const r = resolveOne("The quirky brawn box.", "The quick brown fox.");
    expect(r.matchType).toBe("none");
    expect(r.nearMiss).toBe(true);
  });

  it("does not flag a near miss when nothing resembles the search text", () => {
    const r = resolveOne("Totally different sentence.", "zzz qqq vvv");
    expect(r.matchType).toBe("none");
    expect(r.nearMiss).toBe(false);
  });
});

describe("resolveEdits, CRLF documents (P1-2)", () => {
  it("resolves an LF search against a CRLF document as an exact match", () => {
    // A Windows-authored note has \r\n; the model emits \n. The \r is an encoding
    // artifact, not an intentional whitespace difference, so this must resolve at
    // Tier 1, not fall through to fuzzy (which mislabels a byte-identical edit).
    const doc = "Line one.\r\nLine two.\r\nLine three.";
    const r = resolveOne(doc, "Line one.\nLine two.");
    expect(r.matchType).toBe("exact");
    expect(r.confidence).toBe(1.0);
  });

  it("returns LF-only matchedText for a CRLF document (no \\r leaks downstream)", () => {
    // matchedText feeds applyHunksLive (vs the raw file) AND the in-note CM6 overlay
    // (vs the editor's LF-only doc); a stray \r breaks the overlay anchor and mixes
    // endings on apply.
    const doc = "Line one.\r\nLine two.\r\nLine three.";
    const r = resolveOne(doc, "Line one.\nLine two.");
    expect(r.matchedText).toBe("Line one.\nLine two.");
    expect(r.matchedText).not.toContain("\r");
  });

  it("resolves an LF search against a CRLF document with collapsed spacing as whitespace", () => {
    // Double space → not exact, but the whitespace tier should still catch it once the
    // \r no longer defeats the collapse.
    const doc = "Line  one.\r\nLine two.\r\nLine three.";
    const r = resolveOne(doc, "Line one.\nLine two.");
    expect(r.matchType).toBe("whitespace");
    expect(r.matchedText).not.toContain("\r");
  });

  it("strips \\r from context lines of a CRLF document", () => {
    const doc = "Intro line.\r\nLine one.\r\nLine two.\r\nOutro line.";
    const r = resolveOne(doc, "Line one.\nLine two.");
    for (const line of [...r.contextBefore, ...r.contextAfter]) {
      expect(line).not.toContain("\r");
    }
  });
});
