import type { WorkspaceLeaf } from "obsidian";
import { Notice, Plugin } from "obsidian";
import type {
  ChatHistory,
  CompletionModel,
  CustomCommand,
  EmbeddingModel,
  PluginSettings,
} from "./shared/types";
import { DEFAULT_CHAT_HISTORY, DEFAULT_SETTINGS, DEFAULT_SYSTEM_PROMPT, VIEW_TYPE_CHAT } from "./constants";
import { normalizeLMStudioBaseUrl } from "./api";
import { ChatView } from "./chat";
import { normalizeChatHistory } from "./chat/conversation/conversationUtils";
import { LMStudioSettingTab } from "./settings/SettingsTab";

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
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_CHAT);
  }

  async loadSettings(): Promise<void> {
    const data = (await this.loadData()) as Partial<PluginSettings> | null;

    const completionModels: CompletionModel[] = Array.isArray(data?.completionModels)
      ? data.completionModels.map((model, index) => normalizeCompletionModel(model, index))
      : [];

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

    const chatHistory: ChatHistory =
      data?.chatHistory && typeof data.chatHistory === "object"
        ? normalizeChatHistory(data.chatHistory)
        : { ...DEFAULT_CHAT_HISTORY };

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
      diffContextLines:
        typeof data?.diffContextLines === "number"
          ? data.diffContextLines
          : DEFAULT_SETTINGS.diffContextLines,
      diffMinMatchConfidence:
        typeof data?.diffMinMatchConfidence === "number"
          ? data.diffMinMatchConfidence
          : DEFAULT_SETTINGS.diffMinMatchConfidence,
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
