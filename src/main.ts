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
import { DEFAULT_CHAT_HISTORY, DEFAULT_SETTINGS, DEFAULT_SYSTEM_PROMPT, VIEW_TYPE_CHAT } from "./constants";
import { normalizeLMStudioBaseUrl } from "./api/LMStudioClient";
import { ChatView } from "./chat";
import { normalizeChatState } from "./chat/chatState";
import { generateConversationTitle, normalizeChatHistory } from "./chat/conversationHistory";
import { generateId } from "./utils";
import { LMStudioSettingTab } from "./settings";

const LEGACY_DEFAULT_COMPLETION_ID = "default";
const DEFAULT_COMPLETION_TEMPERATURE = 0.7;
const DEFAULT_COMPLETION_MAX_TOKENS = 2000;

function normalizeCompletionModel(
  model: Partial<CompletionModel> | null | undefined,
  index: number
): CompletionModel {
  return {
    id: model?.id || `model-${index + 1}`,
    name: model?.name || `Model ${index + 1}`,
    modelId: model?.modelId ?? "",
    systemPrompt: model?.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
    temperature:
      typeof model?.temperature === "number" ? model.temperature : DEFAULT_COMPLETION_TEMPERATURE,
    maxTokens:
      typeof model?.maxTokens === "number" ? model.maxTokens : DEFAULT_COMPLETION_MAX_TOKENS,
  };
}

function isUntouchedLegacyDefaultModel(model: CompletionModel): boolean {
  return (
    model.id === LEGACY_DEFAULT_COMPLETION_ID &&
    model.name === "Default" &&
    model.modelId === "" &&
    model.systemPrompt === DEFAULT_SYSTEM_PROMPT &&
    model.temperature === DEFAULT_COMPLETION_TEMPERATURE &&
    model.maxTokens === DEFAULT_COMPLETION_MAX_TOKENS
  );
}

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

    const legacyModelConfigured =
      typeof data?.modelId === "string" ||
      typeof data?.systemPrompt === "string" ||
      typeof data?.temperature === "number" ||
      typeof data?.maxTokens === "number";

    const rawCompletionModels = Array.isArray(data?.completionModels)
      ? data.completionModels
      : legacyModelConfigured
        ? [
            {
              id: LEGACY_DEFAULT_COMPLETION_ID,
              name: "Default",
              modelId: data?.modelId ?? "",
              systemPrompt: data?.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
              temperature: data?.temperature ?? DEFAULT_COMPLETION_TEMPERATURE,
              maxTokens: data?.maxTokens ?? DEFAULT_COMPLETION_MAX_TOKENS,
            },
          ]
        : [];

    const completionModels: CompletionModel[] = rawCompletionModels
      .map((model, index) => normalizeCompletionModel(model, index))
      .flatMap((model) => {
        if (isUntouchedLegacyDefaultModel(model)) {
          return [];
        }

        if (model.id === LEGACY_DEFAULT_COMPLETION_ID) {
          return [{ ...model, id: generateId() }];
        }

        return [model];
      });

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

    let chatHistory: ChatHistory;

    if (data?.chatHistory && typeof data.chatHistory === "object") {
      chatHistory = normalizeChatHistory(data.chatHistory);
    } else if (data?.chatState) {
      const legacy = normalizeChatState(data.chatState);
      const legacyMessages = legacy.messages.filter(
        (m) => m.role === "user" || m.role === "assistant"
      );

      if (legacyMessages.length > 0 || legacy.draft) {
        const firstUserMessage =
          legacyMessages.find((m) => m.role === "user")?.content ?? "";
        const migratedModel = completionModels[0] ?? null;

        const migratedConversation: Conversation = {
          id: generateId(),
          title: firstUserMessage
            ? generateConversationTitle(firstUserMessage)
            : "Previous conversation",
          createdAt: Date.now(),
          updatedAt: Date.now(),
          modelId: migratedModel?.id ?? "",
          modelName: migratedModel?.name ?? "",
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
      lmStudioUrl: normalizeLMStudioBaseUrl(data?.lmStudioUrl ?? DEFAULT_SETTINGS.lmStudioUrl),
      bypassCors:
        typeof data?.bypassCors === "boolean" ? data.bypassCors : DEFAULT_SETTINGS.bypassCors,
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
      chatState: undefined,
    };
  }

  async saveSettings(): Promise<void> {
    const toSave = { ...this.settings };
    delete toSave.chatState;
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
