import type { WorkspaceLeaf } from "obsidian";
import { Notice, Plugin } from "obsidian";
import type {
  ChatHistory,
  CompletionModel,
  CustomCommand,
  EmbeddingModel,
  KnowledgeGraphSettings,
  PluginSettings,
  ProviderSettingsMap,
  RagSettings,
} from "./shared/types";
import { ConversationStorage } from "./chat/conversation/ConversationStorage";
import {
  DEFAULT_CHAT_HISTORY,
  DEFAULT_KNOWLEDGE_GRAPH_SETTINGS,
  DEFAULT_RAG_SETTINGS,
  DEFAULT_SETTINGS,
  VIEW_TYPE_CHAT,
} from "./constants";
import { normalizeLMStudioBaseUrl, ModelAvailabilityService } from "./api";
import { ChatView } from "./chat";
import { normalizeChatHistory } from "./chat/conversation/conversationUtils";
import { normalizeCompletionModel, normalizeEmbeddingModel } from "./shared/normalizeModels";
import { LMStudioSettingTab } from "./settings/SettingsTab";
import { RagService } from "./rag";
import { GraphService } from "./rag/graph";

function normalizeKnowledgeGraphSettings(raw: unknown): KnowledgeGraphSettings {
  const data = (typeof raw === "object" && raw !== null ? raw : {}) as Partial<KnowledgeGraphSettings>;
  return {
    enabled: typeof data.enabled === "boolean" ? data.enabled : DEFAULT_KNOWLEDGE_GRAPH_SETTINGS.enabled,
    activeCompletionModelId:
      typeof data.activeCompletionModelId === "string"
        ? data.activeCompletionModelId
        : DEFAULT_KNOWLEDGE_GRAPH_SETTINGS.activeCompletionModelId,
    activeEmbeddingModelId:
      typeof data.activeEmbeddingModelId === "string"
        ? data.activeEmbeddingModelId
        : DEFAULT_KNOWLEDGE_GRAPH_SETTINGS.activeEmbeddingModelId,
    excludePatterns: Array.isArray(data.excludePatterns)
      ? data.excludePatterns.filter((p): p is string => typeof p === "string")
      : [...DEFAULT_KNOWLEDGE_GRAPH_SETTINGS.excludePatterns],
  };
}

function normalizeRagSettings(raw: unknown): RagSettings {
  const data = (typeof raw === "object" && raw !== null ? raw : {}) as Partial<RagSettings>;
  return {
    enabled: typeof data.enabled === "boolean" ? data.enabled : DEFAULT_RAG_SETTINGS.enabled,
    activeEmbeddingModelId:
      typeof data.activeEmbeddingModelId === "string"
        ? data.activeEmbeddingModelId
        : DEFAULT_RAG_SETTINGS.activeEmbeddingModelId,
    chunkSize:
      typeof data.chunkSize === "number" ? data.chunkSize : DEFAULT_RAG_SETTINGS.chunkSize,
    chunkOverlap:
      typeof data.chunkOverlap === "number" ? data.chunkOverlap : DEFAULT_RAG_SETTINGS.chunkOverlap,
    topK: typeof data.topK === "number" ? data.topK : DEFAULT_RAG_SETTINGS.topK,
    maxChunksPerFile:
      typeof data.maxChunksPerFile === "number"
        ? data.maxChunksPerFile
        : DEFAULT_RAG_SETTINGS.maxChunksPerFile,
    minScore: typeof data.minScore === "number" ? data.minScore : DEFAULT_RAG_SETTINGS.minScore,
    excludePatterns: Array.isArray(data.excludePatterns)
      ? data.excludePatterns.filter((p): p is string => typeof p === "string")
      : [...DEFAULT_RAG_SETTINGS.excludePatterns],
    maxContextChars:
      typeof data.maxContextChars === "number"
        ? data.maxContextChars
        : DEFAULT_RAG_SETTINGS.maxContextChars,
    metadataEnrichment:
      typeof data.metadataEnrichment === "boolean"
        ? data.metadataEnrichment
        : DEFAULT_RAG_SETTINGS.metadataEnrichment,
  };
}

function migrateProviderSettings(
  data: Partial<PluginSettings> | null,
  lmStudioUrl: string,
  bypassCors: boolean
): ProviderSettingsMap {
  const saved = data?.providerSettings;
  return {
    lmstudio: {
      baseUrl: saved?.lmstudio?.baseUrl ?? lmStudioUrl,
      bypassCors: typeof saved?.lmstudio?.bypassCors === "boolean"
        ? saved.lmstudio.bypassCors
        : bypassCors,
    },
    anthropic: {
      apiKey: typeof saved?.anthropic?.apiKey === "string"
        ? saved.anthropic.apiKey
        : DEFAULT_SETTINGS.providerSettings.anthropic.apiKey,
    },
    openai: {
      apiKey: typeof saved?.openai?.apiKey === "string"
        ? saved.openai.apiKey
        : DEFAULT_SETTINGS.providerSettings.openai.apiKey,
      baseUrl: typeof saved?.openai?.baseUrl === "string"
        ? saved.openai.baseUrl
        : DEFAULT_SETTINGS.providerSettings.openai.baseUrl,
    },
  };
}

export default class LMStudioWritingAssistant extends Plugin {
  settings!: PluginSettings;
  modelAvailability!: ModelAvailabilityService;
  ragService!: RagService;
  graphService!: GraphService;
  conversationStorage!: ConversationStorage;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.modelAvailability = new ModelAvailabilityService(() => this.settings.providerSettings);
    this.conversationStorage = new ConversationStorage(this.app);
    this.ragService = new RagService(this.app);
    await this.ragService.configure(
      this.settings.rag,
      this.settings.embeddingModels,
      this.settings.providerSettings,
    );

    this.graphService = new GraphService(this.app);
    await this.graphService.configure(
      this.settings.knowledgeGraph,
      this.settings.completionModels,
      this.settings.embeddingModels,
      this.settings.providerSettings,
    );
    this.ragService.setGraphService(this.graphService);

    this.registerView(VIEW_TYPE_CHAT, (leaf: WorkspaceLeaf) => new ChatView(leaf, this));

    this.addRibbonIcon("message-square", "Writing assistant chat", () => {
      this.activateChatView();
    });

    this.addCommand({
      id: "open-lm-studio-chat",
      name: "Open writing assistant chat",
      callback: () => this.activateChatView(),
    });

    this.addCommand({
      id: "send-selection-to-chat",
      name: "Send selection to writing assistant chat",
      editorCallback: (editor) => {
        const selection = editor.getSelection();
        if (!selection) {
          new Notice("No text selected.");
          return;
        }

        this.activateChatView().then(() => {
          setTimeout(() => {
            const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_CHAT);
            if (leaves.length > 0) {
              const view = leaves[0].view as ChatView;
              view.seedPrompt(selection);
            }
          }, 100);
        });
      },
    });

    this.addCommand({
      id: "edit-active-note",
      name: "Edit active note with AI",
      editorCallback: async () => {
        await this.activateChatView();
        const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_CHAT);
        if (leaves.length > 0) {
          const view = leaves[0].view as ChatView;
          view.setMode("edit");
        }
      },
    });

    this.addSettingTab(new LMStudioSettingTab(this.app, this));

    if (this.app.workspace.layoutReady) {
      this.initLeafIfNeeded();
    } else {
      this.app.workspace.onLayoutReady(() => this.initLeafIfNeeded());
    }
  }

  onunload(): void {
    this.ragService.destroy();
    this.graphService.destroy();
    // Obsidian handles view cleanup automatically on plugin unload.
    // Detaching leaves here would reset their position on reload.
  }

  async loadSettings(): Promise<void> {
    const data = (await this.loadData()) as Partial<PluginSettings> | null;

    const completionModels: CompletionModel[] = Array.isArray(data?.completionModels)
      ? data.completionModels.map((model, index) => normalizeCompletionModel(model, index))
      : [];

    const embeddingModels: EmbeddingModel[] = Array.isArray(data?.embeddingModels)
      ? data.embeddingModels.map((model, index) => normalizeEmbeddingModel(model, index))
      : [];

    const commands: CustomCommand[] = Array.isArray(data?.commands)
      ? data.commands.map((command, index) => ({
          id: command?.id || `command-${index + 1}`,
          name: command?.name || `Command ${index + 1}`,
          prompt: command?.prompt ?? "",
          autoInsert: Boolean(command?.autoInsert),
        }))
      : [];

    const chatHistory: ChatHistory =
      data?.chatHistory && typeof data.chatHistory === "object"
        ? normalizeChatHistory(data.chatHistory)
        : { ...DEFAULT_CHAT_HISTORY };

    const lmStudioUrl = normalizeLMStudioBaseUrl(data?.lmStudioUrl ?? DEFAULT_SETTINGS.lmStudioUrl);
    const bypassCors =
      typeof data?.bypassCors === "boolean" ? data.bypassCors : DEFAULT_SETTINGS.bypassCors;

    const providerSettings = migrateProviderSettings(data, lmStudioUrl, bypassCors);

    this.settings = {
      lmStudioUrl,
      bypassCors,
      providerSettings,
      includeNoteContext:
        typeof data?.includeNoteContext === "boolean"
          ? data.includeNoteContext
          : DEFAULT_SETTINGS.includeNoteContext,
      maxContextChars:
        typeof data?.maxContextChars === "number"
          ? data.maxContextChars
          : DEFAULT_SETTINGS.maxContextChars,
      completionModels,
      embeddingModels,
      commands,
      chatHistory,
      globalSystemPrompt:
        typeof data?.globalSystemPrompt === "string"
          ? data.globalSystemPrompt
          : DEFAULT_SETTINGS.globalSystemPrompt,
      globalTemperature:
        typeof data?.globalTemperature === "number"
          ? data.globalTemperature
          : DEFAULT_SETTINGS.globalTemperature,
      globalMaxTokens:
        typeof data?.globalMaxTokens === "number" || data?.globalMaxTokens === null
          ? data.globalMaxTokens
          : DEFAULT_SETTINGS.globalMaxTokens,
      globalTopP:
        typeof data?.globalTopP === "number" || data?.globalTopP === null
          ? data.globalTopP
          : DEFAULT_SETTINGS.globalTopP,
      globalTopK:
        typeof data?.globalTopK === "number" || data?.globalTopK === null
          ? data.globalTopK
          : DEFAULT_SETTINGS.globalTopK,
      globalMinP:
        typeof data?.globalMinP === "number" || data?.globalMinP === null
          ? data.globalMinP
          : DEFAULT_SETTINGS.globalMinP,
      globalRepeatPenalty:
        typeof data?.globalRepeatPenalty === "number" || data?.globalRepeatPenalty === null
          ? data.globalRepeatPenalty
          : DEFAULT_SETTINGS.globalRepeatPenalty,
      globalReasoning:
        typeof data?.globalReasoning === "string" || data?.globalReasoning === null
          ? data.globalReasoning
          : DEFAULT_SETTINGS.globalReasoning,
      diffContextLines:
        typeof data?.diffContextLines === "number"
          ? data.diffContextLines
          : DEFAULT_SETTINGS.diffContextLines,
      diffMinMatchConfidence:
        typeof data?.diffMinMatchConfidence === "number"
          ? data.diffMinMatchConfidence
          : DEFAULT_SETTINGS.diffMinMatchConfidence,
      rag: normalizeRagSettings(data?.rag),
      knowledgeGraph: normalizeKnowledgeGraphSettings(data?.knowledgeGraph),
      planSystemPromptPrefix:
        typeof data?.planSystemPromptPrefix === "string"
          ? data.planSystemPromptPrefix
          : DEFAULT_SETTINGS.planSystemPromptPrefix,
      chatSystemPromptPrefix:
        typeof data?.chatSystemPromptPrefix === "string"
          ? data.chatSystemPromptPrefix
          : DEFAULT_SETTINGS.chatSystemPromptPrefix,
      editToolSystemPromptPrefix:
        typeof data?.editToolSystemPromptPrefix === "string"
          ? data.editToolSystemPromptPrefix
          : DEFAULT_SETTINGS.editToolSystemPromptPrefix,
      editFallbackSystemPromptPrefix:
        typeof data?.editFallbackSystemPromptPrefix === "string"
          ? data.editFallbackSystemPromptPrefix
          : DEFAULT_SETTINGS.editFallbackSystemPromptPrefix,
      preferToolUse:
        typeof data?.preferToolUse === "boolean"
          ? data.preferToolUse
          : DEFAULT_SETTINGS.preferToolUse,
    };
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  private initLeafIfNeeded(): void {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_CHAT);
    if (existing.length === 0) return;
    this.app.workspace.revealLeaf(existing[0]);
  }

  async activateChatView(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_CHAT);
    if (existing.length > 0) {
      this.app.workspace.revealLeaf(existing[0]);
      return;
    }

    const leaf = this.app.workspace.getRightLeaf(false);
    if (!leaf) return;
    await leaf.setViewState({ type: VIEW_TYPE_CHAT, active: true });
    this.app.workspace.revealLeaf(leaf);
  }
}
