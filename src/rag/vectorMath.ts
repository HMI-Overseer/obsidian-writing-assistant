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
