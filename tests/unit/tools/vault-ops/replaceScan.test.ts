import { describe, test, expect } from "vitest";
import {
  applyReplacement,
  findReplaceTargets,
} from "../../../../src/tools/vault-ops/replaceScan";

describe("applyReplacement", () => {
  test("replaces every occurrence and counts them", () => {
    const { content, count } = applyReplacement(
      "Silver Age rose; the Silver Age fell.",
      { search: "Silver Age", replace: "Golden Age" },
    );
    expect(count).toBe(2);
    expect(content).toBe("Golden Age rose; the Golden Age fell.");
  });

  test("is case-insensitive by default", () => {
    const { content, count } = applyReplacement("silver age / Silver Age", {
      search: "Silver Age",
      replace: "Golden Age",
    });
    expect(count).toBe(2);
    expect(content).toBe("Golden Age / Golden Age");
  });

  test("caseSensitive matches case exactly", () => {
    const { content, count } = applyReplacement("silver age / Silver Age", {
      search: "Silver Age",
      replace: "Golden Age",
      caseSensitive: true,
    });
    expect(count).toBe(1);
    expect(content).toBe("silver age / Golden Age");
  });

  test("wholeWord does not match inside a larger word", () => {
    const { content, count } = applyReplacement("cat catalog scattered", {
      search: "cat",
      replace: "dog",
      wholeWord: true,
    });
    expect(count).toBe(1);
    expect(content).toBe("dog catalog scattered");
  });

  test("wholeWord still matches a short token at a string boundary (the rename motive)", () => {
    // Renaming a short character name (Sael → Sael the Younger) must hit the standalone
    // mentions but never the ones embedded in a longer word.
    const { content, count } = applyReplacement("Sael spoke. Saelith watched. Sael", {
      search: "Sael",
      replace: "Sael the Younger",
      wholeWord: true,
    });
    expect(count).toBe(2);
    expect(content).toBe("Sael the Younger spoke. Saelith watched. Sael the Younger");
  });

  test("empty replace deletes the term", () => {
    const { content, count } = applyReplacement("keep [draft] this", {
      search: "[draft] ",
      replace: "",
    });
    expect(count).toBe(1);
    expect(content).toBe("keep this");
  });

  test("treats $-sequences in the replacement as literal text", () => {
    const { content, count } = applyReplacement("price: X", {
      search: "X",
      replace: "$1 $& cost",
    });
    expect(count).toBe(1);
    expect(content).toBe("price: $1 $& cost");
  });

  test("escapes regex metacharacters in the search term", () => {
    const { content, count } = applyReplacement("a.b a.b axb", {
      search: "a.b",
      replace: "Z",
    });
    // The "." is literal, so "axb" must NOT match.
    expect(count).toBe(2);
    expect(content).toBe("Z Z axb");
  });

  test("no match leaves content untouched with count 0", () => {
    const { content, count } = applyReplacement("nothing here", {
      search: "absent",
      replace: "x",
    });
    expect(count).toBe(0);
    expect(content).toBe("nothing here");
  });
});

describe("findReplaceTargets", () => {
  const files = ["Lore/Cosmology.md", "Lore/Magic.md", "Characters/Alice.md"];
  const content: Record<string, string> = {
    "Lore/Cosmology.md": "The Silver Age and again Silver Age.",
    "Lore/Magic.md": "Silver Age here.",
    "Characters/Alice.md": "no mention.",
  };
  const read = (p: string) => content[p] ?? null;

  test("returns only files with matches, with per-file counts and new content", () => {
    const targets = findReplaceTargets(files, read, {
      search: "Silver Age",
      replace: "Golden Age",
    });
    expect(targets).toEqual([
      {
        path: "Lore/Cosmology.md",
        content: "The Golden Age and again Golden Age.",
        count: 2,
      },
      { path: "Lore/Magic.md", content: "Golden Age here.", count: 1 },
    ]);
  });

  test("skips unreadable files (readContent returns null)", () => {
    const targets = findReplaceTargets(["missing.md"], () => null, {
      search: "x",
      replace: "y",
    });
    expect(targets).toEqual([]);
  });
});
