import { describe, it, expect } from "vitest";
import { resolveEdits, findEditMatch } from "../../../src/editing/diffEngine";
import { parseEditBlocks } from "../../../src/editing/parseEditBlocks";
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

describe("findEditMatch (propose_edit preflight)", () => {
  it("returns an exact match offset for a verbatim search", () => {
    const doc = "# Title\n\nThe quick brown fox.";
    const m = findEditMatch("quick brown", doc);
    expect(m).not.toBeNull();
    expect(m?.matchType).toBe("exact");
    expect(doc.slice(m!.offset, m!.offset + "quick brown".length)).toBe("quick brown");
  });

  it("matches a search that differs only in whitespace (tabs vs spaces)", () => {
    const doc = "# Title\n\n\tHe drew the blade.";
    const m = findEditMatch("  He drew the blade.", doc);
    expect(m).not.toBeNull();
    expect(m?.matchType).toBe("whitespace");
  });

  it("matches across a CRLF document with an LF search", () => {
    const m = findEditMatch("beta\ngamma", "alpha\r\nbeta\r\ngamma");
    expect(m).not.toBeNull();
  });

  it("does not preflight fuzzy matches (a wording miss stays a miss)", () => {
    // resolveEdits would rescue this via tier-3 fuzzy, but the preflight stops at
    // whitespace so the model is nudged to quote the document exactly.
    expect(findEditMatch("The quick brown fox jumps over.", "The quack brown fix jumps over.")).toBeNull();
  });

  it("returns null for an empty search", () => {
    expect(findEditMatch("", "anything")).toBeNull();
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

describe("resolveEdits, duplicate-occurrence anchoring (symptom C)", () => {
  const DUP_DOC = "She nodded.\nHe spoke.\nShe nodded.\nThey left.\nShe nodded.\n";

  it("flags a non-unique exact match with its occurrence count", () => {
    // The model's search text appears three times; the engine can't know which one the
    // model meant, so it surfaces the multiplicity for review instead of silently
    // anchoring the first and hoping. The match stays a clean exact (the string IS
    // there verbatim); ambiguity is a *location* signal, not a match-quality one.
    const r = resolveOne(DUP_DOC, "She nodded.");
    expect(r.matchType).toBe("exact");
    expect(r.confidence).toBe(1.0);
    expect(r.occurrenceCount).toBe(3);
  });

  it("still anchors the first occurrence deterministically", () => {
    // Surfacing ambiguity must not change which occurrence is picked (always the
    // first), only flag that the pick is a guess. Determinism is the whole point of
    // the min-viable fix.
    const r = resolveOne(DUP_DOC, "She nodded.");
    expect(r.matchOffset).toBe(DUP_DOC.indexOf("She nodded."));
    expect(r.startLine).toBe(1);
  });

  it("leaves occurrenceCount unset for a unique exact match", () => {
    const r = resolveOne("Only one match here.", "one match");
    expect(r.matchType).toBe("exact");
    expect(r.occurrenceCount).toBeUndefined();
  });

  it("does not flag multiplicity on the whitespace or fuzzy tiers (exact-tier only)", () => {
    // The min-viable scope is Tier 1 exact, where first-indexOf anchoring and
    // determinism are cleanly defined. Non-exact tiers carry no occurrence count.
    const ws = resolveOne("The quick    brown fox.", "quick brown");
    expect(ws.matchType).toBe("whitespace");
    expect(ws.occurrenceCount).toBeUndefined();

    const fuzzy = resolveOne(
      "The quack brown fix jumps over.",
      "The quick brown fox jumps over.",
    );
    expect(fuzzy.matchType).toBe("fuzzy");
    expect(fuzzy.occurrenceCount).toBeUndefined();
  });

  it("counts non-overlapping occurrences", () => {
    // The count is the number of distinct anchor positions an edit could target, so
    // occurrences are counted non-overlapping.
    const r = resolveOne("ping\npong\nping\n", "ping");
    expect(r.occurrenceCount).toBe(2);
  });
});

describe("resolveEdits, empty search guard (P1-8)", () => {
  it("returns no match for an empty search instead of a phantom exact at offset 0", () => {
    // indexOf("") === 0, so without the guard an empty search resolves as a confident
    // exact match at the top of the file and prepends replaceText, a silent corruption.
    const r = resolveOne("Some real document content.", "");
    expect(r.matchType).toBe("none");
    expect(r.confidence).toBe(0);
    expect(r.matchOffset).toBe(-1);
  });

  it("returns no match for a whitespace-only search (single space)", () => {
    // A lone space would otherwise hit the first space in the document as a bogus
    // exact match and replace it; a whitespace-only anchor is the model dropping its
    // search, not a real location.
    const r = resolveOne("Some real document.", " ");
    expect(r.matchType).toBe("none");
    expect(r.confidence).toBe(0);
  });

  it("returns no match for an empty search via the regex-parse path", () => {
    // The SEARCH/REPLACE parser produces toolName-less blocks; an empty SEARCH section
    // reaches the engine directly with no upstream guard, so resolveOneBlock must fence it.
    const { blocks } = parseEditBlocks(
      "<<<<<<< SEARCH\n\n=======\nnew content\n>>>>>>> REPLACE",
    );
    expect(blocks).toHaveLength(1);
    expect(blocks[0].searchText).toBe("");
    const [r] = resolveEdits(blocks, "Some real document content.", {
      contextLines: 1,
      minConfidence: 0.7,
    });
    expect(r.matchType).toBe("none");
    expect(r.confidence).toBe(0);
  });

  it("still resolves an insert-intent block (frontmatter) with empty search at the top", () => {
    // A structural insert legitimately carries an empty search to mean "insert at top"
    // (e.g. frontmatter into a note that has none). The guard is gated on toolName so
    // this stays a confident insert at offset 0, not a no-match.
    const insertBlock: EditBlock = {
      id: "fm0",
      searchText: "",
      replaceText: "---\nstatus: draft\n---",
      rawBlock: "",
      toolName: "update_frontmatter",
    };
    const [r] = resolveEdits([insertBlock], "First line of the note.\n", {
      contextLines: 1,
      minConfidence: 0.7,
    });
    expect(r.matchType).toBe("exact");
    expect(r.matchOffset).toBe(0);
    expect(r.confidence).toBe(1.0);
  });
});
