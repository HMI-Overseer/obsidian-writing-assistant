import { describe, test, expect, beforeEach } from "vitest";
import { KnowledgeGraph } from "../../../src/rag/graph/knowledgeGraph";
import type { ExtractionResult, GraphFileMeta } from "../../../src/rag/graph/types";

function makeMeta(filePath: string): GraphFileMeta {
  return { filePath, mtime: Date.now(), contentHash: "abc123" };
}

function makeExtraction(
  entities: ExtractionResult["entities"],
  relationships: ExtractionResult["relationships"] = [],
): ExtractionResult {
  return { entities, relationships };
}

describe("KnowledgeGraph", () => {
  let graph: KnowledgeGraph;

  beforeEach(() => {
    graph = new KnowledgeGraph();
  });

  // ── addExtractions & entity merging ──────────────────────────────

  describe("addExtractions", () => {
    test("adds entities from a file", () => {
      graph.addExtractions(
        "Characters/Alice.md",
        makeExtraction([
          { name: "Alice", type: "character", description: "A knight" },
          { name: "Iron Castle", type: "location", description: "A fortress" },
        ]),
        makeMeta("Characters/Alice.md"),
      );

      expect(graph.getEntityCount()).toBe(2);
      expect(graph.getRelationCount()).toBe(0);
    });

    test("merges entities by normalized name across files", () => {
      graph.addExtractions(
        "file1.md",
        makeExtraction([
          { name: "Alice", type: "character", description: "Short" },
        ]),
        makeMeta("file1.md"),
      );
      graph.addExtractions(
        "file2.md",
        makeExtraction([
          { name: "alice", type: "character", description: "A longer description" },
        ]),
        makeMeta("file2.md"),
      );

      expect(graph.getEntityCount()).toBe(1);

      const entities = graph.findEntities("alice");
      expect(entities).toHaveLength(1);
      // Keeps the longer description.
      expect(entities[0].description).toBe("A longer description");
      // Both source files tracked.
      expect(entities[0].sourceFiles).toContain("file1.md");
      expect(entities[0].sourceFiles).toContain("file2.md");
    });

    test("adds relationships", () => {
      graph.addExtractions(
        "story.md",
        makeExtraction(
          [
            { name: "Alice", type: "character", description: "A knight" },
            { name: "Bob", type: "character", description: "A wizard" },
          ],
          [
            { source: "Alice", target: "Bob", type: "allies with", description: "Allies since childhood" },
          ],
        ),
        makeMeta("story.md"),
      );

      expect(graph.getRelationCount()).toBe(1);
      const rels = graph.getRelations("Alice");
      expect(rels).toHaveLength(1);
      expect(rels[0].type).toBe("allies with");
    });

    test("increments weight for duplicate relations", () => {
      const extraction1 = makeExtraction(
        [
          { name: "Alice", type: "character", description: "A knight" },
          { name: "Bob", type: "character", description: "A wizard" },
        ],
        [{ source: "Alice", target: "Bob", type: "allies with", description: "Context 1" }],
      );

      const extraction2 = makeExtraction(
        [
          { name: "Alice", type: "character", description: "A knight" },
          { name: "Bob", type: "character", description: "A wizard" },
        ],
        [{ source: "Alice", target: "Bob", type: "allies with", description: "Context 2" }],
      );

      graph.addExtractions("file1.md", extraction1, makeMeta("file1.md"));
      graph.addExtractions("file2.md", extraction2, makeMeta("file2.md"));

      const rels = graph.getRelations("Alice");
      const allyRel = rels.find((r) => r.type === "allies with");
      expect(allyRel?.weight).toBe(2);
    });

    test("re-extraction for same file replaces old data", () => {
      graph.addExtractions(
        "file.md",
        makeExtraction([
          { name: "Alice", type: "character", description: "Old" },
        ]),
        makeMeta("file.md"),
      );

      graph.addExtractions(
        "file.md",
        makeExtraction([
          { name: "Bob", type: "character", description: "New" },
        ]),
        makeMeta("file.md"),
      );

      // Alice should be gone (only existed in file.md), Bob should be present.
      expect(graph.findEntities("Alice")).toHaveLength(0);
      expect(graph.findEntities("Bob")).toHaveLength(1);
    });

    test("skips entities with empty names", () => {
      graph.addExtractions(
        "file.md",
        makeExtraction([
          { name: "", type: "character", description: "No name" },
          { name: "Alice", type: "character", description: "Valid" },
        ]),
        makeMeta("file.md"),
      );

      expect(graph.getEntityCount()).toBe(1);
    });
  });

  // ── findEntities ─────────────────────────────────────────────────

  describe("findEntities", () => {
    test("finds by exact name (case-insensitive)", () => {
      graph.addExtractions(
        "file.md",
        makeExtraction([
          { name: "Alice", type: "character", description: "A knight" },
        ]),
        makeMeta("file.md"),
      );

      expect(graph.findEntities("ALICE")).toHaveLength(1);
      expect(graph.findEntities("alice")).toHaveLength(1);
    });

    test("finds by partial name", () => {
      graph.addExtractions(
        "file.md",
        makeExtraction([
          { name: "The Iron Castle", type: "location", description: "A fortress" },
        ]),
        makeMeta("file.md"),
      );

      expect(graph.findEntities("iron")).toHaveLength(1);
      expect(graph.findEntities("castle")).toHaveLength(1);
    });

    test("returns empty for empty query", () => {
      expect(graph.findEntities("")).toHaveLength(0);
    });
  });

  // ── getNeighborhood ──────────────────────────────────────────────

  describe("getNeighborhood", () => {
    beforeEach(() => {
      // Build a simple graph: Alice --allies--> Bob --mentors--> Charlie
      graph.addExtractions(
        "file.md",
        makeExtraction(
          [
            { name: "Alice", type: "character", description: "Knight" },
            { name: "Bob", type: "character", description: "Wizard" },
            { name: "Charlie", type: "character", description: "Thief" },
            { name: "Isolated", type: "character", description: "Loner" },
          ],
          [
            { source: "Alice", target: "Bob", type: "allies with", description: "" },
            { source: "Bob", target: "Charlie", type: "mentors", description: "" },
          ],
        ),
        makeMeta("file.md"),
      );
    });

    test("returns immediate neighbors at maxHops=1", () => {
      const neighborhood = graph.getNeighborhood("Alice", 1);
      expect(neighborhood.get("alice")).toBe(0);
      expect(neighborhood.get("bob")).toBe(1);
      expect(neighborhood.has("charlie")).toBe(false);
    });

    test("returns 2-hop neighbors at maxHops=2", () => {
      const neighborhood = graph.getNeighborhood("Alice", 2);
      expect(neighborhood.get("alice")).toBe(0);
      expect(neighborhood.get("bob")).toBe(1);
      expect(neighborhood.get("charlie")).toBe(2);
    });

    test("does not include isolated nodes", () => {
      const neighborhood = graph.getNeighborhood("Alice", 3);
      expect(neighborhood.has("isolated")).toBe(false);
    });

    test("traverses bidirectionally", () => {
      const neighborhood = graph.getNeighborhood("Charlie", 1);
      expect(neighborhood.get("bob")).toBe(1);
    });

    test("returns empty map for unknown entity", () => {
      const neighborhood = graph.getNeighborhood("Unknown", 2);
      expect(neighborhood.size).toBe(0);
    });
  });

  // ── getEntitiesInFile ────────────────────────────────────────────

  describe("getEntitiesInFile", () => {
    test("returns entities extracted from a specific file", () => {
      graph.addExtractions(
        "file1.md",
        makeExtraction([
          { name: "Alice", type: "character", description: "A knight" },
        ]),
        makeMeta("file1.md"),
      );
      graph.addExtractions(
        "file2.md",
        makeExtraction([
          { name: "Bob", type: "character", description: "A wizard" },
        ]),
        makeMeta("file2.md"),
      );

      const file1Entities = graph.getEntitiesInFile("file1.md");
      expect(file1Entities).toHaveLength(1);
      expect(file1Entities[0].name).toBe("Alice");
    });

    test("returns empty for unknown file", () => {
      expect(graph.getEntitiesInFile("unknown.md")).toHaveLength(0);
    });
  });

  // ── getRelevantFiles ─────────────────────────────────────────────

  describe("getRelevantFiles", () => {
    test("returns source files with relevance scores", () => {
      graph.addExtractions(
        "Characters/Alice.md",
        makeExtraction(
          [
            { name: "Alice", type: "character", description: "A knight" },
            { name: "Bob", type: "character", description: "A wizard" },
          ],
          [{ source: "Alice", target: "Bob", type: "allies with", description: "" }],
        ),
        makeMeta("Characters/Alice.md"),
      );
      graph.addExtractions(
        "Characters/Bob.md",
        makeExtraction([
          { name: "Bob", type: "character", description: "A wizard" },
        ]),
        makeMeta("Characters/Bob.md"),
      );

      const files = graph.getRelevantFiles("Alice", 1);
      expect(files.has("Characters/Alice.md")).toBe(true);
      expect(files.has("Characters/Bob.md")).toBe(true);

      // Direct file should have higher relevance than 1-hop file.
      const directRelevance = files.get("Characters/Alice.md")!;
      const hopRelevance = files.get("Characters/Bob.md")!;
      expect(directRelevance).toBeGreaterThan(hopRelevance);
    });
  });

  // ── removeFile ───────────────────────────────────────────────────

  describe("removeFile", () => {
    test("removes entities unique to a file", () => {
      graph.addExtractions(
        "file.md",
        makeExtraction([
          { name: "Alice", type: "character", description: "A knight" },
        ]),
        makeMeta("file.md"),
      );

      graph.removeFile("file.md");
      expect(graph.getEntityCount()).toBe(0);
    });

    test("preserves entities shared across files", () => {
      graph.addExtractions(
        "file1.md",
        makeExtraction([
          { name: "Alice", type: "character", description: "A knight" },
        ]),
        makeMeta("file1.md"),
      );
      graph.addExtractions(
        "file2.md",
        makeExtraction([
          { name: "Alice", type: "character", description: "A brave knight" },
        ]),
        makeMeta("file2.md"),
      );

      graph.removeFile("file1.md");
      expect(graph.getEntityCount()).toBe(1);
      expect(graph.findEntities("Alice")[0].sourceFiles).toEqual(["file2.md"]);
    });

    test("removes relations sourced from the file", () => {
      graph.addExtractions(
        "file.md",
        makeExtraction(
          [
            { name: "Alice", type: "character", description: "A knight" },
            { name: "Bob", type: "character", description: "A wizard" },
          ],
          [{ source: "Alice", target: "Bob", type: "allies with", description: "" }],
        ),
        makeMeta("file.md"),
      );

      graph.removeFile("file.md");
      expect(graph.getRelationCount()).toBe(0);
    });
  });

  // ── Serialization ────────────────────────────────────────────────

  describe("serialize / deserialize", () => {
    test("round-trips graph data", () => {
      graph.addExtractions(
        "file.md",
        makeExtraction(
          [
            { name: "Alice", type: "character", description: "A knight" },
            { name: "Bob", type: "character", description: "A wizard" },
          ],
          [{ source: "Alice", target: "Bob", type: "allies with", description: "Old friends" }],
        ),
        makeMeta("file.md"),
      );
      graph.markBuilt();

      const serialized = graph.serialize("test-model");
      const newGraph = new KnowledgeGraph();
      const success = newGraph.deserialize(serialized, "test-model");

      expect(success).toBe(true);
      expect(newGraph.getEntityCount()).toBe(2);
      expect(newGraph.getRelationCount()).toBe(1);
      expect(newGraph.getFileCount()).toBe(1);
      expect(newGraph.findEntities("Alice")).toHaveLength(1);
    });

    test("rejects mismatched model ID", () => {
      graph.addExtractions(
        "file.md",
        makeExtraction([
          { name: "Alice", type: "character", description: "A knight" },
        ]),
        makeMeta("file.md"),
      );

      const serialized = graph.serialize("model-a");
      const newGraph = new KnowledgeGraph();
      const success = newGraph.deserialize(serialized, "model-b");

      expect(success).toBe(false);
      expect(newGraph.getEntityCount()).toBe(0);
    });
  });

  // ── clear ────────────────────────────────────────────────────────

  describe("clear", () => {
    test("removes all data", () => {
      graph.addExtractions(
        "file.md",
        makeExtraction(
          [{ name: "Alice", type: "character", description: "A knight" }],
          [{ source: "Alice", target: "Bob", type: "knows", description: "" }],
        ),
        makeMeta("file.md"),
      );

      graph.clear();
      expect(graph.getEntityCount()).toBe(0);
      expect(graph.getRelationCount()).toBe(0);
      expect(graph.getFileCount()).toBe(0);
    });
  });
});
