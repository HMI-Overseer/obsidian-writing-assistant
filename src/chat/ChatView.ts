import type { WorkspaceLeaf } from "obsidian";
import { ItemView, Notice } from "obsidian";
import type { CustomCommand } from "../shared/types";
import type LMStudioWritingAssistant from "../main";
import { VIEW_TYPE_CHAT } from "../constants";
import { getActiveNoteText } from "../context/noteContext";
import { ChatGenerationController } from "./ChatGenerationController";
import { ChatConversationController } from "./ChatConversationController";
import { sendMessage } from "./actions/sendMessage";
import { ChatComposer } from "./composer/ChatComposer";
import { ChatSessionStore } from "./conversation/ChatSessionStore";
import { ChatTranscript } from "./messages/ChatTranscript";
import { ChatModelSelector } from "./models/ChatModelSelector";
import type { ChatLayoutRefs } from "./types";
import { ChatHistoryDrawer } from "./view/ChatHistoryDrawer";
import { createChatLayout } from "./view/createChatLayout";

const NO_MODEL_SELECTED_LABEL = "No model selected";
const MODEL_META_SEPARATOR = " - ";

export class ChatView extends ItemView {
  plugin: LMStudioWritingAssistant;

  private layout: ChatLayoutRefs | null = null;
  private sessionStore: ChatSessionStore | null = null;
  private transcript: ChatTranscript | null = null;
  private composer: ChatComposer | null = null;
  private modelSelector: ChatModelSelector | null = null;
  private historyDrawer: ChatHistoryDrawer | null = null;
  private generation!: ChatGenerationController;
  private conversation!: ChatConversationController;

  constructor(leaf: WorkspaceLeaf, plugin: LMStudioWritingAssistant) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return VIEW_TYPE_CHAT;
  }

  getDisplayText(): string {
    return "LM Studio Chat";
  }

  getIcon(): string {
    return "message-square";
  }

  async onOpen(): Promise<void> {
    this.layout = createChatLayout(this.contentEl);
    this.sessionStore = new ChatSessionStore(this.plugin);
    this.transcript = new ChatTranscript(this, this.app, this.layout);

    this.generation = new ChatGenerationController(
      () => this.composer,
      () => this.sessionStore,
      () => this.transcript
    );

    this.conversation = new ChatConversationController({
      getStore: () => this.sessionStore,
      getDrawer: () => this.historyDrawer,
      getGeneration: () => this.generation,
      syncConversationUi: () => this.syncConversationUi(),
      setStatus: (text, muted) => this.setStatus(text, muted),
    });

    this.composer = new ChatComposer(this.app, this.plugin, this.layout, {
      onDraftChange: (draft) => {
        this.sessionStore?.setDraft(draft);
        this.sessionStore?.scheduleDraftSave();
      },
      onSendRequest: () => {
        void this.requestSend();
      },
      onStopRequest: () => {
        this.generation.stopGeneration();
      },
      onRunCommand: (command) => {
        void this.runCommand(command);
      },
    });

    this.modelSelector = new ChatModelSelector(this.plugin, this.layout, {
      getActiveModel: () => this.sessionStore?.getResolvedConversationModel() ?? null,
      getActiveProfileId: () => this.sessionStore?.getActiveConversation()?.modelId ?? "",
      getModels: () => this.plugin.settings.completionModels,
      onSelectModel: async (model) => {
        if (!this.sessionStore) return;
        await this.sessionStore.setActiveConversationModel(model);
        await this.syncConversationUi();
        void this.modelSelector?.refreshAvailability();
      },
    });

    this.historyDrawer = new ChatHistoryDrawer(this.layout.messagesPaneEl, {
      onSelect: (id) => void this.conversation.switchConversation(id),
      onNew: () => void this.conversation.startNewConversation(),
      onDelete: (id) => void this.conversation.deleteConversation(id),
      onClose: () => this.historyDrawer?.close(),
    });

    this.layout.historyBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      this.conversation.toggleHistoryDrawer();
    });

    this.registerDomEvent(document, "click", () => {
      this.modelSelector?.close();
      if (this.historyDrawer?.isOpen()) {
        this.historyDrawer.close();
      }
    });

    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => {
        this.updateHeader();
        this.composer?.updateContextChips();
        this.composer?.renderCommandBar();
      })
    );

    await this.sessionStore.restorePersistedState();
    await this.syncConversationUi();
    this.composer.renderCommandBar();
    this.setStatus("Ready");
    void this.modelSelector.refreshAvailability();
  }

  async onClose(): Promise<void> {
    this.sessionStore?.clearDraftSaveTimer();
    this.generation.stopGeneration();
    await this.sessionStore?.persistActiveConversation();
    this.transcript?.destroy();
    this.modelSelector?.destroy();
  }

  seedPrompt(text: string): void {
    this.composer?.seedPrompt(text);
    this.sessionStore?.setDraft(text);
    this.sessionStore?.scheduleDraftSave();
  }

  private async requestSend(
    promptOverride?: string,
    autoInsertAfterResponse = false
  ): Promise<void> {
    if (
      !this.sessionStore ||
      !this.transcript ||
      !this.composer ||
      !this.modelSelector
    ) {
      return;
    }

    await sendMessage({
      plugin: this.plugin,
      store: this.sessionStore,
      transcript: this.transcript,
      composer: this.composer,
      modelSelector: this.modelSelector,
      getIsGenerating: () => this.generation.getIsGenerating(),
      setIsGenerating: (sending) => this.generation.setIsGenerating(sending),
      setStatus: (text, muted) => this.setStatus(text, muted),
      setActiveAbortController: (controller) =>
        this.generation.setActiveAbortController(controller),
      syncConversationUi: () => this.syncConversationUi(),
      promptOverride,
      autoInsertAfterResponse,
    });
  }

  private async runCommand(command: CustomCommand): Promise<void> {
    const selection = this.app.workspace.activeEditor?.editor?.getSelection() ?? "";
    const noteText =
      (await getActiveNoteText(this.app, this.plugin.settings.maxContextChars)) ?? "";
    const prompt = command.prompt
      .replace(/\{\{selection\}\}/g, selection)
      .replace(/\{\{note\}\}/g, noteText)
      .trim();

    if (!prompt) {
      new Notice("This command produced an empty prompt.");
      return;
    }

    await this.requestSend(prompt, command.autoInsert);
  }

  private async syncConversationUi(): Promise<void> {
    if (!this.sessionStore || !this.transcript || !this.composer) return;

    const snapshot = this.sessionStore.getSnapshot();
    this.composer.setDraft(snapshot.draft);
    await this.transcript.renderMessages(snapshot.messageHistory);
    this.transcript.setEmptyStateVisible(
      snapshot.messageHistory.length === 0 && !this.generation.getIsGenerating()
    );
    this.updateHeader();
    this.composer.updateContextChips();
    this.modelSelector?.syncActiveModel();

    if (this.historyDrawer?.isOpen()) {
      this.historyDrawer.refresh(
        this.sessionStore.getConversations(),
        snapshot.activeConversationId
      );
    }
  }

  private updateHeader(): void {
    if (!this.layout || !this.sessionStore) return;

    const activeModel = this.sessionStore.getResolvedConversationModel();
    this.layout.headerMetaEl.setText(
      activeModel?.modelId
        ? `${activeModel.name}${MODEL_META_SEPARATOR}${activeModel.modelId}`
        : NO_MODEL_SELECTED_LABEL
    );
  }

  private setStatus(text: string, muted = false): void {
    if (!this.layout) return;

    this.layout.statusPillEl.setText(text);
    this.layout.statusPillEl.toggleClass("is-muted", muted);
  }
}
