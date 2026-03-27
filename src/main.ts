import type { WorkspaceLeaf } from "obsidian";
import { Notice, Plugin } from "obsidian";
import type {
  ChatHistory,
  CompletionModel,
  Conversation,
  CustomCommand,
  EmbeddingModel,
  PluginSettings,
} from "./shared/types";
import { DEFAULT_CHAT_HISTORY, DEFAULT_COMPLETION_MODEL, DEFAULT_SETTINGS, VIEW_TYPE_CHAT } from "./constants";
import { normalizeLMStudioBaseUrl } from "./api/LMStudioClient";
import { ChatView } from "./chat";
import { normalizeChatState } from "./chat/chatState";
import {
  createConversation,
  generateConversationTitle,
  normalizeChatHistory,
} from "./chat/conversationHistory";
import { generateId } from "./utils";
import { LMStudioSettingTab } from "./settings";

export default class LMStudioWritingAssistant extends Plugin {
  settings!: PluginSettings;

  async onload(): Promise<void> {
    await this.loadSettings();

    this.registerView(VIEW_TYPE_CHAT, (leaf: WorkspaceLeaf) => new ChatView(leaf, this));

    this.addRibbonIcon("message-square", "LM Studio Chat", () => {
      this.activateChatView();
    });

    this.addCommand({
      id: "open-lm-studio-chat",
      name: "Open LM Studio Chat",
      callback: () => this.activateChatView(),
    });

    this.addCommand({
      id: "send-selection-to-chat",
      name: "Send selection to LM Studio Chat",
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

    this.addSettingTab(new LMStudioSettingTab(this.app, this));

    if (this.app.workspace.layoutReady) {
      this.initLeafIfNeeded();
    } else {
      this.app.workspace.onLayoutReady(() => this.initLeafIfNeeded());
    }
  }

  onunload(): void {
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_CHAT);
  }

  async loadSettings(): Promise<void> {
    const data = (await this.loadData()) as Partial<
      PluginSettings & {
        modelId?: string;
        systemPrompt?: string;
        temperature?: number;
        maxTokens?: number;
      }
    > | null;

    // -----------------------------------------------------------------------
    // Normalise completion models (unchanged from before)
    // -----------------------------------------------------------------------
    const legacyModel: CompletionModel = {
      ...DEFAULT_COMPLETION_MODEL,
      modelId: data?.modelId ?? DEFAULT_COMPLETION_MODEL.modelId,
      systemPrompt: data?.systemPrompt ?? DEFAULT_COMPLETION_MODEL.systemPrompt,
      temperature: data?.temperature ?? DEFAULT_COMPLETION_MODEL.temperature,
      maxTokens: data?.maxTokens ?? DEFAULT_COMPLETION_MODEL.maxTokens,
    };

    const completionModels: CompletionModel[] = Array.isArray(data?.completionModels)
      ? data.completionModels.map((model, index) => ({
          ...DEFAULT_COMPLETION_MODEL,
          ...model,
          id: model?.id || `model-${index + 1}`,
          name: model?.name || `Model ${index + 1}`,
        }))
      : [{ ...legacyModel }];

    const embeddingModels: EmbeddingModel[] = Array.isArray(data?.embeddingModels)
      ? data.embeddingModels.map((model, index) => ({
          id: model?.id || `embedding-${index + 1}`,
          name: model?.name || `Embedding ${index + 1}`,
          modelId: model?.modelId ?? "",
        }))
      : [];

    const commands: CustomCommand[] = Array.isArray(data?.commands)
      ? data.commands.map((command, index) => ({
          id: command?.id || `command-${index + 1}`,
          name: command?.name || `Command ${index + 1}`,
          prompt: command?.prompt ?? "",
          autoInsert: Boolean(command?.autoInsert),
        }))
      : [];

    const activeCompletionModelId =
      data?.activeCompletionModelId &&
      completionModels.some((model) => model.id === data.activeCompletionModelId)
        ? data.activeCompletionModelId
        : completionModels[0].id;

    // -----------------------------------------------------------------------
    // Chat history — with one-time migration from legacy chatState
    // -----------------------------------------------------------------------
    let chatHistory: ChatHistory;

    if (data?.chatHistory && typeof data.chatHistory === "object") {
      // Already on new schema — normalise and use.
      chatHistory = normalizeChatHistory(data.chatHistory);
    } else if (data?.chatState) {
      // Legacy single-conversation schema — promote to history.
      const legacy = normalizeChatState(data.chatState);
      const legacyMessages = legacy.messages.filter(
        (m) => m.role === "user" || m.role === "assistant"
      );

      if (legacyMessages.length > 0 || legacy.draft) {
        const firstUserMessage =
          legacyMessages.find((m) => m.role === "user")?.content ?? "";
        const activeModel =
          completionModels.find((m) => m.id === activeCompletionModelId) ??
          completionModels[0];

        const migratedConversation: Conversation = {
          id: generateId(),
          title: firstUserMessage
            ? generateConversationTitle(firstUserMessage)
            : "Previous conversation",
          createdAt: Date.now(),
          updatedAt: Date.now(),
          modelId: activeModel.id,
          modelName: activeModel.name,
          messages: legacyMessages.map((m) => ({
            id: generateId(),
            role: m.role as "user" | "assistant",
            content: m.content,
          })),
          draft: legacy.draft,
        };

        chatHistory = {
          conversations: [migratedConversation],
          activeConversationId: migratedConversation.id,
        };
      } else {
        chatHistory = { ...DEFAULT_CHAT_HISTORY };
      }
    } else {
      chatHistory = { ...DEFAULT_CHAT_HISTORY };
    }

    this.settings = {
      ...DEFAULT_SETTINGS,
      ...data,
      lmStudioUrl: normalizeLMStudioBaseUrl(data?.lmStudioUrl ?? DEFAULT_SETTINGS.lmStudioUrl),
      completionModels,
      embeddingModels,
      commands,
      activeCompletionModelId,
      chatHistory,
      // Intentionally omit chatState — it will vanish from data.json on next save.
      chatState: undefined,
    };
  }

  async saveSettings(): Promise<void> {
    // Strip the deprecated chatState field before writing so it disappears from
    // data.json after the first save following migration.
    const { chatState: _dropped, ...toSave } = this.settings;
    await this.saveData(toSave);
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
