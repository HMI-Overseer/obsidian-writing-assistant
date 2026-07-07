import { describe, it, expect } from "vitest";
import {
  boundToolResult,
  captureStepFields,
  formatResultDigest,
  RESULT_TRUNCATION_MARKER,
  TOOL_RESULT_CHAR_LIMIT,
} from "../../../src/tools/resultDigest";
import { SEMANTIC_SEARCH_UNAVAILABLE_MESSAGE } from "../../../src/tools/vault/definition";

/**
 * Phase-2 capture contract for the claudecode cold rebuild
 * (docs/work/issues/claude-code-cold-rebuild-fidelity.md §A.1, question 9).
 * The digest is pointers only, never scores or chunk content; the record is a bounded
 * copy of the full result.
 */

describe("boundToolResult", () => {
  it("stores a result under the cap whole", () => {
    const short = "No results found for query.";
    expect(boundToolResult(short)).toBe(short);
  });

  it("truncates an oversized result at the cap with a marker", () => {
    const big = "x".repeat(TOOL_RESULT_CHAR_LIMIT + 3000);
    const bounded = boundToolResult(big);
    expect(bounded).toBe("x".repeat(TOOL_RESULT_CHAR_LIMIT) + RESULT_TRUNCATION_MARKER);
    expect(bounded.startsWith(big.slice(0, TOOL_RESULT_CHAR_LIMIT))).toBe(true);
    expect(bounded.endsWith(RESULT_TRUNCATION_MARKER)).toBe(true);
  });

  it("keeps a result exactly at the cap whole (no marker)", () => {
    const exact = "y".repeat(TOOL_RESULT_CHAR_LIMIT);
    expect(boundToolResult(exact)).toBe(exact);
  });
});

describe("formatResultDigest, semantic_search four-outcome contract (§A.1)", () => {
  it("invalid-args: a blank-query failure digests as FAILED with the first sentence", () => {
    // The handler's blank-query failure (toolFailure invalid-args).
    const content = "Error: query is required. check the arguments against the tool's schema and retry.";
    expect(formatResultDigest("semantic_search", { query: "  " }, { content, isError: true })).toBe(
      '[semantic_search: "", FAILED: query is required]',
    );
  });

  it("unavailable: a no-backend failure digests as FAILED with the curated first sentence", () => {
    const content = SEMANTIC_SEARCH_UNAVAILABLE_MESSAGE["no-backend"];
    const digest = formatResultDigest("semantic_search", { query: "Mira's oath" }, { content, isError: true });
    expect(digest).toBe(
      '[semantic_search: "Mira\'s oath", FAILED: Semantic search did not run: no embedding model ' +
        "is configured, so this vault has no semantic index and one cannot be built]",
    );
  });

  it("empty result: ran fine, found nothing, digests as no results", () => {
    const content =
      'No results found for query: "oath". Retry once with a more specific query, or use search_content for an exact-string lookup.';
    expect(formatResultDigest("semantic_search", { query: "oath" }, { content })).toBe(
      '[semantic_search: "oath", no results]',
    );
  });

  it("hits: digests as pointers only (path > heading), never scores or chunk content", () => {
    const content =
      'Search results for: "oath"\n\n' +
      "[Chapters/ch1.md > Vows] (score: 0.812)\nMira swore the oath at dawn.\n\n" +
      "[Chapters/ch2.md] (score: 0.771)\nThe oath was later broken.";
    expect(formatResultDigest("semantic_search", { query: "oath" }, { content })).toBe(
      '[semantic_search: "oath", surfaced: Chapters/ch1.md > Vows; Chapters/ch2.md]',
    );
  });
});

describe("formatResultDigest hit bounds (§A.1)", () => {
  it("caps at 8 pointers, ~500 chars, and never leaks scores or chunk content", () => {
    const blocks: string[] = ['Search results for: "wide"', ""];
    for (let i = 0; i < 12; i++) {
      blocks.push(`[Chapters/really-long-chapter-name-number-${i}.md > A Fairly Long Heading ${i}] (score: 0.${i}00)`);
      blocks.push(`Secret chunk body ${i} that must never appear in the digest.`);
      blocks.push("");
    }
    const digest = formatResultDigest("semantic_search", { query: "wide" }, { content: blocks.join("\n") })!;

    expect(digest).not.toContain("score");
    expect(digest).not.toContain("Secret chunk body");
    // At most 8 pointers listed (pointers are "; "-separated inside "surfaced: ").
    const surfaced = digest.slice(digest.indexOf("surfaced: ") + "surfaced: ".length, -1);
    const pointers = surfaced.split("; ").filter((p) => p !== "…");
    expect(pointers.length).toBeLessThanOrEqual(8);
    expect(digest.length).toBeLessThanOrEqual(560);
  });
});

describe("formatResultDigest, the other discovery tools (same shape)", () => {
  it("search_files hits digest as its matched paths", () => {
    const content = 'Notes matching "*oath*" in vault (2):\nChapters/ch1.md\nChapters/ch2.md';
    expect(formatResultDigest("search_files", { pattern: "*oath*" }, { content })).toBe(
      '[search_files: "*oath*", surfaced: Chapters/ch1.md; Chapters/ch2.md]',
    );
  });

  it("get_backlinks hits digest as the linking paths", () => {
    const content = 'Notes linking to "Characters/Mira.md" (2):\nChapters/ch1.md\nChapters/ch3.md';
    expect(formatResultDigest("get_backlinks", { path: "Characters/Mira.md" }, { content })).toBe(
      '[get_backlinks: "Characters/Mira.md", surfaced: Chapters/ch1.md; Chapters/ch3.md]',
    );
  });

  it("find_notes_by_tag hits digest as the tagged paths", () => {
    const content = 'Notes tagged "#oath" (1):\nChapters/ch1.md';
    expect(formatResultDigest("find_notes_by_tag", { tag: "#oath" }, { content })).toBe(
      '[find_notes_by_tag: "#oath", surfaced: Chapters/ch1.md]',
    );
  });

  it("search_content hits digest as the distinct matched paths (grep + context shapes)", () => {
    const grep = 'Matches for text "oath" (2):\nChapters/ch1.md:12: he swore an oath\nChapters/ch1.md:40: the oath held';
    expect(formatResultDigest("search_content", { query: "oath" }, { content: grep })).toBe(
      '[search_content: "oath", surfaced: Chapters/ch1.md]',
    );
    const withContext = 'Matches for text "oath" (1):\n[Chapters/ch2.md]\n> 5: the oath';
    expect(formatResultDigest("search_content", { query: "oath" }, { content: withContext })).toBe(
      '[search_content: "oath", surfaced: Chapters/ch2.md]',
    );
  });

  it("an empty result on any discovery tool digests as no results", () => {
    expect(
      formatResultDigest("search_files", { pattern: "*none*" }, {
        content: 'No notes found matching pattern "*none*" in vault. Loosen the glob.',
      }),
    ).toBe('[search_files: "*none*", no results]');
  });
});

describe("formatResultDigest, non-discovery tools get no digest", () => {
  it("returns undefined for path -> content and mutation tools", () => {
    for (const name of ["read_file", "read_section", "list_directory", "move_file", "propose_edit"]) {
      expect(formatResultDigest(name, { path: "x.md" }, { content: "anything" })).toBeUndefined();
    }
  });
});

describe("captureStepFields", () => {
  it("carries a reviewed op's disposition (a decline is otherwise invisible)", () => {
    expect(
      captureStepFields(
        "create_directory",
        { path: "Drafts/Arcs" },
        { content: "Declined by user, \"Drafts/Arcs\" was not changed.", isError: false, disposition: "declined" },
      ),
    ).toMatchObject({ disposition: "declined" });
  });

  it("captures each disposition value the review can return", () => {
    for (const disposition of ["applied", "declined", "failed", "auto-applied", "satisfied"] as const) {
      expect(
        captureStepFields("move_file", { from: "a", to: "b" }, { content: "outcome text", disposition }),
      ).toMatchObject({ disposition });
    }
  });

  it("captures a digest + bounded record for a discovery result", () => {
    const content = 'Search results for: "oath"\n\n[Chapters/ch1.md] (score: 0.9)\nbody';
    const fields = captureStepFields("semantic_search", { query: "oath" }, { content });
    expect(fields.resultDigest).toBe('[semantic_search: "oath", surfaced: Chapters/ch1.md]');
    expect(fields.resultRecord).toBe(content);
    expect(fields.disposition).toBeUndefined();
  });

  it("bounds the stored record of an oversized result", () => {
    const big = "z".repeat(TOOL_RESULT_CHAR_LIMIT + 500);
    const fields = captureStepFields("read_file", { path: "big.md" }, { content: big });
    expect(fields.resultRecord).toBe("z".repeat(TOOL_RESULT_CHAR_LIMIT) + RESULT_TRUNCATION_MARKER);
    expect(fields.resultDigest).toBeUndefined();
  });

  it("returns nothing for a call with no content, disposition, or digest", () => {
    expect(captureStepFields("think", {}, { content: "" })).toEqual({});
  });
});
