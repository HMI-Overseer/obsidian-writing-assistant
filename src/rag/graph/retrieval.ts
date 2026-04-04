import type { KnowledgeGraph } from "./knowledgeGraph";
import type { GraphEntity } from "./types";
import type { RetrievalResult } from "../types";
import type { RagContextBlock, GraphContextAnnotation } from "../../shared/chatRequest";

/** Entities matched from the query, with their graph file relevance. */
export interface GraphRetrievalContext {
  /** Entities whose names appeared in the query. */
  matchedEntities: GraphEntity[];
  /** filePath → relevance (0–1), aggregated from all matched entities + their neighborhoods. */
  relevantFiles: Map<string, number>;
}

/**
 * Match entities from the knowledge graph against a user query.
 * Uses the graph's built-in substring search (case-insensitive).
 * Then traverses up to `maxHops` from each match to build a file relevance map.
 */
export function buildGraphContext(
  query: string,
  graph: KnowledgeGraph,
  maxHops = 2,
): GraphRetrievalContext {
  const matchedEntities = graph.findEntities(query);
  if (matchedEntities.length === 0) {
    return { matchedEntities: [], relevantFiles: new Map() };
  }

  const relevantFiles = new Map<string, number>();

  for (const entity of matchedEntities) {
    const entityFiles = graph.getRelevantFiles(entity.name, maxHops);
    for (const [filePath, relevance] of entityFiles) {
      const existing = relevantFiles.get(filePath) ?? 0;
      relevantFiles.set(filePath, Math.max(existing, relevance));
    }
  }

  return { matchedEntities, relevantFiles };
}

/**
 * Boost retrieval results whose source files are relevant per the knowledge graph.
 * Formula: score * (1 + relevance * strength), then re-sort descending.
 * Returns a new array — does not mutate the input.
 */
export function boostByGraphRelevance(
  results: RetrievalResult[],
  relevantFiles: Map<string, number>,
  strength = 0.2,
): RetrievalResult[] {
  const boosted = results.map((r) => {
    const relevance = relevantFiles.get(r.chunk.filePath);
    if (relevance === undefined) return r;
    return { ...r, score: r.score * (1 + relevance * strength) };
  });

  boosted.sort((a, b) => b.score - a.score);
  return boosted;
}

/**
 * Annotate a RAG context block with entity/relationship data from the knowledge graph.
 *
 * Finds entities in the block's file, intersects with matched query entities and their
 * 1-hop neighbors, then attaches relevant relationships. Returns the block unchanged
 * if no relevant entities are found.
 */
export function annotateBlockWithGraph(
  block: RagContextBlock,
  graph: KnowledgeGraph,
  matchedEntities: GraphEntity[],
): RagContextBlock {
  const fileEntities = graph.getEntitiesInFile(block.filePath);
  if (fileEntities.length === 0) return block;

  // Build the set of relevant entity names (normalized): matched entities + their 1-hop neighbors.
  const relevantNames = new Set<string>();
  for (const entity of matchedEntities) {
    const neighborhood = graph.getNeighborhood(entity.name, 1);
    for (const name of neighborhood.keys()) {
      relevantNames.add(name);
    }
  }

  // Intersect file entities with the relevant set.
  const filtered = fileEntities.filter((e) =>
    relevantNames.has(e.name.trim().toLowerCase()),
  );
  if (filtered.length === 0) return block;

  // Collect relationships where both endpoints are in the relevant set.
  const seenRelations = new Set<string>();
  const relationships: GraphContextAnnotation["relationships"] = [];

  for (const entity of filtered) {
    for (const rel of graph.getRelations(entity.name)) {
      const key = `${rel.source}|${rel.target}|${rel.type}`;
      if (seenRelations.has(key)) continue;

      const sourceNorm = rel.source.trim().toLowerCase();
      const targetNorm = rel.target.trim().toLowerCase();
      if (relevantNames.has(sourceNorm) && relevantNames.has(targetNorm)) {
        seenRelations.add(key);
        relationships.push({
          source: rel.source,
          target: rel.target,
          type: rel.type,
          description: rel.description,
        });
      }
    }
  }

  const entities = filtered.map((e) => ({
    name: e.name,
    type: e.type,
    description: e.description,
  }));

  return { ...block, graphContext: { entities, relationships } };
}
