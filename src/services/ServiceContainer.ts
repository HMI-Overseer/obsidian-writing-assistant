import type { App } from "obsidian";
import type { CompletionModel, EmbeddingModel, PluginSettings, ProviderSettingsMap } from "../shared/types";
import type { RagSettings } from "../rag/types";
import type { KnowledgeGraphSettings } from "../rag/graph/types";
import { ConversationStorage } from "../chat/conversation/ConversationStorage";
import { ModelAvailabilityService } from "../api";
import { RagService } from "../rag";
import { GraphService } from "../rag/graph";

/**
 * Owns construction and lifecycle of all runtime services.
 *
 * The plugin creates this once during `onload()` and passes it to consumers.
 * Settings live on the plugin (they use Plugin.loadData/saveData), so the
 * container receives a settings accessor rather than owning settings itself.
 */
export class ServiceContainer {
  readonly conversationStorage: ConversationStorage;
  readonly modelAvailability: ModelAvailabilityService;
  readonly ragService: RagService;
  readonly graphService: GraphService;

  constructor(
    app: App,
    private readonly getSettings: () => PluginSettings,
  ) {
    this.conversationStorage = new ConversationStorage(app);
    this.modelAvailability = new ModelAvailabilityService(
      () => this.getSettings().providerSettings,
    );
    this.ragService = new RagService(app);
    this.graphService = new GraphService(app);
  }

  async initialize(): Promise<void> {
    const s = this.getSettings();

    // PluginSettings uses shared/types variants; services expect rag-specific
    // variants with extra fields. The runtime data has all fields (populated by
    // normalize functions), so the casts are safe. The shared types just lag.
    await this.ragService.configure(
      s.rag as unknown as RagSettings,
      s.embeddingModels,
      s.providerSettings,
    );
    await this.graphService.configure(
      s.knowledgeGraph as unknown as KnowledgeGraphSettings,
      s.completionModels,
      s.embeddingModels,
      s.providerSettings,
    );
    this.ragService.setGraphService(this.graphService);
  }

  /** Reconfigure RAG after settings change. */
  async reconfigureRag(
    rag: RagSettings,
    embeddingModels: EmbeddingModel[],
    providerSettings: ProviderSettingsMap,
  ): Promise<void> {
    await this.ragService.configure(rag, embeddingModels, providerSettings);
  }

  /** Reconfigure knowledge graph after settings change. */
  async reconfigureGraph(
    kg: KnowledgeGraphSettings,
    completionModels: CompletionModel[],
    embeddingModels: EmbeddingModel[],
    providerSettings: ProviderSettingsMap,
  ): Promise<void> {
    await this.graphService.configure(kg, completionModels, embeddingModels, providerSettings);
  }

  destroy(): void {
    this.ragService.destroy();
    this.graphService.destroy();
  }
}
