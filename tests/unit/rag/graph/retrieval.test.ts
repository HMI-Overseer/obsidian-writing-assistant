import { describe, test, expect, beforeEach } from "vitest";
import { KnowledgeGraph } from "../../../../src/rag/graph/knowledgeGraph";
import { buildGraphContext, boostByGraphRelevance, annotateBlockWithGraph } from "../../../../src/rag/graph/retrieval";
import type { GraphFileMeta, ExtractionResult, GraphEntity } from "../../../../src/rag/graph/types";
import type { RetrievalResult, DocumentChunk } from "../../../../src/rag/types";
import type { RagContextBlock } from "../../../../src/shared/chatRequest";

function makeMeta(filePath: string): GraphFileMeta {
  return { filePath, mtime: Date.now(), contentHash: "abc123" };
}

function makeChunk(filePath: string, content = "chunk content"): DocumentChunk {
  return {
    id: `${filePath}::0`,
    filePath,
    headingPath: "Section",
    content,
    startOffset: 0,
    chunkIndex: 0,
  };
}

function makeResult(filePath: string, score: number): RetrievalResult {
  return { chunk: makeChunk(filePath), score };
}

describe("buildGraphContext", () => {
  let graph: KnowledgeGraph;

  beforeEach(() => {
    graph = new KnowledgeGraph();

    // Build a graph: Alice --allies with--> Bob --mentors--> Charlie
    // Alice in file1.md, Bob in file1.md + file2.md, Charlie in file2.md
    graph.addExtractions(
      "file1.md",
      {
        entities: [
          { name: "Alice", type: "character", description: "A knight" },
          { name: "Bob", type: "character", description: "A wizard" },
        ],
        relationships: [
          { source: "Alice", target: "Bob", type: "allies with", description: "Old friends" },
        ],
      } satisfies ExtractionResult,
      makeMeta("file1.md"),
    );

    graph.addExtractions(
      "file2.md",
      {
        entities: [
          { name: "Bob", type: "character", description: "A powerful wizard" },
          { name: "Charlie", type: "character", description: "A thief" },
        ],
        relationships: [
          { source: "Bob", target: "Charlie", type: "mentors", description: "Teaches magic" },
        ],
      } satisfies ExtractionResult,
      makeMeta("file2.md"),
    );
  });

  test("returns matched entities and relevant files for a query", () => {
    const ctx = buildGraphContext("Alice", graph);

    expect(ctx.matchedEntities).toHaveLength(1);
    expect(ctx.matchedEntities[0].name).toBe("Alice");
    expect(ctx.relevantFiles.size).toBeGreaterThan(0);
    // Alice's direct file should have highest relevance.
    expect(ctx.relevantFiles.has("file1.md")).toBe(true);
  });

  test("merges file maps across multiple matched entities", () => {
    // Both Alice and Bob match — their file maps should merge with max relevance.
    const ctx = buildGraphContext("Alice", graph);
    const aliceRelevance = ctx.relevantFiles.get("file1.md")!;

    const ctx2 = buildGraphContext("Bob", graph);
    const bobRelevanceForFile1 = ctx2.relevantFiles.get("file1.md")!;

    // Both should have file1.md but potentially different relevance values.
    expect(aliceRelevance).toBeGreaterThan(0);
    expect(bobRelevanceForFile1).toBeGreaterThan(0);
  });

  test("reaches 2-hop files by default", () => {
    const ctx = buildGraphContext("Alice", graph);

    // Alice → Bob (1 hop) → Charlie (2 hops), so file2.md should be reachable.
    expect(ctx.relevantFiles.has("file2.md")).toBe(true);

    // Direct file should have higher relevance than 2-hop file.
    const directRelevance = ctx.relevantFiles.get("file1.md")!;
    const hopRelevance = ctx.relevantFiles.get("file2.md")!;
    expect(directRelevance).toBeGreaterThan(hopRelevance);
  });

  test("respects maxHops parameter", () => {
    // With maxHops=1, Alice can reach Bob but not Charlie.
    const ctx = buildGraphContext("Alice", graph, 1);

    expect(ctx.relevantFiles.has("file1.md")).toBe(true);
    // file2.md is reachable because Bob is in file2.md (1-hop neighbor).
    expect(ctx.relevantFiles.has("file2.md")).toBe(true);
  });

  test("returns empty result for no match", () => {
    const ctx = buildGraphContext("Nonexistent", graph);

    expect(ctx.matchedEntities).toHaveLength(0);
    expect(ctx.relevantFiles.size).toBe(0);
  });

  test("returns empty result for empty query", () => {
    const ctx = buildGraphContext("", graph);

    expect(ctx.matchedEntities).toHaveLength(0);
    expect(ctx.relevantFiles.size).toBe(0);
  });
});

describe("boostByGraphRelevance", () => {
  test("boosts scores for files in the relevance map", () => {
    const results: RetrievalResult[] = [
      makeResult("file1.md", 0.8),
      makeResult("file2.md", 0.6),
    ];
    const relevantFiles = new Map([["file1.md", 1.0]]);

    const boosted = boostByGraphRelevance(results, relevantFiles);

    // file1.md should be boosted: 0.8 * (1 + 1.0 * 0.2) = 0.96
    expect(boosted[0].chunk.filePath).toBe("file1.md");
    expect(boosted[0].score).toBeCloseTo(0.96);
    // file2.md should be unchanged.
    expect(boosted[1].chunk.filePath).toBe("file2.md");
    expect(boosted[1].score).toBe(0.6);
  });

  test("re-sorts by boosted score", () => {
    const results: RetrievalResult[] = [
      makeResult("file1.md", 0.7),
      makeResult("file2.md", 0.65),
    ];
    // Boost file2.md enough to overtake file1.md.
    const relevantFiles = new Map([["file2.md", 1.0]]);

    const boosted = boostByGraphRelevance(results, relevantFiles, 0.5);

    // file2.md: 0.65 * (1 + 1.0 * 0.5) = 0.975, file1.md stays 0.7
    expect(boosted[0].chunk.filePath).toBe("file2.md");
    expect(boosted[0].score).toBeCloseTo(0.975);
    expect(boosted[1].chunk.filePath).toBe("file1.md");
    expect(boosted[1].score).toBe(0.7);
  });

  test("returns results unchanged when relevance map is empty", () => {
    const results: RetrievalResult[] = [
      makeResult("file1.md", 0.8),
      makeResult("file2.md", 0.6),
    ];

    const boosted = boostByGraphRelevance(results, new Map());

    expect(boosted[0].score).toBe(0.8);
    expect(boosted[1].score).toBe(0.6);
  });

  test("does not mutate the input array", () => {
    const results: RetrievalResult[] = [
      makeResult("file1.md", 0.8),
      makeResult("file2.md", 0.6),
    ];
    const relevantFiles = new Map([["file1.md", 1.0]]);

    const boosted = boostByGraphRelevance(results, relevantFiles);

    // Original array should be unchanged.
    expect(results[0].score).toBe(0.8);
    expect(results[1].score).toBe(0.6);
    // Boosted should be a new array.
    expect(boosted).not.toBe(results);
  });

  test("uses custom strength parameter", () => {
    const results: RetrievalResult[] = [makeResult("file1.md", 0.5)];
    const relevantFiles = new Map([["file1.md", 1.0]]);

    const boosted = boostByGraphRelevance(results, relevantFiles, 0.5);

    // 0.5 * (1 + 1.0 * 0.5) = 0.75
    expect(boosted[0].score).toBeCloseTo(0.75);
  });
});

function makeBlock(filePath: string, content = "chunk content"): RagContextBlock {
  return { filePath, headingPath: "Section", content, score: 0.9 };
}

describe("annotateBlockWithGraph", () => {
  let graph: KnowledgeGraph;
  let matchedEntities: GraphEntity[];

  beforeEach(() => {
    graph = new KnowledgeGraph();

    graph.addExtractions(
      "file1.md",
      {
        entities: [
          { name: "Alice", type: "character", description: "A knight" },
          { name: "Bob", type: "character", description: "A wizard" },
        ],
        relationships: [
          { source: "Alice", target: "Bob", type: "allies with", description: "Old friends" },
        ],
      } satisfies ExtractionResult,
      makeMeta("file1.md"),
    );

    graph.addExtractions(
      "file2.md",
      {
        entities: [
          { name: "Bob", type: "character", description: "A powerful wizard" },
          { name: "Charlie", type: "character", description: "A thief" },
        ],
        relationships: [
          { source: "Bob", target: "Charlie", type: "mentors", description: "Teaches magic" },
        ],
      } satisfies ExtractionResult,
      makeMeta("file2.md"),
    );

    // Simulate a query that matched Alice.
    matchedEntities = graph.findEntities("Alice");
  });

  test("annotates block with entities found in file", () => {
    const block = makeBlock("file1.md");
    const result = annotateBlockWithGraph(block, graph, matchedEntities);

    expect(result.graphContext).toBeDefined();
    expect(result.graphContext!.entities.length).toBeGreaterThan(0);
    expect(result.graphContext!.entities.some((e) => e.name === "Alice")).toBe(true);
  });

  test("includes relationships between relevant entities", () => {
    const block = makeBlock("file1.md");
    const result = annotateBlockWithGraph(block, graph, matchedEntities);

    // Alice and Bob are both in file1.md and in Alice's 1-hop neighborhood.
    expect(result.graphContext!.relationships).toHaveLength(1);
    expect(result.graphContext!.relationships[0].type).toBe("allies with");
  });

  test("filters entities to those in the relevant set", () => {
    // file2.md has Bob and Charlie. Alice's 1-hop neighbors are Alice + Bob.
    // So only Bob should appear, not Charlie.
    const block = makeBlock("file2.md");
    const result = annotateBlockWithGraph(block, graph, matchedEntities);

    expect(result.graphContext).toBeDefined();
    const names = result.graphContext!.entities.map((e) => e.name);
    expect(names).toContain("Bob");
    expect(names).not.toContain("Charlie");
  });

  test("returns block unchanged when file has no relevant entities", () => {
    graph.addExtractions(
      "file3.md",
      {
        entities: [{ name: "Dave", type: "character", description: "A stranger" }],
        relationships: [],
      } satisfies ExtractionResult,
      makeMeta("file3.md"),
    );

    const block = makeBlock("file3.md");
    const result = annotateBlockWithGraph(block, graph, matchedEntities);

    expect(result.graphContext).toBeUndefined();
  });

  test("returns block unchanged when file is not in the graph", () => {
    const block = makeBlock("unknown.md");
    const result = annotateBlockWithGraph(block, graph, matchedEntities);

    expect(result.graphContext).toBeUndefined();
  });

  test("does not mutate the input block", () => {
    const block = makeBlock("file1.md");
    const result = annotateBlockWithGraph(block, graph, matchedEntities);

    expect(result).not.toBe(block);
    expect(block.graphContext).toBeUndefined();
  });

  test("excludes relationships where one endpoint is outside the relevant set", () => {
    // Bob → Charlie relationship: Charlie is NOT in Alice's 1-hop neighborhood.
    const block = makeBlock("file2.md");
    const result = annotateBlockWithGraph(block, graph, matchedEntities);

    const relTypes = result.graphContext!.relationships.map((r) => r.type);
    expect(relTypes).not.toContain("mentors");
  });
});
