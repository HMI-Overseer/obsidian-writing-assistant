import { describe, test, expect } from "vitest";
import { cosineSimilarity, topKSimilar, limitPerFile } from "../../../src/rag/vectorMath";
import type { IndexedChunk } from "../../../src/rag/types";

function makeChunk(id: string, filePath: string, vector: number[]): IndexedChunk {
  return {
    id,
    filePath,
    headingPath: "",
    content: `Content of ${id}`,
    startOffset: 0,
    chunkIndex: 0,
    vector,
  };
}

describe("cosineSimilarity", () => {
  test("identical vectors return 1", () => {
    const v = [1, 2, 3];
    expect(cosineSimilarity(v, v)).toBeCloseTo(1, 5);
  });

  test("opposite vectors return -1", () => {
    const a = [1, 0, 0];
    const b = [-1, 0, 0];
    expect(cosineSimilarity(a, b)).toBeCloseTo(-1, 5);
  });

  test("orthogonal vectors return 0", () => {
    const a = [1, 0, 0];
    const b = [0, 1, 0];
    expect(cosineSimilarity(a, b)).toBeCloseTo(0, 5);
  });

  test("zero vector returns 0", () => {
    const a = [0, 0, 0];
    const b = [1, 2, 3];
    expect(cosineSimilarity(a, b)).toBe(0);
  });

  test("similar vectors have high score", () => {
    const a = [1, 2, 3];
    const b = [1.1, 2.1, 3.1];
    expect(cosineSimilarity(a, b)).toBeGreaterThan(0.99);
  });
});

describe("topKSimilar", () => {
  const chunks: IndexedChunk[] = [
    makeChunk("a::0", "a.md", [1, 0, 0]),
    makeChunk("b::0", "b.md", [0, 1, 0]),
    makeChunk("c::0", "c.md", [0, 0, 1]),
    makeChunk("d::0", "d.md", [0.9, 0.1, 0]),
  ];

  test("returns chunks sorted by similarity", () => {
    const query = [1, 0, 0];
    const results = topKSimilar(query, chunks, 4, 0);
    expect(results[0].chunk.id).toBe("a::0"); // exact match
    expect(results[1].chunk.id).toBe("d::0"); // close match
    expect(results[0].score).toBeGreaterThan(results[1].score);
  });

  test("limits to k results", () => {
    const query = [1, 0, 0];
    const results = topKSimilar(query, chunks, 2, 0);
    expect(results).toHaveLength(2);
  });

  test("filters by minScore", () => {
    const query = [1, 0, 0];
    const results = topKSimilar(query, chunks, 10, 0.9);
    // Only "a.md" (score 1.0) and "d.md" (score ~0.99) should pass.
    expect(results.length).toBeLessThanOrEqual(2);
    for (const r of results) {
      expect(r.score).toBeGreaterThanOrEqual(0.9);
    }
  });

  test("returns empty array for empty chunks", () => {
    const results = topKSimilar([1, 0, 0], [], 5, 0);
    expect(results).toEqual([]);
  });
});

describe("limitPerFile", () => {
  test("keeps up to maxPerFile chunks per file (default 2)", () => {
    const results: RetrievalResult[] = [
      { chunk: { id: "a::0", filePath: "a.md", headingPath: "", content: "", startOffset: 0, chunkIndex: 0 }, score: 0.9 },
      { chunk: { id: "b::0", filePath: "b.md", headingPath: "", content: "", startOffset: 0, chunkIndex: 0 }, score: 0.8 },
      { chunk: { id: "a::1", filePath: "a.md", headingPath: "", content: "", startOffset: 100, chunkIndex: 1 }, score: 0.7 },
      { chunk: { id: "a::2", filePath: "a.md", headingPath: "", content: "", startOffset: 200, chunkIndex: 2 }, score: 0.6 },
    ];

    const limited = limitPerFile(results);
    expect(limited).toHaveLength(3); // a::0, b::0, a::1 (a::2 dropped)
    expect(limited.map((r) => r.chunk.id)).toEqual(["a::0", "b::0", "a::1"]);
  });

  test("respects custom maxPerFile", () => {
    const results: RetrievalResult[] = [
      { chunk: { id: "a::0", filePath: "a.md", headingPath: "", content: "", startOffset: 0, chunkIndex: 0 }, score: 0.9 },
      { chunk: { id: "a::1", filePath: "a.md", headingPath: "", content: "", startOffset: 100, chunkIndex: 1 }, score: 0.7 },
      { chunk: { id: "b::0", filePath: "b.md", headingPath: "", content: "", startOffset: 0, chunkIndex: 0 }, score: 0.8 },
    ];

    const limited = limitPerFile(results, 1);
    expect(limited).toHaveLength(2);
    expect(limited[0].chunk.id).toBe("a::0");
    expect(limited[1].chunk.id).toBe("b::0");
  });

  test("preserves input order", () => {
    const results: RetrievalResult[] = [
      { chunk: { id: "b::0", filePath: "b.md", headingPath: "", content: "", startOffset: 0, chunkIndex: 0 }, score: 0.5 },
      { chunk: { id: "a::0", filePath: "a.md", headingPath: "", content: "", startOffset: 0, chunkIndex: 0 }, score: 0.9 },
    ];

    const limited = limitPerFile(results);
    expect(limited[0].chunk.id).toBe("b::0");
    expect(limited[1].chunk.id).toBe("a::0");
  });
});

