/** Result of an embedding request. */
export interface EmbeddingResult {
  /** One vector per input text. */
  vectors: number[][];
  /** Dimensionality of each vector. */
  dimensions: number;
  /** Token usage if reported by the provider. */
  usage?: { totalTokens: number };
}

/** Provider-agnostic embedding client, parallel to ChatClient. */
export interface EmbeddingClient {
  /**
   * Generate embeddings for one or more text inputs.
   * Returns one vector per input string.
   */
  embed(
    texts: string[],
    model: string,
    signal?: AbortSignal,
  ): Promise<EmbeddingResult>;
}

/**
 * Validate that an embedding response is well-formed for the inputs it answers:
 * exactly one vector per input, each a non-empty `number[]` of uniform length.
 *
 * A provider that truncates its response (fewer vectors than inputs) or returns
 * an empty/short vector otherwise poisons the index — the missing slot is stored
 * as an `undefined`/empty vector that crashes `cosineSimilarity` at query time
 * (laundered into a misleading "could not reach the model" notice) and silently
 * under-retrieves after a reload. Throwing here, at the boundary, keeps holes out
 * of the store and surfaces an honest, specific error instead.
 */
export function assertEmbeddingVectors(inputCount: number, vectors: number[][]): void {
  if (vectors.length !== inputCount) {
    throw new Error(
      `Embedding model returned ${vectors.length} vectors for ${inputCount} input(s).`,
    );
  }

  let dimension = 0;
  for (let i = 0; i < vectors.length; i++) {
    const vector = vectors[i];
    if (!Array.isArray(vector) || vector.length === 0) {
      throw new Error(`Embedding model returned an empty or missing vector at index ${i}.`);
    }
    if (i === 0) {
      dimension = vector.length;
    } else if (vector.length !== dimension) {
      throw new Error(
        `Embedding model returned inconsistent vector dimensions (${vector.length} vs ${dimension}).`,
      );
    }
  }
}
