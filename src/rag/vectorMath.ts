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
 * Deduplicate retrieval results by file path.
 * Keeps only the highest-scoring chunk per file.
 */
export function deduplicateByFile(results: RetrievalResult[]): RetrievalResult[] {
  const seen = new Map<string, RetrievalResult>();

  for (const result of results) {
    const existing = seen.get(result.chunk.filePath);
    if (!existing || result.score > existing.score) {
      seen.set(result.chunk.filePath, result);
    }
  }

  return [...seen.values()].sort((a, b) => b.score - a.score);
}
