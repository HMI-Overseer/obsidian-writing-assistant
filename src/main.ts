import type { WorkspaceLeaf } from "obsidian";
import { Notice, Plugin } from "obsidian";
import type {
  ChatHistory,
  CompletionModel,
  CustomCommand,
  EmbeddingModel,
  PluginSettings,
} from "./shared/types";
import { DEFAULT_CHAT_HISTORY, DEFAULT_SETTINGS, VIEW_TYPE_CHAT } from "./constants";
import { normalizeLMStudioBaseUrl } from "./api";
import { ChatView } from "./chat";
import { normalizeChatHistory } from "./chat/conversation/conversationUtils";
import { normalizeCompletionModel, normalizeEmbeddingModel } from "./shared/normalizeModels";
import { LMStudioSettingTab } from "./settings/SettingsTab";

export default class LMStudioWritingAssistant extends Plugin {
  settings!: PluginSettings;

  async onload(): Promise<void> {
    await this.loadSettings();

    this.registerView(VIEW_TYPE_CHAT, (leaf: WorkspaceLeaf) => new ChatView(leaf, this));

    this.addRibbonIcon("message-square", "Writing Assistant Chat", () => {
      this.activateChatView();
    });

    this.addCommand({
      id: "open-lm-studio-chat",
      name: "Open Writing Assistant Chat",
      callback: () => this.activateChatView(),
    });

    this.addCommand({
      id: "send-selection-to-chat",
      name: "Send selection to Writing Assistant Chat",
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
