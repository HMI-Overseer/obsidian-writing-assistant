import type { IndexedChunk, RetrievalResult } from "./types";

/**
 * Cosine similarity between two vectors.
 * Returns a value in [-1, 1] where 1 means identical direction.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Find the top-K most similar chunks to a query vector.
 * Returns results sorted by descending similarity, filtered by `minScore`.
 */
export function topKSimilar(
  query: number[],
  chunks: IndexedChunk[],
  k: number,
  minScore: number,
): RetrievalResult[] {
  const scored: RetrievalResult[] = [];

  for (const chunk of chunks) {
    const score = cosineSimilarity(query, chunk.vector);
    if (score >= minScore) {
      scored.push({
        chunk: {
          id: chunk.id,
          filePath: chunk.filePath,
          headingPath: chunk.headingPath,
          content: chunk.content,
          startOffset: chunk.startOffset,
          chunkIndex: chunk.chunkIndex,
        },
        score,
      });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, k);
}

/**
 * Limit retrieval results per file path.
 * Keeps up to `maxPerFile` highest-scoring chunks per file (default 2).
 */
export function limitPerFile(
  results: RetrievalResult[],
  maxPerFile: number = 2,
): RetrievalResult[] {
  const counts = new Map<string, number>();
  const filtered: RetrievalResult[] = [];

  // Results are already sorted by descending score from topKSimilar.
  for (const result of results) {
    const count = counts.get(result.chunk.filePath) ?? 0;
    if (count < maxPerFile) {
      filtered.push(result);
      counts.set(result.chunk.filePath, count + 1);
    }
  }

  return filtered;
}

/**
 * Apply an adaptive score boost to results from files linked by the active note.
 *
 * Only outgoing links are used (not backlinks) — outgoing links are intentional
 * references the author made, encoding genuine semantic relationships.
 *
 * The boost tapers as link count increases to prevent hub notes (MOCs, indexes)
 * from inflating everything they touch:
 *   boostFactor = 1 + (strength / (1 + linkCount / 10))
 *   At  5 links: ~1.10 boost (with default strength 0.15)
 *   At 20 links: ~1.05 boost
 *   At 50 links: ~1.02 boost (negligible)
 *
 * Results are re-sorted by boosted score after application.
 */
export function boostLinkedFiles(
  results: RetrievalResult[],
  linkedFilePaths: Set<string>,
  strength: number = 0.15,
): RetrievalResult[] {
  if (linkedFilePaths.size === 0) return results;

  const linkCount = linkedFilePaths.size;
  const boostFactor = 1 + (strength / (1 + linkCount / 10));

  const boosted = results.map((r) => {
    if (linkedFilePaths.has(r.chunk.filePath)) {
      return { ...r, score: r.score * boostFactor };
    }
    return r;
  });

  boosted.sort((a, b) => b.score - a.score);
  return boosted;
}
