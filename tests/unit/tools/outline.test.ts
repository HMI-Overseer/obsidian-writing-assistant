import { describe, test, expect } from "vitest";
import {
  buildOutline,
  sectionLines,
  matchSection,
  countWords,
  type RawHeading,
  type OutlineHeading,
} from "../../../src/tools/vault/outline";

/** Shorthand for a HeadingCache-shaped heading at a given 0-indexed line. */
const h = (heading: string, level: number, line: number): RawHeading => ({
  heading,
  level,
  position: { start: { line } },
});

describe("buildOutline", () => {
  test("builds full breadcrumb headingPaths from the heading stack", () => {
    const outline = buildOutline(
      [h("Act I", 1, 0), h("Chapter 1", 2, 2), h("The Duel", 3, 5), h("Chapter 2", 2, 10)],
      15,
    );
    expect(outline.map((o) => o.headingPath)).toEqual([
      "Act I",
      "Act I > Chapter 1",
      "Act I > Chapter 1 > The Duel",
      "Act I > Chapter 2",
    ]);
    expect(outline.map((o) => o.depth)).toEqual([1, 2, 3, 2]);
  });

  test("a section spans up to the next heading of equal-or-higher level", () => {
    const outline = buildOutline(
      [h("Act I", 1, 0), h("Chapter 1", 2, 2), h("Chapter 2", 2, 5), h("Act II", 1, 10)],
      15,
    );
    expect(outline[0]).toMatchObject({ headingPath: "Act I", startLine: 0, endLine: 9 });
    expect(outline[1]).toMatchObject({ headingPath: "Act I > Chapter 1", startLine: 2, endLine: 4 });
    expect(outline[2]).toMatchObject({ headingPath: "Act I > Chapter 2", startLine: 5, endLine: 9 });
    expect(outline[3]).toMatchObject({ headingPath: "Act II", startLine: 10, endLine: 14 });
  });

  test("a deeper first heading still builds a valid path (skipped levels)", () => {
    const outline = buildOutline([h("Deep", 3, 0)], 3);
    expect(outline[0].headingPath).toBe("Deep");
    expect(outline[0].depth).toBe(3);
    expect(outline[0].endLine).toBe(2);
  });

  test("returns an empty list for a note with no headings", () => {
    expect(buildOutline([], 5)).toEqual([]);
  });
});

describe("sectionLines", () => {
  const heading = (startLine: number, endLine: number): OutlineHeading => ({
    depth: 1,
    heading: "A",
    headingPath: "A",
    startLine,
    endLine,
  });

  test("returns the heading line through the section end, trimming trailing blanks", () => {
    const lines = ["# A", "body 1", "body 2", "", "# B", "..."];
    expect(sectionLines(lines, heading(0, 3))).toEqual(["# A", "body 1", "body 2"]);
  });

  test("keeps the heading line even when the section is otherwise empty", () => {
    const lines = ["# A", "", "# B"];
    expect(sectionLines(lines, heading(0, 1))).toEqual(["# A"]);
  });
});

describe("countWords", () => {
  test("counts whitespace-separated words", () => {
    expect(countWords("the duel was fierce")).toBe(4);
  });

  test("strips markdown heading markers so '##' is not counted as a word", () => {
    expect(countWords("## Chapter 1\nthe duel was fierce")).toBe(6);
  });

  test("is zero for empty or whitespace-only text", () => {
    expect(countWords("")).toBe(0);
    expect(countWords("   \n  ")).toBe(0);
  });
});

describe("matchSection", () => {
  // Duplicate leaves on purpose: "Chapter 1" and "The Duel" each appear twice.
  const outline = buildOutline(
    [
      h("Act I", 1, 0),
      h("Chapter 1", 2, 2),
      h("The Duel", 3, 5),
      h("Act II", 1, 10),
      h("Chapter 1", 2, 12),
      h("The Duel", 3, 15),
    ],
    20,
  );

  test("resolves an exact full headingPath", () => {
    const m = matchSection(outline, "Act I > Chapter 1 > The Duel");
    expect(m.kind).toBe("found");
    expect(m.kind === "found" && m.heading.startLine).toBe(5);
  });

  test("resolves a unique leaf without its ancestors", () => {
    const m = matchSection(outline, "Act I");
    expect(m.kind).toBe("found");
    expect(m.kind === "found" && m.heading.startLine).toBe(0);
  });

  test("narrows a duplicated leaf with a deeper partial path", () => {
    const m = matchSection(outline, "Act II > Chapter 1 > The Duel");
    expect(m.kind).toBe("found");
    expect(m.kind === "found" && m.heading.startLine).toBe(15);
  });

  test("a bare duplicated leaf is ambiguous, listing the candidate paths", () => {
    const m = matchSection(outline, "The Duel");
    expect(m.kind).toBe("ambiguous");
    expect(m.kind === "ambiguous" && m.candidates).toEqual([
      "Act I > Chapter 1 > The Duel",
      "Act II > Chapter 1 > The Duel",
    ]);
  });

  test("an unknown heading is not found", () => {
    expect(matchSection(outline, "Epilogue").kind).toBe("not-found");
  });

  test("an empty query is not found", () => {
    expect(matchSection(outline, "   ").kind).toBe("not-found");
  });
});
