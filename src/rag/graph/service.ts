import type { App } from "obsidian";
import { Notice } from "obsidian";
import type { KnowledgeGraphSettings, GraphBuildState } from "./types";
import type { CompletionModel, EmbeddingModel, ProviderSettingsMap } from "../../shared/types";
import { KnowledgeGraph } from "./knowledgeGraph";
import { GraphExtractor } from "./extractor";
import { createChatClient } from "../../providers/registry";
import type { ChatClient } from "../../api/chatClient";
import type { EmbeddingClient } from "../embeddingClient";
import { createEmbeddingClient } from "../ragService";
import { buildGraphContext as buildContext } from "./retrieval";
import type { GraphRetrievalContext } from "./retrieval";

const GRAPH_FILE = "rag-knowledge-graph.json";

/**
 * Top-level facade for the knowledge graph.
 *
 * Lifecycle:
 * - `configure()` — loads persisted graph from disk. No LLM calls. Safe for plugin load.
 * - `startBuild()` — user-initiated vault scan + LLM extraction.
 * - `stopBuild()` — cancels in-progress extraction.
 * - `isReady()` / `getGraph()` — query-time access.
 */
export class GraphService {
  private readonly app: App;
  private graph: KnowledgeGraph | null = null;
  private extractor: GraphExtractor | null = null;
  private chatClient: ChatClient | null = null;
  private embeddingClient: EmbeddingClient | null = null;
  private buildState: GraphBuildState = { status: "idle" };
  private onStateChangeCallback: ((state: GraphBuildState) => void) | null = null;

  private configuredModelId: string | null = null;
  private configuredEmbeddingModelId: string | null = null;

  constructor(app: App) {
    this.app = app;
  }

  /** Whether the graph has been built and is queryable. */
  isReady(): boolean {
    return this.graph !== null && this.graph.getEntityCount() > 0;
  }

  /** Whether the graph has been configured (even if empty). */
  isConfigured(): boolean {
    return this.graph !== null;
  }

  getBuildState(): GraphBuildState {
    return this.buildState;
  }

  getEntityCount(): number {
    return this.graph?.getEntityCount() ?? 0;
  }

  getRelationCount(): number {
    return this.graph?.getRelationCount() ?? 0;
  }

  getFileCount(): number {
    return this.graph?.getFileCount() ?? 0;
  }

  getBuiltAt(): number {
    return this.graph?.getBuiltAt() ?? 0;
  }

  /** Get the in-memory graph for query-time use. Returns null if not built. */
  getGraph(): KnowledgeGraph | null {
    return this.graph;
  }

  /**
   * Build graph context for a query. Returns null if graph not ready.
   *
   * If an embedding model is configured and the graph has entity embeddings,
   * embeds the query and uses cosine similarity to find matching entities.
   * Falls back to substring matching otherwise.
   */
  async buildGraphContext(query: string): Promise<GraphRetrievalContext | null> {
    if (!this.isReady() || !this.graph) return null;

    if (this.embeddingClient && this.configuredEmbeddingModelId && this.graph.hasEmbeddings()) {
      try {
        const result = await this.embeddingClient.embed([query], this.configuredEmbeddingModelId);
        if (result.vectors.length > 0) {
          return buildContext(result.vectors[0], this.graph, 2);
        }
      } catch {
        // Fall through to substring matching.
      }
    }

    return buildContext(query, this.graph, 2);
  }

  /** Register a callback for build state changes. Pass null to unregister. */
  onBuildStateChange(callback: ((state: GraphBuildState) => void) | null): void {
    this.onStateChangeCallback = callback;
  }

  /**
   * Configure the graph pipeline without scanning the vault.
   *
   * Loads the persisted graph from disk. Makes NO LLM calls.
   * Safe for plugin load.
   */
  async configure(
    settings: KnowledgeGraphSettings,
    completionModels: CompletionModel[],
    embeddingModels: EmbeddingModel[],
    providerSettings: ProviderSettingsMap,
  ): Promise<void> {
    this.shutdown();

    if (!settings.enabled || !settings.activeCompletionModelId) {
      return;
    }

    const model = completionModels.find((m) => m.id === settings.activeCompletionModelId);
    if (!model) return;

    this.chatClient = createChatClient(model.provider, providerSettings);
    this.configuredModelId = model.modelId;

    if (settings.activeEmbeddingModelId) {
      const embModel = embeddingModels.find((m) => m.id === settings.activeEmbeddingModelId);
      if (embModel) {
        this.embeddingClient = createEmbeddingClient(embModel, providerSettings);
        this.configuredEmbeddingModelId = embModel.modelId;
      }
    }

    this.graph = new KnowledgeGraph();
    await this.loadGraph();
  }

  /**
   * Start extracting entities from the vault. User-initiated only.
   *
   * This is the only method that makes LLM calls.
   */
  async startBuild(
    settings: KnowledgeGraphSettings,
    completionModels: CompletionModel[],
    embeddingModels: EmbeddingModel[],
    providerSettings: ProviderSettingsMap,
  ): Promise<void> {
    if (!this.graph || !this.chatClient) {
      await this.configure(settings, completionModels, embeddingModels, providerSettings);
    }

    if (!this.graph || !this.chatClient || !this.configuredModelId) {
      this.setBuildState({ status: "error", message: "Select a completion model first." });
      return;
    }

    // Tear down any existing extractor.
    this.extractor?.destroy();

    this.extractor = new GraphExtractor({
      app: this.app,
      graph: this.graph,
      chatClient: this.chatClient,
      modelId: this.configuredModelId,
      excludePatterns: settings.excludePatterns,
      onStateChange: (state) => this.setBuildState(state),
      onSave: () => this.saveGraph(),
      embeddingClient: this.embeddingClient ?? undefined,
      embeddingModelId: this.configuredEmbeddingModelId ?? undefined,
    });

    await this.extractor.start();
  }

  /** Cancel in-progress extraction. */
  stopBuild(): void {
    this.extractor?.destroy();
    this.extractor = null;
    this.setBuildState({ status: "idle" });
  }

  /** Force a full rebuild: clear graph, then re-extract. */
  async rebuild(
    settings: KnowledgeGraphSettings,
    completionModels: CompletionModel[],
    embeddingModels: EmbeddingModel[],
    providerSettings: ProviderSettingsMap,
  ): Promise<void> {
    this.extractor?.destroy();
    this.extractor = null;
    this.graph?.clear();
    await this.deleteGraph();
    await this.startBuild(settings, completionModels, embeddingModels, providerSettings);
  }

  /** Shut down the extractor and release resources. */
  shutdown(): void {
    this.extractor?.destroy();
    this.extractor = null;
    this.chatClient = null;
    this.embeddingClient = null;
    this.configuredModelId = null;
    this.configuredEmbeddingModelId = null;
    this.graph = null;
    this.buildState = { status: "idle" };
  }

  /** Clean shutdown — call from plugin `onunload()`. */
  destroy(): void {
    this.shutdown();
    this.onStateChangeCallback = null;
  }

  private setBuildState(state: GraphBuildState): void {
    this.buildState = state;
    this.onStateChangeCallback?.(state);
  }

  private getGraphPath(): string {
    const pluginDir = `${this.app.vault.configDir}/plugins/obsidian-writing-assistant`;
    return `${pluginDir}/${GRAPH_FILE}`;
  }

  private async loadGraph(): Promise<void> {
    if (!this.graph || !this.configuredModelId) return;

    try {
      const path = this.getGraphPath();
      const exists = await this.app.vault.adapter.exists(path);
      if (!exists) return;

      const raw = await this.app.vault.adapter.read(path);
      const data = JSON.parse(raw);

      if (!this.graph.deserialize(data, this.configuredModelId, this.configuredEmbeddingModelId ?? undefined)) {
        // Model mismatch — graph was built with a different model.
        this.graph.clear();
      }
    } catch {
      // Corrupt graph file — will rebuild.
      this.graph.clear();
    }
  }

  private async saveGraph(): Promise<void> {
    if (!this.graph || !this.configuredModelId) return;

    try {
      const data = this.graph.serialize(
        this.configuredModelId,
        this.configuredEmbeddingModelId ?? undefined,
      );
      const path = this.getGraphPath();
      await this.app.vault.adapter.write(path, JSON.stringify(data));
    } catch {
      new Notice("Failed to save knowledge graph.");
    }
  }

  private async deleteGraph(): Promise<void> {
    try {
      const path = this.getGraphPath();
      const exists = await this.app.vault.adapter.exists(path);
      if (exists) {
        await this.app.vault.adapter.remove(path);
      }
    } catch {
      // Non-fatal.
    }
  }
}
