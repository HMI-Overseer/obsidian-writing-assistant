import type { App } from "obsidian";
import { Notice } from "obsidian";
import type { RagSettings, IndexingState } from "./types";
import type { EmbeddingModel, ProviderSettingsMap } from "../shared/types";
import type { RagContextBlock } from "../shared/chatRequest";
import { VectorStore } from "./vectorStore";
import { VaultIndexer } from "./indexer";
import { Retriever } from "./retriever";
import { LMStudioEmbeddingClient } from "./lmStudioEmbedding";
import type { EmbeddingClient } from "./embeddingClient";
import type { GraphService } from "./graph";
import { boostByGraphRelevance, annotateBlockWithGraph } from "./graph/retrieval";

const INDEX_FILE = "rag-index.json";

/**
 * Top-level facade for RAG functionality.
 *
 * Lifecycle:
 * - `configure()` — loads persisted index from disk. No API calls. Safe for plugin load.
 * - `startIndexing()` — user-initiated full vault scan. Makes embedding API calls.
 * - `stopIndexing()` — cancels in-progress indexing.
 * - `retrieve()` — query-time retrieval against the loaded index.
 */
export class RagService {
  private readonly app: App;
  private store: VectorStore | null = null;
  private indexer: VaultIndexer | null = null;
  private retriever: Retriever | null = null;
  private embeddingClient: EmbeddingClient | null = null;
  private indexingState: IndexingState = { status: "idle" };
  private embeddingErrorShown = false;
  private onStateChangeCallback: ((state: IndexingState) => void) | null = null;

  /** Tracks the settings used by the currently configured pipeline. */
  private configuredModelId: string | null = null;
  private maxContextChars = 6000;
  private graphService: GraphService | null = null;

  constructor(app: App) {
    this.app = app;
  }

  /** Whether RAG is configured, enabled, and has an index ready for retrieval. */
  isReady(): boolean {
    return this.retriever !== null && this.store !== null && this.store.getChunkCount() > 0;
  }

  /** Whether the store has been set up (even if empty). */
  isConfigured(): boolean {
    return this.store !== null && this.retriever !== null;
  }

  getIndexingState(): IndexingState {
    return this.indexingState;
  }

  getChunkCount(): number {
    return this.store?.getChunkCount() ?? 0;
  }

  getFileCount(): number {
    return this.store?.getFileCount() ?? 0;
  }

  /** Register a callback for indexing state changes. Pass null to unregister. */
  onIndexingStateChange(callback: ((state: IndexingState) => void) | null): void {
    this.onStateChangeCallback = callback;
  }

  /**
   * Whether the current settings differ from what the persisted index was built with.
   * Returns true if a rebuild is recommended (model changed, chunk settings changed).
   */
  needsReindex(ragSettings: RagSettings): boolean {
    if (!this.store || this.store.getChunkCount() === 0) return false;

    const storedChunkSize = this.store.getChunkSize();
    const storedChunkOverlap = this.store.getChunkOverlap();

    // If stored values are 0, the index was built before we tracked these — recommend rebuild.
    if (storedChunkSize === 0) return true;

    return (
      storedChunkSize !== ragSettings.chunkSize ||
      storedChunkOverlap !== ragSettings.chunkOverlap
    );
  }

  /**
   * Configure the RAG pipeline without scanning the vault.
   *
   * Loads the persisted index from disk and sets up a retriever so queries
   * work immediately against the existing index. Makes NO embedding API calls
   * and does NOT register vault watchers. Safe for plugin load.
   */
  async configure(
    ragSettings: RagSettings,
    embeddingModels: EmbeddingModel[],
    providerSettings: ProviderSettingsMap,
  ): Promise<void> {
    this.shutdown();

    if (!ragSettings.enabled || !ragSettings.activeEmbeddingModelId) {
      return;
    }

    const model = embeddingModels.find((m) => m.id === ragSettings.activeEmbeddingModelId);
    if (!model) return;

    const client = this.createEmbeddingClient(model, providerSettings);
    if (!client) return;

    this.embeddingClient = client;
    this.configuredModelId = model.modelId;
    this.maxContextChars = ragSettings.maxContextChars;
    this.store = new VectorStore(model.modelId, 0, ragSettings.chunkSize, ragSettings.chunkOverlap);

    // Load persisted index from disk (no API calls).
    await this.loadIndex();

    this.retriever = new Retriever({
      store: this.store,
      embeddingClient: client,
      embeddingModelId: model.modelId,
      topK: ragSettings.topK,
      minScore: ragSettings.minScore,
    });
  }

  /**
   * Start a full vault scan. User-initiated only (via "Build index" button).
   *
   * This is the only method that makes embedding API calls. If the embedding
   * model isn't loaded in LM Studio, it will fail with a clear error.
   */
  async startIndexing(
    ragSettings: RagSettings,
    embeddingModels: EmbeddingModel[],
    providerSettings: ProviderSettingsMap,
  ): Promise<void> {
    // Ensure configured first.
    if (!this.store || !this.embeddingClient) {
      await this.configure(ragSettings, embeddingModels, providerSettings);
    }

    if (!this.store || !this.embeddingClient || !this.configuredModelId) {
      this.setIndexingState({ status: "error", message: "Select an embedding model first." });
      return;
    }

    // Tear down any existing indexer.
    this.indexer?.destroy();

    // Update store's chunk settings for the new build.
    this.store = new VectorStore(
      this.configuredModelId,
      this.store.getDimensions(),
      ragSettings.chunkSize,
      ragSettings.chunkOverlap,
    );

    // Re-load existing index so incremental indexing can detect stale files.
    await this.loadIndex();

    // Update retriever to point at the new store.
    this.retriever = new Retriever({
      store: this.store,
      embeddingClient: this.embeddingClient,
      embeddingModelId: this.configuredModelId,
      topK: ragSettings.topK,
      minScore: ragSettings.minScore,
    });

    this.indexer = new VaultIndexer({
      app: this.app,
      store: this.store,
      embeddingClient: this.embeddingClient,
      embeddingModelId: this.configuredModelId,
      chunkSize: ragSettings.chunkSize,
      chunkOverlap: ragSettings.chunkOverlap,
      excludePatterns: ragSettings.excludePatterns,
      onStateChange: (state) => this.setIndexingState(state),
      onSave: () => this.saveIndex(),
    });

    await this.indexer.start();
  }

  /** Cancel in-progress indexing. */
  stopIndexing(): void {
    this.indexer?.destroy();
    this.indexer = null;
    this.setIndexingState({ status: "idle" });
  }

  /** Force a full re-index: clear the index, then start scanning. */
  async rebuild(
    ragSettings: RagSettings,
    embeddingModels: EmbeddingModel[],
    providerSettings: ProviderSettingsMap,
  ): Promise<void> {
    this.indexer?.destroy();
    this.indexer = null;
    this.store?.clear();
    await this.deleteIndex();
    await this.startIndexing(ragSettings, embeddingModels, providerSettings);
  }

  /**
   * Retrieve relevant context for a user query.
   * Returns null if RAG is not ready, or an empty array on failure.
   *
   * Applies two-layer filtering after retrieval:
   * 1. Score gap detection — cuts off results after a large relevance drop.
   * 2. Relative threshold — excludes results below 60% of the best score.
   * 3. Character budget — ensures total context stays within budget.
   */
  async retrieve(query: string, activeFilePath?: string): Promise<RagContextBlock[] | null> {
    if (!this.retriever || !this.isReady()) {
      return null;
    }

    try {
      const results = await this.retriever.retrieve(query, activeFilePath);
      if (results.length === 0) return null;

      // Graph boost: re-rank results using knowledge graph entity relevance.
      let boosted = results;
      let graphContext: ReturnType<GraphService["buildGraphContext"]> = null;
      if (this.graphService?.isReady()) {
        graphContext = this.graphService.buildGraphContext(query);
        if (graphContext && graphContext.relevantFiles.size > 0) {
          boosted = boostByGraphRelevance(boosted, graphContext.relevantFiles);
        }
      }

      let filtered = boosted;

      // Relative threshold: exclude results below 60% of the best score.
      const bestScore = filtered[0].score;
      filtered = filtered.filter((r) => r.score >= bestScore * 0.6);

      // Score gap detection: cut off after a >30% relative drop between consecutive results.
      for (let i = 1; i < filtered.length; i++) {
        if (filtered[i].score < filtered[i - 1].score * 0.7) {
          filtered = filtered.slice(0, i);
          break;
        }
      }

      // Character budget: drop lowest-scoring results if total exceeds budget.
      const maxChars = this.maxContextChars;
      let totalChars = 0;
      const budgeted: typeof filtered = [];
      for (const r of filtered) {
        totalChars += r.chunk.content.length;
        if (totalChars > maxChars && budgeted.length > 0) break;
        budgeted.push(r);
      }

      let blocks = budgeted.map((r) => ({
        filePath: r.chunk.filePath,
        headingPath: r.chunk.headingPath,
        content: r.chunk.content,
        score: r.score,
      }));

      // Annotate blocks with graph entity/relationship context.
      if (graphContext?.matchedEntities.length && this.graphService?.isReady()) {
        const graph = this.graphService.getGraph()!;
        blocks = blocks.map((block) =>
          annotateBlockWithGraph(block, graph, graphContext!.matchedEntities),
        );
      }

      return blocks;
    } catch {
      if (!this.embeddingErrorShown) {
        new Notice("Could not reach embedding model. Skipping retrieval.");
        this.embeddingErrorShown = true;
      }
      return null;
    }
  }

  /** Shut down the indexer and release resources. */
  shutdown(): void {
    this.indexer?.destroy();
    this.indexer = null;
    this.retriever = null;
    this.embeddingClient = null;
    this.configuredModelId = null;
    this.store = null;
    this.indexingState = { status: "idle" };
    this.embeddingErrorShown = false;
  }

  /** Wire the graph service for graph-enhanced retrieval. */
  setGraphService(graphService: GraphService): void {
    this.graphService = graphService;
  }

  /** Clean shutdown — call from plugin `onunload()`. */
  destroy(): void {
    this.shutdown();
    this.onStateChangeCallback = null;
  }

  private setIndexingState(state: IndexingState): void {
    this.indexingState = state;
    this.onStateChangeCallback?.(state);
  }

  private createEmbeddingClient(
    model: EmbeddingModel,
    providerSettings: ProviderSettingsMap,
  ): EmbeddingClient | null {
    switch (model.provider) {
      case "lmstudio":
        return new LMStudioEmbeddingClient(
          providerSettings.lmstudio.baseUrl,
          providerSettings.lmstudio.bypassCors,
        );
      case "openai":
        return new LMStudioEmbeddingClient(
          providerSettings.openai.baseUrl,
          false,
          { Authorization: `Bearer ${providerSettings.openai.apiKey}` },
        );
      default:
        return null;
    }
  }

  private getIndexPath(): string {
    const pluginDir = `${this.app.vault.configDir}/plugins/obsidian-writing-assistant`;
    return `${pluginDir}/${INDEX_FILE}`;
  }

  private async loadIndex(): Promise<void> {
    if (!this.store) return;

    try {
      const path = this.getIndexPath();
      const exists = await this.app.vault.adapter.exists(path);
      if (!exists) return;

      const raw = await this.app.vault.adapter.read(path);
      const data = JSON.parse(raw);

      if (!this.store.deserialize(data)) {
        // Model mismatch — index was built with a different model.
        this.store.clear();
      }
    } catch {
      // Corrupt index file — will rebuild.
      this.store.clear();
    }
  }

  private async saveIndex(): Promise<void> {
    if (!this.store) return;

    try {
      const data = this.store.serialize();
      const path = this.getIndexPath();
      await this.app.vault.adapter.write(path, JSON.stringify(data));
    } catch {
      // Non-fatal — index will be rebuilt on next load.
    }
  }

  private async deleteIndex(): Promise<void> {
    try {
      const path = this.getIndexPath();
      const exists = await this.app.vault.adapter.exists(path);
      if (exists) {
        await this.app.vault.adapter.remove(path);
      }
    } catch {
      // Non-fatal.
    }
  }
}
