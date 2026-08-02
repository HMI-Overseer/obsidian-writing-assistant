import { describe, it, expect } from "vitest";
import { parseLineList, formatLineList } from "../../../src/settings/definitions/lineList";

/**
 * The case list is Stage 4's round-trip table, which evaluated this transform by hand while it was
 * still written out three times inside `render` callbacks. Lifting it made the table executable.
 */
describe("parseLineList", () => {
  it("returns an empty list for empty text", () => {
    expect(parseLineList("")).toEqual([]);
  });

  it("returns an empty list for text that is only whitespace and blank lines", () => {
    expect(parseLineList("  \n\t\n   \n")).toEqual([]);
  });

  it("drops blank lines between entries", () => {
    expect(parseLineList("Drafts/AI\n\n\nScenes\n")).toEqual(["Drafts/AI", "Scenes"]);
  });

  it("trims surrounding whitespace on each entry", () => {
    expect(parseLineList("  Drafts/AI  \n\tScenes\t")).toEqual(["Drafts/AI", "Scenes"]);
  });

  it("keeps interior whitespace, since a path may contain spaces", () => {
    expect(parseLineList("  My Drafts/AI notes  ")).toEqual(["My Drafts/AI notes"]);
  });

  it("keeps entry order", () => {
    expect(parseLineList("c\na\nb")).toEqual(["c", "a", "b"]);
  });

  it("keeps duplicates rather than collapsing them", () => {
    expect(parseLineList("Scenes\nScenes")).toEqual(["Scenes", "Scenes"]);
  });
});

describe("formatLineList", () => {
  it("returns empty text for an empty list", () => {
    expect(formatLineList([])).toBe("");
  });

  it("puts one entry per line with no trailing newline", () => {
    expect(formatLineList(["Drafts/AI", "Scenes"])).toBe("Drafts/AI\nScenes");
  });
});

describe("the round trip", () => {
  // What the user sees after a save and a reopen: the stored value re-rendered into the textarea.
  it("normalizes on the first pass", () => {
    expect(formatLineList(parseLineList("  Drafts/AI  \n\n\tScenes\t\n"))).toBe(
      "Drafts/AI\nScenes"
    );
  });

  it("is stable on every pass after that", () => {
    const once = formatLineList(parseLineList("Drafts/AI\n\n\nScenes\n"));
    expect(formatLineList(parseLineList(once))).toBe(once);
  });

  it("parse is the identity over anything format produces", () => {
    const stored = ["Drafts/AI", "Scenes", "templates/**"];
    expect(parseLineList(formatLineList(stored))).toEqual(stored);
  });
});
