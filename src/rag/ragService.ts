import type { App } from "obsidian";
import { Notice } from "obsidian";
import type { RagSettings, IndexingState } from "./types";
import type { EmbeddingModel, ProviderSettingsMap } from "../shared/types";
import type { RagContextBlock } from "../shared/chatRequest";
import { VectorStore, isSerializedVectorIndex } from "./vectorStore";
import { VaultIndexer } from "./indexer";
import { Retriever } from "./retriever";
import { LMStudioEmbeddingClient } from "./lmStudioEmbedding";
import type { EmbeddingClient } from "./embeddingClient";
import type { GraphService } from "./graph";
import { boostByGraphRelevance, annotateBlockWithGraph } from "./graph/retrieval";

const INDEX_FILE = "rag-index.json";

/**
 * Why semantic search can or cannot run, computed synchronously (no network probe):
 * - `no-backend`, no embedding model configured; there is no index and none can be built.
 * - `index-empty`, a backend is configured but nothing has been indexed yet.
 * - `ready`, a backend is configured and an index is present.
 *
 * The fourth real state, a *live* backend that is currently unreachable, is not
 * here, because it is only knowable by actually hitting it. It surfaces as a thrown
 * {@link RagRetrievalError} from {@link RagService.retrieve}, not from this enum.
 */
export type RagAvailability = "ready" | "no-backend" | "index-empty";

/**
 * Thrown by {@link RagService.retrieve} when a backend is configured and an index
 * exists, but the embedding request itself failed (model stopped/unloaded, endpoint
 * down). This is a *failure to run*, deliberately distinct from an empty result set,
 * callers must not treat it as "the vault has nothing."
 */
export class RagRetrievalError extends Error {
  constructor(message = "Embedding request failed.") {
    super(message);
    this.name = "RagRetrievalError";
  }
}

/** Create an EmbeddingClient for the given model. Shared by RagService and GraphService. */
export function createEmbeddingClient(
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

/**
 * Decides, without loading anything, whether an *automatic* (re)index may embed
 * with the given model right now. Local models must already be loaded; cloud
 * models only when the user opted into auto-reindex on cloud. Manual builds
 * bypass this. Injected by the service container, which owns model availability.
 */
export type AutoEmbedGate = (model: EmbeddingModel) => Promise<boolean>;

/**
 * Top-level facade for RAG functionality.
 *
 * Lifecycle:
 * - `configure()`, loads the persisted index and, per settings, starts watching
 *   the vault and/or runs a gated startup catch-up scan. No forced model load.
 * - `startIndexing()`, user-initiated full vault scan. Makes embedding API calls.
 * - `stopIndexing()`, cancels in-progress indexing.
 * - `retrieve()`, query-time retrieval against the loaded index.
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
  /**
   * A persistent status notifier for the composer knowledge chip, kept separate
   * from {@link onStateChangeCallback} (which the popover and settings tab claim
   * and release). Fires on indexing-state and staleness changes so the collapsed
   * chip can reflect a background deferral even while its popover is closed.
   */
  private onStatusChangeCallback: (() => void) | null = null;
  private autoEmbedGate: AutoEmbedGate | null = null;

  /** Tracks the settings used by the currently configured pipeline. */
  private configuredModelId: string | null = null;
  private maxContextChars = 6000;
  private graphService: GraphService | null = null;

  constructor(
    app: App,
    private readonly pluginDir: string,
  ) {
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

  /**
   * Why semantic search can or cannot run right now, without a network probe.
   * The single readiness signal both advertising routes (in-app tool list and the
   * Claude Code MCP bridge) and the tool handler read from, so they cannot drift.
   * Does not detect a configured-but-unreachable backend, see {@link RagRetrievalError}.
   */
  availability(): RagAvailability {
    if (!this.isConfigured()) return "no-backend";
    if (this.getChunkCount() === 0) return "index-empty";
    return "ready";
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
   * Register the persistent chip notifier (indexing-state or staleness changes).
   * Pass null to unregister. Survives {@link configure}/{@link shutdown} so a
   * background deferral repaints the chip; cleared only on {@link destroy}.
   */
  onStatusChange(callback: (() => void) | null): void {
    this.onStatusChangeCallback = callback;
  }

  /** Inject the gate that decides whether an automatic reindex may embed now. */
  setAutoEmbedGate(gate: AutoEmbedGate): void {
    this.autoEmbedGate = gate;
  }

  /** Files known to have changed since indexing but not yet re-embedded. */
  getStaleCount(): number {
    return this.indexer?.getDeferredCount() ?? 0;
  }

  /** Whether the index is out of date (changed files await an available model). */
  isStale(): boolean {
    return this.getStaleCount() > 0;
  }

  /**
   * Whether the current settings differ from what the persisted index was built with.
   * Returns true if a rebuild is recommended (model changed, chunk settings changed).
   */
  needsReindex(ragSettings: RagSettings): boolean {
    if (!this.store || this.store.getChunkCount() === 0) return false;

    const storedChunkSize = this.store.getChunkSize();
    const storedChunkOverlap = this.store.getChunkOverlap();

    // If stored values are 0, the index was built before we tracked these, recommend rebuild.
    if (storedChunkSize === 0) return true;

    // Enrichment setting doesn't match what the index was built with.
    if (this.store.getMetadataEnriched() !== ragSettings.metadataEnrichment) return true;

    return (
      storedChunkSize !== ragSettings.chunkSize ||
      storedChunkOverlap !== ragSettings.chunkOverlap
    );
  }

  /**
   * Configure the RAG pipeline. Loads the persisted index from disk and sets up
   * a retriever so queries work immediately against the existing index, then,
   * per settings, registers live vault watchers ({@link RagSettings.watchForChanges}).
   * Makes no embedding API calls itself, watcher-triggered indexing and the
   * separate {@link runStartupCatchUp} scan are both gated so they never
   * force-load a local embedding model. Safe for plugin load.
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
    const store = new VectorStore(model.modelId, 0, ragSettings.chunkSize, ragSettings.chunkOverlap);
    this.store = store;

    // Load persisted index from disk (no API calls).
    await this.loadIndex();

    this.retriever = new Retriever({
      store,
      embeddingClient: client,
      embeddingModelId: model.modelId,
      topK: ragSettings.topK,
      maxChunksPerFile: ragSettings.maxChunksPerFile,
      minScore: ragSettings.minScore,
    });

    // Keep watching the vault so live edits reindex without a manual rebuild.
    // The startup catch-up scan is a load-time concern, driven separately by
    // runStartupCatchUp so a mere reconfigure (e.g. a model switch) never kicks
    // an unexpected full rebuild.
    this.setupAutoIndexer(ragSettings, model, store, client, model.modelId);
  }

  /**
   * Wire the automatic indexer per settings. Registers live watchers when
   * `watchForChanges` is on. Also created (idle) when only `reindexOnStartup`
   * is on, so {@link runStartupCatchUp} has an indexer to scan with.
   */
  private setupAutoIndexer(
    ragSettings: RagSettings,
    model: EmbeddingModel,
    store: VectorStore,
    client: EmbeddingClient,
    modelId: string,
  ): void {
    if (!ragSettings.watchForChanges && !ragSettings.reindexOnStartup) return;

    this.indexer = this.createIndexer(ragSettings, model, store, client, modelId);
    if (ragSettings.watchForChanges) this.indexer.beginWatching();
  }

  /**
   * Run the load-time catch-up scan when `reindexOnStartup` is on: absorbs edits
   * made while the plugin was off. Fire-and-forget and gated, so a not-yet-loaded
   * local model defers (marking the index stale) instead of being force-loaded.
   * Call once after {@link configure}, not on every reconfigure.
   */
  runStartupCatchUp(ragSettings: RagSettings): void {
    if (!ragSettings.reindexOnStartup) return;
    void this.indexer?.runFullScan({ gated: true });
  }

  /** Build a VaultIndexer bound to the given store, model, and the auto-embed gate. */
  private createIndexer(
    ragSettings: RagSettings,
    model: EmbeddingModel,
    store: VectorStore,
    client: EmbeddingClient,
    modelId: string,
  ): VaultIndexer {
    const gate = this.autoEmbedGate;
    return new VaultIndexer({
      app: this.app,
      store,
      embeddingClient: client,
      embeddingModelId: modelId,
      chunkSize: ragSettings.chunkSize,
      chunkOverlap: ragSettings.chunkOverlap,
      excludePatterns: ragSettings.excludePatterns,
      metadataEnrichment: ragSettings.metadataEnrichment,
      watchForChanges: ragSettings.watchForChanges,
      canAutoEmbed: gate ? () => gate(model) : undefined,
      onStateChange: (state) => this.setIndexingState(state),
      onSave: () => this.saveIndex(),
      onStale: () => this.notifyStatus(),
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

    const model = embeddingModels.find((m) => m.id === ragSettings.activeEmbeddingModelId);
    if (!model) {
      this.setIndexingState({ status: "error", message: "Select an embedding model first." });
      return;
    }

    // Capture the (guard-narrowed) pipeline deps before the teardown/await below,
    // which would otherwise widen the class fields back to nullable.
    const client = this.embeddingClient;
    const modelId = this.configuredModelId;
    const dimensions = this.store.getDimensions();

    // Tear down any existing indexer.
    this.indexer?.destroy();

    // Update store's chunk settings for the new build.
    const store = new VectorStore(
      modelId,
      dimensions,
      ragSettings.chunkSize,
      ragSettings.chunkOverlap,
      ragSettings.metadataEnrichment,
    );
    this.store = store;

    // Re-load existing index so incremental indexing can detect stale files.
    await this.loadIndex();

    // Update retriever to point at the new store.
    this.retriever = new Retriever({
      store,
      embeddingClient: client,
      embeddingModelId: modelId,
      topK: ragSettings.topK,
      maxChunksPerFile: ragSettings.maxChunksPerFile,
      minScore: ragSettings.minScore,
    });

    // A manual build is user-initiated, so its scan is ungated (it may load the
    // model). Live watchers still honor watchForChanges and stay gated after.
    this.indexer = this.createIndexer(ragSettings, model, store, client, modelId);
    this.indexer.beginWatching();
    await this.indexer.runFullScan({ gated: false });
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
   * Returns null if RAG is not ready or the query matched nothing. Throws
   * {@link RagRetrievalError} when the embedding backend is unreachable, a
   * failure to run, which callers must not confuse with an empty result.
   *
   * Applies three filters after retrieval, in order:
   * 1. Relative threshold, excludes results below 60% of the best score.
   * 2. Score gap detection, cuts off after a large relevance drop.
   * 3. Character budget, keeps total context within budget.
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
      let graphContext: Awaited<ReturnType<GraphService["buildGraphContext"]>> = null;
      if (this.graphService?.isReady()) {
        graphContext = await this.graphService.buildGraphContext(query);
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
      if (graphContext && graphContext.matchedEntities.length && this.graphService?.isReady()) {
        const graph = this.graphService.getGraph();
        const entities = graphContext.matchedEntities;
        if (graph) {
          blocks = blocks.map((block) =>
            annotateBlockWithGraph(block, graph, entities),
          );
        }
      }

      return blocks;
    } catch (e) {
      // Embedding/transport failure, NOT an empty vault. The Notice is the
      // user's channel; the thrown error is the model's, so a tool result can
      // say "could not run" instead of laundering it into "found nothing".
      if (!this.embeddingErrorShown) {
        new Notice("Could not reach embedding model. Skipping retrieval.");
        this.embeddingErrorShown = true;
      }
      throw new RagRetrievalError(e instanceof Error ? e.message : undefined);
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

  /** Clean shutdown, call from plugin `onunload()`. */
  destroy(): void {
    this.shutdown();
    this.onStateChangeCallback = null;
    this.onStatusChangeCallback = null;
  }

  private setIndexingState(state: IndexingState): void {
    this.indexingState = state;
    this.onStateChangeCallback?.(state);
    this.onStatusChangeCallback?.();
  }

  /**
   * Notify listeners that status changed without an indexing-state transition
   * (a staleness change). Re-emits the current state to the state-change
   * consumer, which re-reads the snapshot, and pings the persistent chip notifier.
   */
  private notifyStatus(): void {
    this.onStateChangeCallback?.(this.indexingState);
    this.onStatusChangeCallback?.();
  }

  private createEmbeddingClient(
    model: EmbeddingModel,
    providerSettings: ProviderSettingsMap,
  ): EmbeddingClient | null {
    return createEmbeddingClient(model, providerSettings);
  }

  private getIndexPath(): string {
    return `${this.pluginDir}/${INDEX_FILE}`;
  }

  private async loadIndex(): Promise<void> {
    if (!this.store) return;

    try {
      const path = this.getIndexPath();
      const exists = await this.app.vault.adapter.exists(path);
      if (!exists) return;

      const raw = await this.app.vault.adapter.read(path);
      const data: unknown = JSON.parse(raw);

      if (!isSerializedVectorIndex(data) || !this.store.deserialize(data)) {
        // Malformed index, or a model mismatch: discard and rebuild.
        this.store.clear();
      }
    } catch {
      // Corrupt index file, will rebuild.
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
      // Non-fatal, index will be rebuilt on next load.
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
