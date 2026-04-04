import { describe, test, expect } from "vitest";
import { formatRagContext } from "../../../src/rag/formatContext";
import type { RagContextBlock } from "../../../src/shared/chatRequest";

function makeBlock(
  filePath: string,
  headingPath: string,
  content: string,
  score: number,
): RagContextBlock {
  return { filePath, headingPath, content, score };
}

describe("formatRagContext", () => {
  test("returns empty string for no blocks", () => {
    expect(formatRagContext([])).toBe("");
  });

  test("wraps single block in XML tags", () => {
    const blocks = [makeBlock("note.md", "Heading", "Some content.", 0.9)];
    const result = formatRagContext(blocks);
    expect(result).toContain("<retrieved_context>");
    expect(result).toContain("</retrieved_context>");
    expect(result).toContain('<document source="note.md" section="Heading">');
    expect(result).toContain("Some content.");
    expect(result).toContain("</document>");
  });

  test("omits section attribute when headingPath is empty", () => {
    const blocks = [makeBlock("note.md", "", "Content.", 0.9)];
    const result = formatRagContext(blocks);
    expect(result).toContain('<document source="note.md">');
    expect(result).not.toContain("section=");
  });

  test("does not include relevance scores in output", () => {
    const blocks = [makeBlock("note.md", "", "Content.", 0.87)];
    const result = formatRagContext(blocks);
    expect(result).not.toContain("0.87");
    expect(result).not.toContain("relevance");
  });

  test("preserves order for 3 or fewer blocks", () => {
    const blocks = [
      makeBlock("a.md", "", "A", 0.9),
      makeBlock("b.md", "", "B", 0.8),
      makeBlock("c.md", "", "C", 0.7),
    ];
    const result = formatRagContext(blocks);
    const aIdx = result.indexOf("a.md");
    const bIdx = result.indexOf("b.md");
    const cIdx = result.indexOf("c.md");
    expect(aIdx).toBeLessThan(bIdx);
    expect(bIdx).toBeLessThan(cIdx);
  });

  test("renders graph_context when block has graphContext", () => {
    const blocks: RagContextBlock[] = [{
      filePath: "note.md",
      headingPath: "Background",
      content: "Alice is a knight.",
      score: 0.9,
      graphContext: {
        entities: [{ name: "Alice", type: "character", description: "A wandering knight" }],
        relationships: [{ source: "Alice", target: "Bob", type: "allies with", description: "Old friends" }],
      },
    }];
    const result = formatRagContext(blocks);
    expect(result).toContain("<graph_context>");
    expect(result).toContain('</graph_context>');
    expect(result).toContain('<entity name="Alice" type="character">A wandering knight</entity>');
    expect(result).toContain('<rel source="Alice" target="Bob" type="allies with">Old friends</rel>');
  });

  test("does not render graph_context when graphContext is absent", () => {
    const blocks = [makeBlock("note.md", "Section", "Content.", 0.9)];
    const result = formatRagContext(blocks);
    expect(result).not.toContain("<graph_context>");
  });

  test("renders mixed blocks — some with graphContext, some without", () => {
    const blocks: RagContextBlock[] = [
      { filePath: "a.md", headingPath: "", content: "No graph.", score: 0.9 },
      {
        filePath: "b.md", headingPath: "", content: "Has graph.", score: 0.8,
        graphContext: {
          entities: [{ name: "Bob", type: "character", description: "A wizard" }],
          relationships: [],
        },
      },
    ];
    const result = formatRagContext(blocks);
    // Only b.md should have graph_context.
    const parts = result.split("<graph_context>");
    expect(parts).toHaveLength(2); // one split = one occurrence
    expect(result).toContain('source="b.md"');
  });

  test("applies sandwich ordering for more than 3 blocks", () => {
    const blocks = [
      makeBlock("1.md", "", "first", 0.9),
      makeBlock("2.md", "", "second", 0.8),
      makeBlock("3.md", "", "third", 0.7),
      makeBlock("4.md", "", "fourth", 0.6),
      makeBlock("5.md", "", "fifth", 0.5),
    ];
    const result = formatRagContext(blocks);

    // Sandwich order: [1, 3, 5, 4, 2] — best first, second-best last,
    // weakest in the middle where LLM attention is lowest.
    const idx1 = result.indexOf("1.md");
    const idx2 = result.indexOf("2.md");
    const idx3 = result.indexOf("3.md");
    const idx5 = result.indexOf("5.md");
    // Best at start.
    expect(idx1).toBeLessThan(idx3);
    // Second-best at end (after weakest).
    expect(idx5).toBeLessThan(idx2);
    // Weakest in the middle.
    expect(idx3).toBeLessThan(idx5);
  });
});
