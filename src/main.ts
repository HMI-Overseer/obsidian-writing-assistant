import type { WorkspaceLeaf } from "obsidian";
import { Notice, Plugin } from "obsidian";
import type {
  CompletionModel,
  CustomCommand,
  EmbeddingModel,
  PluginSettings,
} from "./shared/types";
import { DEFAULT_COMPLETION_MODEL, DEFAULT_SETTINGS, VIEW_TYPE_CHAT } from "./constants";
import { ChatView, normalizeChatState } from "./chat";
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

    this.settings = {
      ...DEFAULT_SETTINGS,
      ...data,
      completionModels,
      embeddingModels,
      commands,
      chatState: normalizeChatState(data?.chatState),
      activeCompletionModelId,
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
