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
