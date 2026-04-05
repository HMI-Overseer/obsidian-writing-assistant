import type { KnowledgeGraph } from "./knowledgeGraph";
import type { GraphEntity, GraphRelation } from "./types";
import type { RetrievalResult } from "../types";
import type { RagContextBlock } from "../../shared/chatRequest";

/** Entities matched from the query, with their graph file relevance. */
export interface GraphRetrievalContext {
  /** Entities whose names appeared in the query. */
  matchedEntities: GraphEntity[];
  /** filePath → relevance (0–1), aggregated from all matched entities + their neighborhoods. */
  relevantFiles: Map<string, number>;
}

const ENTITY_TOP_K = 10;
const ENTITY_MIN_SCORE = 0.5;

/** Max entities/relationships injected per RAG block to prevent context explosion. */
const MAX_ANNOTATED_ENTITIES = 5;
const MAX_ANNOTATED_RELATIONS = 10;

/**
 * Match entities from the knowledge graph against a user query.
 * Accepts either a pre-computed query vector (for embedding-based search) or a raw
 * string (for substring fallback). Then traverses up to `maxHops` from each match
 * to build a file relevance map.
 */
export function buildGraphContext(
  query: string | number[],
  graph: KnowledgeGraph,
  maxHops = 2,
): GraphRetrievalContext {
  const matchedEntities = Array.isArray(query)
    ? graph.findEntitiesByEmbedding(query, ENTITY_TOP_K, ENTITY_MIN_SCORE)
    : graph.findEntities(query);

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

  // Only annotate entities that directly matched the query in this file.
  // The 1-hop neighborhood expansion is already used in buildGraphContext for
  // file relevance boosting — re-expanding here is what causes context explosion.
  const matchedNames = new Set(matchedEntities.map((e) => e.name.trim().toLowerCase()));
  const filtered = fileEntities
    .filter((e) => matchedNames.has(e.name.trim().toLowerCase()))
    .slice(0, MAX_ANNOTATED_ENTITIES);

  if (filtered.length === 0) return block;

  // Collect relationships between the annotated entities only.
  // Sort by weight so the most-referenced relationships survive the cap.
  const filteredNames = new Set(filtered.map((e) => e.name.trim().toLowerCase()));
  const seenRelations = new Set<string>();
  const candidateRels: GraphRelation[] = [];

  for (const entity of filtered) {
    for (const rel of graph.getRelations(entity.name)) {
      const key = `${rel.source}|${rel.target}|${rel.type}`;
      if (seenRelations.has(key)) continue;
      const sourceNorm = rel.source.trim().toLowerCase();
      const targetNorm = rel.target.trim().toLowerCase();
      if (filteredNames.has(sourceNorm) || filteredNames.has(targetNorm)) {
        seenRelations.add(key);
        candidateRels.push(rel);
      }
    }
  }

  candidateRels.sort((a, b) => b.weight - a.weight);
  const relationships = candidateRels.slice(0, MAX_ANNOTATED_RELATIONS).map((r) => ({
    source: r.source,
    target: r.target,
    type: r.type,
    description: r.description,
  }));

  const entities = filtered.map((e) => ({
    name: e.name,
    type: e.type,
    description: e.description,
  }));

  return { ...block, graphContext: { entities, relationships } };
}
