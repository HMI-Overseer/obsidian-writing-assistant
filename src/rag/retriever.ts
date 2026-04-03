import type { EmbeddingClient } from "./embeddingClient";
import type { RetrievalResult } from "./types";
import type { VectorStore } from "./vectorStore";
import { topKSimilar, deduplicateByFile } from "./vectorMath";

export interface RetrieverOptions {
  store: VectorStore;
  embeddingClient: EmbeddingClient;
  embeddingModelId: string;
  topK: number;
  minScore: number;
}

/**
 * Query-time retriever: embeds the user query and searches the vector store.
 */
export class Retriever {
  private readonly store: VectorStore;
  private readonly client: EmbeddingClient;
  private readonly modelId: string;
  private readonly topK: number;
  private readonly minScore: number;

  constructor(options: RetrieverOptions) {
    this.store = options.store;
    this.client = options.embeddingClient;
    this.modelId = options.embeddingModelId;
    this.topK = options.topK;
    this.minScore = options.minScore;
  }

  /**
   * Retrieve the most relevant chunks for a query string.
   * Returns an empty array if the store is empty or embedding fails.
   */
  async retrieve(query: string, signal?: AbortSignal): Promise<RetrievalResult[]> {
    if (this.store.getChunkCount() === 0 || !query.trim()) {
      return [];
    }

    const result = await this.client.embed([query], this.modelId, signal);

    if (result.vectors.length === 0) {
      return [];
    }

    const queryVector = result.vectors[0];
    const allChunks = this.store.getAllChunks();
    const topResults = topKSimilar(queryVector, allChunks, this.topK * 2, this.minScore);

    return deduplicateByFile(topResults).slice(0, this.topK);
  }
}
