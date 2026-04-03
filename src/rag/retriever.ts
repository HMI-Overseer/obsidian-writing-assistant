import type { App } from "obsidian";
import type { EmbeddingClient } from "./embeddingClient";
import type { RetrievalResult } from "./types";
import type { VectorStore } from "./vectorStore";
import { topKSimilar, limitPerFile, boostLinkedFiles } from "./vectorMath";

export interface RetrieverOptions {
  app: App;
  store: VectorStore;
  embeddingClient: EmbeddingClient;
  embeddingModelId: string;
  topK: number;
  minScore: number;
  graphBoostEnabled: boolean;
  graphBoostStrength: number;
}

/**
 * Query-time retriever: embeds the user query and searches the vector store.
 * Optionally applies graph-aware score boosting based on outgoing wikilinks
 * from the active note.
 */
export class Retriever {
  private readonly app: App;
  private readonly store: VectorStore;
  private readonly client: EmbeddingClient;
  private readonly modelId: string;
  private readonly topK: number;
  private readonly minScore: number;
  private readonly graphBoostEnabled: boolean;
  private readonly graphBoostStrength: number;

  constructor(options: RetrieverOptions) {
    this.app = options.app;
    this.store = options.store;
    this.client = options.embeddingClient;
    this.modelId = options.embeddingModelId;
    this.topK = options.topK;
    this.minScore = options.minScore;
    this.graphBoostEnabled = options.graphBoostEnabled;
    this.graphBoostStrength = options.graphBoostStrength;
  }

  /**
   * Retrieve the most relevant chunks for a query string.
   * Returns an empty array if the store is empty or embedding fails.
   *
   * @param activeFilePath - Path of the currently active note; used for graph boost.
   */
  async retrieve(query: string, activeFilePath?: string, signal?: AbortSignal): Promise<RetrievalResult[]> {
    if (this.store.getChunkCount() === 0 || !query.trim()) {
      return [];
    }

    const result = await this.client.embed([query], this.modelId, signal);

    if (result.vectors.length === 0) {
      return [];
    }

    const queryVector = result.vectors[0];
    const allChunks = this.store.getAllChunks();
    let topResults = topKSimilar(queryVector, allChunks, this.topK * 3, this.minScore);

    // Apply graph-aware boost from outgoing links of the active note.
    if (this.graphBoostEnabled && activeFilePath) {
      const linkedPaths = this.getOutgoingLinks(activeFilePath);
      topResults = boostLinkedFiles(topResults, linkedPaths, this.graphBoostStrength);
    }

    return limitPerFile(topResults).slice(0, this.topK);
  }

  /**
   * Get the set of file paths that the given note links to (outgoing only).
   * Uses Obsidian's resolvedLinks which maps source → { target: linkCount }.
   */
  private getOutgoingLinks(filePath: string): Set<string> {
    const resolved = this.app.metadataCache.resolvedLinks[filePath];
    if (!resolved) return new Set();
    return new Set(Object.keys(resolved));
  }
}
