import type { App } from "obsidian";
import type { CompletionModel, EmbeddingModel, PluginSettings, ProviderSettingsMap } from "../shared/types";
import type { RagSettings } from "../rag/types";
import type { KnowledgeGraphSettings } from "../rag/graph/types";
import { ConversationStorage } from "../chat/conversation/ConversationStorage";
import { ModelAvailabilityService } from "../api";
import {
  getSelectableCompletionModels,
  getSelectableEmbeddingModels,
} from "../providers/selectableModels";
import { RagService } from "../rag";
import { GraphService } from "../rag/graph";
import { MemoryService } from "../memory/MemoryService";
import { getProviderDescriptor } from "../providers/registry";
import { ClaudeCodeService } from "./ClaudeCodeService";

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
  readonly memoryService: MemoryService;
  readonly claudeCode: ClaudeCodeService;

  constructor(
    private readonly app: App,
    private readonly getSettings: () => PluginSettings,
    private readonly pluginDir: string,
    private readonly persistSettings?: () => Promise<void>,
  ) {
    this.conversationStorage = new ConversationStorage(app, pluginDir);
    this.modelAvailability = new ModelAvailabilityService(
      () => this.getSettings().providerSettings,
      async (completion, embedding) => {
        const settings = this.getSettings();
        settings.lmStudioModelCache = { completion, embedding, discoveredAt: Date.now() };
        await this.persistSettings?.();
      },
    );
    this.ragService = new RagService(app, pluginDir);
    // Automatic reindex may only embed when the model won't be force-loaded:
    // local models must already be loaded (probed via a non-loading listing
    // call), cloud models only with the user's opt-in.
    this.ragService.setAutoEmbedGate((model) => this.canAutoEmbed(model));
    this.graphService = new GraphService(app, pluginDir);
    this.memoryService = new MemoryService(() => this.getSettings().memories);
    this.claudeCode = new ClaudeCodeService(
      app,
      getSettings,
      () => this.ragService,
      // Effort-level harvest from a fresh session's handshake (section 3.1 layer 2):
      // feed the live lookup and persist last-seen, so after one session the
      // offered levels are the harness's own report, surviving restarts.
      (levels) => {
        this.modelAvailability.reportClaudeCodeEffortLevels(levels);
        const settings = this.getSettings();
        settings.claudeCodeEffortLevels = { ...settings.claudeCodeEffortLevels, ...levels };
        void this.persistSettings?.();
      },
    );
  }

  async initialize(): Promise<void> {
    await this.migrateLegacyDataDir();

    const s = this.getSettings();

    // Seed the effort-level lookup from the persisted last-seen harvest so a
    // restart renders discovered levels before the first session mints.
    this.modelAvailability.reportClaudeCodeEffortLevels(s.claudeCodeEffortLevels);

    await this.ragService.configure(s.rag, getSelectableEmbeddingModels(s), s.providerSettings);
    // Load-time catch-up: absorb edits made while the plugin was off. Gated, so
    // it defers rather than loading a local embedding model that is not running.
    this.ragService.runStartupCatchUp(s.rag);
    await this.graphService.configure(
      s.knowledgeGraph,
      getSelectableCompletionModels(s),
      getSelectableEmbeddingModels(s),
      s.providerSettings,
    );
    this.ragService.setGraphService(this.graphService);
  }

  /**
   * Whether an automatic reindex may embed with this model right now, without
   * loading anything. Cloud models embed only when the user opted in; local
   * models must already be loaded, probed via `refreshLocalModels` (a listing
   * call that never triggers a just-in-time load) and treated as unavailable if
   * discovery fails.
   */
  private async canAutoEmbed(model: EmbeddingModel): Promise<boolean> {
    if (getProviderDescriptor(model.provider).kind === "cloud") {
      return this.getSettings().rag.autoReindexOnCloud;
    }
    try {
      await this.modelAvailability.refreshLocalModels();
    } catch {
      return false;
    }
    return this.modelAvailability.getAvailability(model.modelId, model.provider).state === "loaded";
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
    this.memoryService.destroy();
    this.claudeCode.destroy();
  }

  /**
   * Older builds wrote data to a hardcoded `plugins/writing-assistant-chat`
   * folder. Move it to the actual install folder before services load from disk.
   */
  private async migrateLegacyDataDir(): Promise<void> {
    const legacyDir = `${this.app.vault.configDir}/plugins/writing-assistant-chat`;
    if (legacyDir === this.pluginDir) return;

    const adapter = this.app.vault.adapter;
    try {
      if (!(await adapter.exists(legacyDir))) return;

      for (const file of ["rag-index.json", "rag-knowledge-graph.json"]) {
        const from = `${legacyDir}/${file}`;
        const to = `${this.pluginDir}/${file}`;
        if ((await adapter.exists(from)) && !(await adapter.exists(to))) {
          await adapter.rename(from, to);
        }
      }

      const fromDir = `${legacyDir}/conversations`;
      const toDir = `${this.pluginDir}/conversations`;
      if (await adapter.exists(fromDir)) {
        if (!(await adapter.exists(toDir))) {
          await adapter.rename(fromDir, toDir);
        } else {
          const listing = await adapter.list(fromDir);
          for (const filePath of listing.files) {
            const name = filePath.slice(filePath.lastIndexOf("/") + 1);
            const target = `${toDir}/${name}`;
            if (!(await adapter.exists(target))) {
              await adapter.rename(filePath, target);
            }
          }
        }
      }
    } catch {
      // Non-fatal, data stays in the legacy folder and services start empty.
    }
  }
}
