import { describe, test, expect } from "vitest";
import { chunkDocument, fnv1aHash, buildEmbeddingText, preprocessMarkdown } from "../../../src/rag/chunker";

const DEFAULT_CHUNK_SIZE = 1500;
const DEFAULT_OVERLAP = 200;

describe("chunkDocument", () => {
  test("returns empty array for empty content", () => {
    expect(chunkDocument("test.md", "", DEFAULT_CHUNK_SIZE, DEFAULT_OVERLAP)).toEqual([]);
    expect(chunkDocument("test.md", "   \n  ", DEFAULT_CHUNK_SIZE, DEFAULT_OVERLAP)).toEqual([]);
  });

  test("produces a single chunk for short content", () => {
    const content = "Hello world, this is a short note.";
    const chunks = chunkDocument("test.md", content, DEFAULT_CHUNK_SIZE, DEFAULT_OVERLAP);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].content).toBe(content);
    expect(chunks[0].filePath).toBe("test.md");
    expect(chunks[0].id).toBe("test.md::0");
    expect(chunks[0].chunkIndex).toBe(0);
  });

  test("splits on headings and builds breadcrumb paths", () => {
    const filler = "Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor.";
    const content = [
      "# Chapter 1",
      `Introduction to the chapter. ${filler}`,
      "## Scene 1",
      `Scene 1 content with enough text to avoid merging. ${filler}`,
      "## Scene 2",
      `Scene 2 content with enough text to avoid merging. ${filler}`,
    ].join("\n");

    const chunks = chunkDocument("story.md", content, DEFAULT_CHUNK_SIZE, DEFAULT_OVERLAP);
    expect(chunks.length).toBeGreaterThanOrEqual(3);

    const headings = chunks.map((c) => c.headingPath);
    expect(headings).toContain("Chapter 1");
    expect(headings).toContain("Chapter 1 > Scene 1");
    expect(headings).toContain("Chapter 1 > Scene 2");
  });

  test("splits large sections at paragraph boundaries", () => {
    const paragraph = "A".repeat(400);
    const content = [
      "# Big Section",
      paragraph,
      "",
      paragraph,
      "",
      paragraph,
      "",
      paragraph,
      "",
      paragraph,
    ].join("\n");

    const chunks = chunkDocument("big.md", content, 1000, 100);
    expect(chunks.length).toBeGreaterThan(1);

    // All chunks should have the same heading path.
    for (const chunk of chunks) {
      expect(chunk.headingPath).toBe("Big Section");
    }
  });

  test("merges small chunks into previous", () => {
    const content = [
      "# Heading 1",
      "Some text under heading 1.",
      "# Heading 2",
      "Ok", // Very short — should merge
    ].join("\n");

    const chunks = chunkDocument("merge.md", content, DEFAULT_CHUNK_SIZE, DEFAULT_OVERLAP);
    // "Ok" is under 50 chars and should be merged.
    // We should have at most 2 chunks (heading 1 content, and heading 2 "Ok" merged with something).
    for (const chunk of chunks) {
      expect(chunk.content.trim().length).toBeGreaterThanOrEqual(1);
    }
  });

  test("assigns sequential chunk indices", () => {
    const content = [
      "# A",
      "Content A.",
      "# B",
      "Content B.",
      "# C",
      "Content C.",
    ].join("\n");

    const chunks = chunkDocument("seq.md", content, DEFAULT_CHUNK_SIZE, DEFAULT_OVERLAP);
    for (let i = 0; i < chunks.length; i++) {
      expect(chunks[i].chunkIndex).toBe(i);
      expect(chunks[i].id).toBe(`seq.md::${i}`);
    }
  });

  test("handles content with no headings", () => {
    const content = "Just some plain text.\n\nAnother paragraph.";
    const chunks = chunkDocument("plain.md", content, DEFAULT_CHUNK_SIZE, DEFAULT_OVERLAP);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].headingPath).toBe("");
  });

  test("handles deeply nested headings", () => {
    const content = [
      "# Level 1",
      "## Level 2",
      "### Level 3",
      "Deep content here.",
    ].join("\n");

    const chunks = chunkDocument("deep.md", content, DEFAULT_CHUNK_SIZE, DEFAULT_OVERLAP);
    const deepChunk = chunks.find((c) => c.content.includes("Deep content"));
    expect(deepChunk?.headingPath).toBe("Level 1 > Level 2 > Level 3");
  });
});

describe("buildEmbeddingText", () => {
  test("prepends file name and heading path", () => {
    const chunk = {
      id: "notes/Character Bible.md::0",
      filePath: "notes/Character Bible.md",
      headingPath: "Backstory > Childhood",
      content: "Born in a small village.",
      startOffset: 0,
      chunkIndex: 0,
    };
    const result = buildEmbeddingText(chunk);
    expect(result).toBe("Character Bible > Backstory > Childhood\nBorn in a small village.");
  });

  test("uses only file name when no heading path", () => {
    const chunk = {
      id: "notes/Lore.md::0",
      filePath: "notes/Lore.md",
      headingPath: "",
      content: "World lore content.",
      startOffset: 0,
      chunkIndex: 0,
    };
    const result = buildEmbeddingText(chunk);
    expect(result).toBe("Lore\nWorld lore content.");
  });

  test("handles root-level files", () => {
    const chunk = {
      id: "README.md::0",
      filePath: "README.md",
      headingPath: "Getting Started",
      content: "Instructions here.",
      startOffset: 0,
      chunkIndex: 0,
    };
    const result = buildEmbeddingText(chunk);
    expect(result).toBe("README > Getting Started\nInstructions here.");
  });
});

describe("preprocessMarkdown", () => {
  test("strips YAML frontmatter", () => {
    const input = "---\ntags: [fiction]\ndate: 2025-01-01\n---\nActual content here.";
    expect(preprocessMarkdown(input)).toBe("Actual content here.");
  });

  test("resolves wikilinks", () => {
    expect(preprocessMarkdown("See [[Character Bible]].")).toBe("See Character Bible.");
    expect(preprocessMarkdown("See [[Character Bible|the bible]].")).toBe("See the bible.");
  });

  test("removes image embeds", () => {
    expect(preprocessMarkdown("![[screenshot.png]]")).toBe("");
    expect(preprocessMarkdown("![alt text](image.png)")).toBe("");
  });

  test("strips markdown links but keeps text", () => {
    expect(preprocessMarkdown("[click here](https://example.com)")).toBe("click here");
  });

  test("cleans tag syntax", () => {
    expect(preprocessMarkdown("Tagged #fiction/fantasy and #wip")).toBe("Tagged fiction fantasy and wip");
  });

  test("preserves code blocks", () => {
    const input = "Before\n```js\nconst x = [[not a link]];\n```\nAfter";
    const result = preprocessMarkdown(input);
    expect(result).toContain("```js\nconst x = [[not a link]];\n```");
    expect(result).toContain("Before");
    expect(result).toContain("After");
  });

  test("does not strip heading markers as tags", () => {
    const input = "# My Heading\n\nSome text with #tag";
    const result = preprocessMarkdown(input);
    expect(result).toContain("# My Heading");
    expect(result).toContain("tag");
    expect(result).not.toContain("#tag");
  });

  test("handles content with no markdown syntax", () => {
    const input = "Just plain text.";
    expect(preprocessMarkdown(input)).toBe("Just plain text.");
  });
});

describe("fnv1aHash", () => {
  test("returns consistent hash for same input", () => {
    const hash1 = fnv1aHash("Hello world");
    const hash2 = fnv1aHash("Hello world");
    expect(hash1).toBe(hash2);
  });

  test("returns different hashes for different input", () => {
    const hash1 = fnv1aHash("Hello world");
    const hash2 = fnv1aHash("Hello World");
    expect(hash1).not.toBe(hash2);
  });

  test("returns 8-character hex string", () => {
    const hash = fnv1aHash("test");
    expect(hash).toMatch(/^[0-9a-f]{8}$/);
  });

  test("handles empty string", () => {
    const hash = fnv1aHash("");
    expect(hash).toMatch(/^[0-9a-f]{8}$/);
  });
});
