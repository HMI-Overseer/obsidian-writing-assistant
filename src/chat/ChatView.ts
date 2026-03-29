import type { WorkspaceLeaf } from "obsidian";
import { ItemView, Notice } from "obsidian";
import type { CustomCommand } from "../shared/types";
import type { ChatMode } from "./types";
import type LMStudioWritingAssistant from "../main";
import { VIEW_TYPE_CHAT } from "../constants";
import { getActiveNoteText } from "../context/noteContext";
import { ChatGenerationController } from "./ChatGenerationController";
import { ChatConversationController } from "./ChatConversationController";
import { sendMessage } from "./actions/sendMessage";
import { renderDiffPanel } from "./actions/finalizeEditResponse";
import { branchConversation } from "./actions/branchConversation";
import { regenerateMessage } from "./actions/regenerateMessage";
import { ChatComposer } from "./composer/ChatComposer";
import { ChatSessionStore } from "./conversation/ChatSessionStore";
import type { BubbleActionCallbacks } from "./messages/ChatTranscript";
import { ChatTranscript } from "./messages/ChatTranscript";
import { InlineMessageEditor } from "./messages/InlineMessageEditor";
import { ChatModelSelector } from "./models/ChatModelSelector";
import type { ChatLayoutRefs } from "./types";
import { ChatHistoryDrawer } from "./view/ChatHistoryDrawer";
import { ModelParametersDrawer } from "./view/ModelParametersDrawer";
import { createChatLayout } from "./view/createChatLayout";

const NO_MODEL_SELECTED_LABEL = "No model selected";
const MIN_VIEW_WIDTH_PX = 300;

export class ChatView extends ItemView {
  plugin: LMStudioWritingAssistant;

  private layout: ChatLayoutRefs | null = null;
  private sessionStore: ChatSessionStore | null = null;
  private transcript: ChatTranscript | null = null;
  private composer: ChatComposer | null = null;
  private modelSelector: ChatModelSelector | null = null;
  private historyDrawer: ChatHistoryDrawer | null = null;
  private paramsDrawer: ModelParametersDrawer | null = null;
  private generation!: ChatGenerationController;
  private conversation!: ChatConversationController;
  private lastRenderedConversationId: string | null = null;
  private resizeObserver: ResizeObserver | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: LMStudioWritingAssistant) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return VIEW_TYPE_CHAT;
  }

  getDisplayText(): string {
    return "Writing Assistant";
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
      refreshAvailability: async () => {
        await this.modelSelector?.refreshAvailability();
      },
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
      onModeChange: (mode) => {
        this.layout!.rootEl.dataset.mode = mode;
      },
    });

    this.layout!.rootEl.dataset.mode = "conversation";

    this.modelSelector = new ChatModelSelector(this.plugin, this.layout, {
      getActiveModel: () => this.sessionStore?.getResolvedConversationModel() ?? null,
      getActiveProfileId: () => this.sessionStore?.getActiveConversation()?.modelId ?? "",
      getModels: () => this.plugin.settings.completionModels,
      onSelectModel: async (model) => {
        if (!this.sessionStore) return;
        await this.sessionStore.setActiveConversationModel(model);
        await this.syncConversationUi();
        await this.modelSelector?.refreshAvailability();
      },
    });

    this.historyDrawer = new ChatHistoryDrawer(this.layout.messagesPaneEl, {
      onSelect: (id) => void this.conversation.switchConversation(id),
      onNew: () => void this.conversation.startNewConversation(),
      onDelete: (id) => void this.conversation.deleteConversation(id),
      onClose: () => this.historyDrawer?.close(),
    });

    this.paramsDrawer = new ModelParametersDrawer(this.layout.rootEl, {
      onClose: () => this.paramsDrawer?.close(),
      getSettings: () => ({
        globalSystemPrompt: this.plugin.settings.globalSystemPrompt,
        globalTemperature: this.plugin.settings.globalTemperature,
        globalMaxTokens: this.plugin.settings.globalMaxTokens,
        globalTopP: this.plugin.settings.globalTopP,
        globalTopK: this.plugin.settings.globalTopK,
        globalMinP: this.plugin.settings.globalMinP,
        globalRepeatPenalty: this.plugin.settings.globalRepeatPenalty,
        globalReasoning: this.plugin.settings.globalReasoning,
      }),
      onSystemPromptChange: async (value) => {
        this.plugin.settings.globalSystemPrompt = value;
        await this.plugin.saveSettings();
      },
      onTemperatureChange: async (value) => {
        this.plugin.settings.globalTemperature = value;
        await this.plugin.saveSettings();
      },
      onMaxTokensChange: async (value) => {
        this.plugin.settings.globalMaxTokens = value;
        await this.plugin.saveSettings();
      },
      onTopPChange: async (value) => {
        this.plugin.settings.globalTopP = value;
        await this.plugin.saveSettings();
      },
      onTopKChange: async (value) => {
        this.plugin.settings.globalTopK = value;
        await this.plugin.saveSettings();
      },
      onMinPChange: async (value) => {
        this.plugin.settings.globalMinP = value;
        await this.plugin.saveSettings();
      },
      onRepeatPenaltyChange: async (value) => {
        this.plugin.settings.globalRepeatPenalty = value;
        await this.plugin.saveSettings();
      },
      onReasoningChange: async (value) => {
        this.plugin.settings.globalReasoning = value;
        await this.plugin.saveSettings();
      },
    });

    this.layout.historyBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      if (this.paramsDrawer?.isOpen()) {
        this.paramsDrawer.close();
      }
      this.conversation.toggleHistoryDrawer();
    });

    this.layout.paramsBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      if (this.paramsDrawer?.isOpen()) {
        this.paramsDrawer.close();
      } else {
        if (this.historyDrawer?.isOpen()) {
          this.historyDrawer.close();
        }
        this.paramsDrawer?.open();
      }
    });

    this.registerDomEvent(document, "click", () => {
      this.modelSelector?.close();
      if (this.historyDrawer?.isOpen()) {
        this.historyDrawer.close();
      }
      if (this.paramsDrawer?.isOpen()) {
        this.paramsDrawer.close();
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
    await this.modelSelector.refreshAvailability();

    this.resizeObserver = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      this.handleWidthChange(entry.contentRect.width);
    });
    this.resizeObserver.observe(this.contentEl);
  }

  async onClose(): Promise<void> {
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.sessionStore?.clearDraftSaveTimer();
    this.generation.stopGeneration();
    await this.sessionStore?.persistActiveConversation();
    this.transcript?.destroy();
    this.modelSelector?.destroy();
    this.paramsDrawer?.destroy();
  }

  seedPrompt(text: string): void {
    this.composer?.seedPrompt(text);
    this.sessionStore?.setDraft(text);
    this.sessionStore?.scheduleDraftSave();
  }

  setMode(mode: ChatMode): void {
    this.composer?.setMode(mode);
  }

  private async requestSend(
    promptOverride?: string,
    autoInsertAfterResponse = false
  ): Promise<void> {
    if (!this.sessionStore || !this.transcript || !this.composer || !this.modelSelector) {
      return;
    }

    const useEditMode = this.composer.getMode() === "edit";

    await sendMessage({
      plugin: this.plugin,
      owner: this,
      store: this.sessionStore,
      transcript: this.transcript,
      composer: this.composer,
      modelSelector: this.modelSelector,
      getIsGenerating: () => this.generation.getIsGenerating(),
      setIsGenerating: (sending) => this.generation.setIsGenerating(sending),
      setActiveAbortController: (controller) =>
        this.generation.setActiveAbortController(controller),
      syncConversationUi: () => this.syncConversationUi(),
      promptOverride,
      autoInsertAfterResponse,
      editMode: useEditMode,
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
    const isConversationSwitch = snapshot.activeConversationId !== this.lastRenderedConversationId;
    this.lastRenderedConversationId = snapshot.activeConversationId;

    this.composer.setDraft(snapshot.draft);
    await this.transcript.renderMessages(
      snapshot.messageHistory,
      this.createBubbleActionCallbacks(),
      isConversationSwitch
    );

    // Re-render DiffReviewPanels for historical messages with edit proposals
    for (const message of snapshot.messageHistory) {
      if (message.editProposal) {
        const bubble = this.transcript.getBubbleForMessage(message.id);
        if (bubble) {
          renderDiffPanel(
            this.app,
            this,
            this.sessionStore,
            bubble,
            message.editProposal,
            message.appliedEdit
          );
        }
      }
    }

    this.transcript.setEmptyStateVisible(
      snapshot.messageHistory.length === 0 && !this.generation.getIsGenerating()
    );
    this.updateHeader();
    this.composer.updateContextChips();
    this.composer.renderCommandBar();
    this.modelSelector?.syncActiveModel();

    if (this.historyDrawer?.isOpen()) {
      this.historyDrawer.refresh(
        this.sessionStore.getConversations(),
        snapshot.activeConversationId
      );
    }
  }

  private createBubbleActionCallbacks(): BubbleActionCallbacks {
    return {
      onCopy: (messageId) => this.handleCopyMessage(messageId),
      onEdit: (messageId) => this.handleEditMessage(messageId),
      onDelete: (messageId) => this.handleDeleteMessage(messageId),
      onBranch: (messageId) => void this.handleBranchMessage(messageId),
      onRegenerate: (messageId) => void this.handleRegenerateMessage(messageId),
      onVersionChange: (messageId, newIndex) => void this.handleVersionChange(messageId, newIndex),
    };
  }

  private handleCopyMessage(messageId: string): void {
    const snapshot = this.sessionStore?.getSnapshot();
    const message = snapshot?.messageHistory.find((m) => m.id === messageId);
    if (!message) return;

    void navigator.clipboard.writeText(message.content).then(() => {
      new Notice("Copied to clipboard");
    });
  }

  private handleEditMessage(messageId: string): void {
    if (!this.sessionStore || !this.transcript) return;

    const bubble = this.transcript.getBubbleForMessage(messageId);
    const snapshot = this.sessionStore.getSnapshot();
    const message = snapshot.messageHistory.find((m) => m.id === messageId);
    if (!bubble || !message) return;

    const editor = new InlineMessageEditor(bubble, message.content, {
      onSave: async (newContent) => {
        if (!this.sessionStore || !this.transcript) return;
        this.sessionStore.updateMessageContent(messageId, newContent);
        await this.sessionStore.persistActiveConversation();
        await this.syncConversationUi();
      },
      onCancel: () => {},
    });
    editor.activate();
  }

  private async handleDeleteMessage(messageId: string): Promise<void> {
    if (!this.sessionStore) return;

    this.sessionStore.removeMessage(messageId);
    await this.sessionStore.persistActiveConversation();
    await this.syncConversationUi();
  }

  private async handleBranchMessage(messageId: string): Promise<void> {
    if (!this.sessionStore) return;

    this.generation.stopGeneration();
    await branchConversation({
      store: this.sessionStore,
      messageId,
      syncConversationUi: () => this.syncConversationUi(),
    });
  }

  private async handleRegenerateMessage(messageId: string): Promise<void> {
    if (!this.sessionStore || !this.transcript || !this.composer || !this.modelSelector) {
      return;
    }

    await regenerateMessage({
      plugin: this.plugin,
      owner: this,
      store: this.sessionStore,
      transcript: this.transcript,
      composer: this.composer,
      modelSelector: this.modelSelector,
      messageId,
      getIsGenerating: () => this.generation.getIsGenerating(),
      setIsGenerating: (generating) => this.generation.setIsGenerating(generating),
      setActiveAbortController: (controller) =>
        this.generation.setActiveAbortController(controller),
      syncConversationUi: () => this.syncConversationUi(),
    });
  }

  private async handleVersionChange(messageId: string, newIndex: number): Promise<void> {
    if (!this.sessionStore || !this.transcript) return;

    this.sessionStore.switchMessageVersion(messageId, newIndex);
    await this.sessionStore.persistActiveConversation();

    const snapshot = this.sessionStore.getSnapshot();
    await this.transcript.updateBubbleVersion(
      messageId,
      snapshot.messageHistory,
      this.createBubbleActionCallbacks()
    );
  }

  private updateHeader(): void {
    if (!this.layout || !this.sessionStore) return;

    const activeModel = this.sessionStore.getResolvedConversationModel();
    this.layout.headerMetaEl.setText(
      activeModel?.name || NO_MODEL_SELECTED_LABEL
    );
  }


  private handleWidthChange(width: number): void {
    if (!this.layout) return;

    const isCollapsed = width < MIN_VIEW_WIDTH_PX;
    this.layout.rootEl.toggleClass("is-collapsed", isCollapsed);

    if (isCollapsed && this.historyDrawer?.isOpen()) {
      this.historyDrawer.close();
    }

    if (isCollapsed && this.paramsDrawer?.isOpen()) {
      this.paramsDrawer.close();
    }

    if (isCollapsed && this.modelSelector?.isOpen()) {
      this.modelSelector.close();
    }
  }
}
