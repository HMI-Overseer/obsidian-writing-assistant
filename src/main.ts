import type { WorkspaceLeaf } from "obsidian";
import { Notice, Plugin } from "obsidian";
import type {
  ChatHistory,
  CompletionModel,
  CustomCommand,
  EmbeddingModel,
  KnowledgeGraphSettings,
  PluginSettings,
  ProviderOption,
  ProviderProfile,
  ProviderSettingsMap,
  RagSettings,
} from "./shared/types";
import {
  DEFAULT_ACTIVE_PROFILE_IDS,
  DEFAULT_CHAT_HISTORY,
  DEFAULT_KNOWLEDGE_GRAPH_SETTINGS,
  DEFAULT_RAG_SETTINGS,
  DEFAULT_SETTINGS,
  VIEW_TYPE_CHAT,
} from "./constants";
import { ChatView } from "./chat";
import { normalizeChatHistory } from "./chat/conversation/conversationUtils";
import { normalizeCompletionModel, normalizeEmbeddingModel } from "./shared/normalizeModels";
import { WritingAssistantSettingTab } from "./settings/SettingsTab";
import { ServiceContainer } from "./services/ServiceContainer";

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

function normalizeProviderSettingsMap(
  data: Partial<PluginSettings> | null,
): ProviderSettingsMap {
  const saved = data?.providerSettings;
  const defaults = DEFAULT_SETTINGS.providerSettings;
  return {
    lmstudio: {
      baseUrl: saved?.lmstudio?.baseUrl ?? defaults.lmstudio.baseUrl,
      bypassCors: typeof saved?.lmstudio?.bypassCors === "boolean"
        ? saved.lmstudio.bypassCors
        : defaults.lmstudio.bypassCors,
    },
    anthropic: {
      apiKey: typeof saved?.anthropic?.apiKey === "string"
        ? saved.anthropic.apiKey
        : defaults.anthropic.apiKey,
    },
    openai: {
      apiKey: typeof saved?.openai?.apiKey === "string"
        ? saved.openai.apiKey
        : defaults.openai.apiKey,
      baseUrl: typeof saved?.openai?.baseUrl === "string"
        ? saved.openai.baseUrl
        : defaults.openai.baseUrl,
    },
  };
}

const VALID_PROVIDERS = new Set<string>(["lmstudio", "openai", "anthropic"]);

function normalizeProviderProfiles(raw: unknown): ProviderProfile[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (p): p is ProviderProfile =>
      typeof p === "object" &&
      p !== null &&
      typeof p.id === "string" &&
      typeof p.name === "string" &&
      VALID_PROVIDERS.has(p.provider) &&
      !p.isDefault,
  );
}

function normalizeActiveProfileIds(raw: unknown): Record<ProviderOption, string> {
  const defaults = { ...DEFAULT_ACTIVE_PROFILE_IDS };
  if (typeof raw !== "object" || raw === null) return defaults;
  const obj = raw as Record<string, unknown>;
  for (const key of Object.keys(defaults) as ProviderOption[]) {
    if (typeof obj[key] === "string") {
      defaults[key] = obj[key] as string;
    }
  }
  return defaults;
}

export default class WritingAssistantChat extends Plugin {
  settings!: PluginSettings;
  services!: ServiceContainer;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.services = new ServiceContainer(this.app, () => this.settings);
    await this.services.initialize();

    this.registerView(VIEW_TYPE_CHAT, (leaf: WorkspaceLeaf) => new ChatView(leaf, this));

    this.addRibbonIcon("message-square", "Writing assistant chat", () => {
      this.activateChatView();
    });

    this.addCommand({
      id: "open-chat",
      name: "Open chat",
      callback: () => this.activateChatView(),
    });

    this.addCommand({
      id: "send-selection-to-chat",
      name: "Send selection to chat",
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

    this.addSettingTab(new WritingAssistantSettingTab(this.app, this));

    if (this.app.workspace.layoutReady) {
      this.initLeafIfNeeded();
    } else {
      this.app.workspace.onLayoutReady(() => this.initLeafIfNeeded());
    }
  }

  onunload(): void {
    this.services.destroy();
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

    const providerSettings = normalizeProviderSettingsMap(data);

    this.settings = {
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
      providerProfiles: normalizeProviderProfiles(data?.providerProfiles),
      activeProfileIds: normalizeActiveProfileIds(data?.activeProfileIds),
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
      apiKeysDisclaimerAccepted:
        typeof data?.apiKeysDisclaimerAccepted === "boolean"
          ? data.apiKeysDisclaimerAccepted
          : DEFAULT_SETTINGS.apiKeysDisclaimerAccepted,
      agenticMode:
        typeof data?.agenticMode === "boolean"
          ? data.agenticMode
          : DEFAULT_SETTINGS.agenticMode,
      preferToolUse:
        typeof data?.preferToolUse === "boolean"
          ? data.preferToolUse
          : DEFAULT_SETTINGS.preferToolUse,
      maxToolRoundsEdit:
        typeof data?.maxToolRoundsEdit === "number"
          ? data.maxToolRoundsEdit
          : DEFAULT_SETTINGS.maxToolRoundsEdit,
      maxToolRoundsChat:
        typeof data?.maxToolRoundsChat === "number"
          ? data.maxToolRoundsChat
          : DEFAULT_SETTINGS.maxToolRoundsChat,
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
