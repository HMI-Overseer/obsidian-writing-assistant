import type { WorkspaceLeaf } from "obsidian";
import { ItemView } from "obsidian";
import type { ProviderProfile } from "../shared/types";
import type { DocumentContext } from "../shared/chatRequest";
import type { ChatMode } from "./types";
import type WritingAssistantChat from "../main";
import { VIEW_TYPE_CHAT, makeDefaultProfile } from "../constants";
import { getActiveProfile, getProfilesForProvider, generateProfileId } from "../shared/profileUtils";
import { PROVIDER_DESCRIPTORS } from "../providers/descriptors";
import { getActiveNoteText } from "../context/noteContext";
import { ChatBubbleActionHandler } from "./ChatBubbleActionHandler";
import { ChatGenerationOrchestrator } from "./ChatGenerationOrchestrator";
import { ChatConversationController } from "./ChatConversationController";
import type { ContextInputs } from "./ContextCapacityUpdater";
import { ContextCapacityUpdater } from "./ContextCapacityUpdater";
import { renderDiffPanel } from "./finalization/finalizeEditResponse";
import { ChatComposer } from "./composer/ChatComposer";
import { ContextPickerPopover } from "./composer/ContextPickerPopover";
import { KnowledgePopover } from "./composer/KnowledgePopover";
import { ToolUsePopover } from "./composer/ToolUsePopover";
import { ChatSessionStore } from "./conversation/ChatSessionStore";
import { ChatTranscript } from "./messages/ChatTranscript";
import { ChatModelSelector } from "./models/ChatModelSelector";
import { ProfileSettingsPopover } from "./models/ProfileSettingsPopover";
import type { ChatLayoutRefs } from "./types";
import { ChatHistoryDrawer } from "./view/ChatHistoryDrawer";
import { createChatLayout } from "./view/createChatLayout";

const NO_MODEL_SELECTED_LABEL = "No model selected";
const MIN_VIEW_WIDTH_PX = 300;

export class ChatView extends ItemView {
  plugin: WritingAssistantChat;

  private layout: ChatLayoutRefs | null = null;
  private sessionStore: ChatSessionStore | null = null;
  private transcript: ChatTranscript | null = null;
  private composer: ChatComposer | null = null;
  private modelSelector: ChatModelSelector | null = null;
  private profilePopover: ProfileSettingsPopover | null = null;
  private contextPickerPopover: ContextPickerPopover | null = null;
  private knowledgePopover: KnowledgePopover | null = null;
  private toolUsePopover: ToolUsePopover | null = null;
  private historyDrawer: ChatHistoryDrawer | null = null;
  private contextUpdater: ContextCapacityUpdater | null = null;
  private orchestrator!: ChatGenerationOrchestrator;
  private conversation!: ChatConversationController;
  private bubbleActions!: ChatBubbleActionHandler;
  private lastRenderedConversationId: string | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private cachedDocumentContext: DocumentContext | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: WritingAssistantChat) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return VIEW_TYPE_CHAT;
  }

  getDisplayText(): string {
    return "Writing assistant";
  }

  getIcon(): string {
    return "message-square";
  }

  async onOpen(): Promise<void> {
    this.layout = createChatLayout(this.contentEl);
    this.sessionStore = new ChatSessionStore(this.plugin, this.plugin.services.conversationStorage);
    this.transcript = new ChatTranscript(this, this.app, this.layout);

    this.orchestrator = new ChatGenerationOrchestrator({
      plugin: this.plugin,
      owner: this,
      getStore: () => this.sessionStore,
      getTranscript: () => this.transcript,
      getComposer: () => this.composer,
      getModelSelector: () => this.modelSelector,
      getContextUpdater: () => this.contextUpdater,
      getLayout: () => this.layout,
      syncConversationUi: () => this.syncConversationUi(),
      postGenerationSync: () => this.postGenerationSync(),
    });

    this.conversation = new ChatConversationController({
      getStore: () => this.sessionStore,
      getDrawer: () => this.historyDrawer,
      getOrchestrator: () => this.orchestrator,
      syncConversationUi: () => this.syncConversationUi(),
      refreshAvailability: async () => {
        await this.modelSelector?.refreshAvailability();
        this.refreshComposerIndicators();
      },
      onNewConversation: () => {
        this.composer?.resetContextForNewConversation();
      },
    });

    this.contextUpdater = new ContextCapacityUpdater(this.layout.contextCapacityEl);

    this.bubbleActions = new ChatBubbleActionHandler({
      getStore: () => this.sessionStore,
      getTranscript: () => this.transcript,
      getOrchestrator: () => this.orchestrator,
      getContextUpdater: () => this.contextUpdater,
      syncConversationUi: () => this.syncConversationUi(),
      buildContextInputs: () => this.buildContextInputs(),
    });

    this.composer = new ChatComposer(this.app, this.plugin, this.layout, {
      onDraftChange: (draft) => {
        this.sessionStore?.setDraft(draft);
        this.sessionStore?.scheduleDraftSave();
        this.contextUpdater?.scheduleUpdate(this.buildContextInputs(draft));
      },
      onSendRequest: () => {
        void this.orchestrator.send();
      },
      onStopRequest: () => {
        this.orchestrator.stopGeneration();
      },
      onModeChange: (mode) => {
        if (this.layout) {
          this.layout.rootEl.dataset.mode = mode;
        }
        this.composer?.refreshToolUseIndicator(
          this.sessionStore?.getResolvedConversationModel() ?? null
        );
        this.composer?.refreshKnowledgeIndicator(
          this.plugin.services.ragService.isReady(),
          this.plugin.services.graphService.isReady(),
        );
        this.composer?.refreshVisionIndicator(
          this.sessionStore?.getResolvedConversationModel() ?? null
        );
      },
      onContextToggle: () => {
        this.cachedDocumentContext = null;
        this.contextUpdater?.immediateUpdate(this.buildContextInputs());
      },
    });

    if (this.layout) {
      this.layout.rootEl.dataset.mode = "conversation";
    }

    this.modelSelector = new ChatModelSelector(this.plugin, this.layout, {
      getActiveModel: () => this.sessionStore?.getResolvedConversationModel() ?? null,
      getActiveProfileId: () => this.sessionStore?.getActiveConversationMeta()?.modelId ?? "",
      getModels: () => this.plugin.settings.completionModels,
      onSelectModel: async (model) => {
        if (!this.sessionStore) return;
        this.contextUpdater?.resetCalibration();
        await this.sessionStore.setActiveConversationModel(model);
        await this.syncConversationUi();
        await this.modelSelector?.refreshAvailability();
        this.refreshComposerIndicators();
      },
    });

    this.profilePopover = new ProfileSettingsPopover(this.layout, {
      getActiveModel: () => this.sessionStore?.getResolvedConversationModel() ?? null,
      getProfilesForProvider: (provider) =>
        getProfilesForProvider(this.plugin.settings, provider),
      getActiveProfile: (provider) =>
        getActiveProfile(this.plugin.settings, provider),
      getProviderDescriptor: (provider) => PROVIDER_DESCRIPTORS[provider],
      onProfileSelect: async (profileId) => {
        const model = this.sessionStore?.getResolvedConversationModel();
        if (!model) return;
        this.plugin.settings.activeProfileIds[model.provider] = profileId;
        await this.plugin.saveSettings();
      },
      onProfileCreate: async (name, provider) => {
        const profile: ProviderProfile = {
          ...makeDefaultProfile(provider),
          id: generateProfileId(provider),
          name,
          isDefault: false,
        };
        this.plugin.settings.providerProfiles.push(profile);
        this.plugin.settings.activeProfileIds[provider] = profile.id;
        await this.plugin.saveSettings();
        return profile;
      },
      onProfileDelete: async (profileId) => {
        const idx = this.plugin.settings.providerProfiles.findIndex((p) => p.id === profileId);
        if (idx === -1) return;
        const deleted = this.plugin.settings.providerProfiles[idx];
        this.plugin.settings.providerProfiles.splice(idx, 1);
        // Reset to default if the deleted profile was active
        if (this.plugin.settings.activeProfileIds[deleted.provider] === profileId) {
          this.plugin.settings.activeProfileIds[deleted.provider] = `${deleted.provider}-default`;
        }
        await this.plugin.saveSettings();
      },
      onProfileUpdate: async (profileId, patch) => {
        const profile = this.plugin.settings.providerProfiles.find((p) => p.id === profileId);
        if (!profile || profile.isDefault) return;
        Object.assign(profile, patch);
        await this.plugin.saveSettings();
      },
    });

    this.knowledgePopover = new KnowledgePopover(this.layout, {
      getRagSnapshot: () => {
        const rag = this.plugin.settings.rag;
        return {
          enabled: rag.enabled,
          hasModel: !!rag.activeEmbeddingModelId,
          ready: this.plugin.services.ragService.isReady(),
          fileCount: this.plugin.services.ragService.getFileCount(),
          chunkCount: this.plugin.services.ragService.getChunkCount(),
          indexingState: this.plugin.services.ragService.getIndexingState(),
        };
      },
      getGraphSnapshot: () => {
        const kg = this.plugin.settings.knowledgeGraph;
        return {
          enabled: kg.enabled,
          ready: this.plugin.services.graphService.isReady(),
          entityCount: this.plugin.services.graphService.getEntityCount(),
          relationCount: this.plugin.services.graphService.getRelationCount(),
          buildState: this.plugin.services.graphService.getBuildState(),
        };
      },
      getEmbeddingModels: () => this.plugin.settings.embeddingModels,
      getActiveEmbeddingModelId: () => this.plugin.settings.rag.activeEmbeddingModelId,
      getAvailability: (modelId, provider) =>
        this.plugin.services.modelAvailability.getAvailability(modelId, provider).state,
      refreshLocalModels: async () => {
        await this.plugin.services.modelAvailability.refreshLocalModels({ forceRefresh: true });
      },
      onRagToggle: async (enabled) => {
        this.plugin.settings.rag.enabled = enabled;
        await this.plugin.saveSettings();
        await this.plugin.services.ragService.configure(
          this.plugin.settings.rag,
          this.plugin.settings.embeddingModels,
          this.plugin.settings.providerSettings,
        );
        this.composer?.refreshKnowledgeIndicator(
          this.plugin.services.ragService.isReady(),
          this.plugin.services.graphService.isReady(),
        );
      },
      onGraphToggle: async (enabled) => {
        this.plugin.settings.knowledgeGraph.enabled = enabled;
        await this.plugin.saveSettings();
        await this.plugin.services.graphService.configure(
          this.plugin.settings.knowledgeGraph,
          this.plugin.settings.completionModels,
          this.plugin.settings.embeddingModels,
          this.plugin.settings.providerSettings,
        );
        this.composer?.refreshKnowledgeIndicator(
          this.plugin.services.ragService.isReady(),
          this.plugin.services.graphService.isReady(),
        );
      },
      onEmbeddingModelSelect: async (modelId) => {
        this.plugin.settings.rag.activeEmbeddingModelId = modelId;
        await this.plugin.saveSettings();
        await this.plugin.services.ragService.configure(
          this.plugin.settings.rag,
          this.plugin.settings.embeddingModels,
          this.plugin.settings.providerSettings,
        );
      },
      onRagBuild: async () => {
        const rag = this.plugin.settings.rag;
        await this.plugin.services.ragService.startIndexing(
          rag,
          this.plugin.settings.embeddingModels,
          this.plugin.settings.providerSettings,
        );
      },
      onRagRebuild: async () => {
        const rag = this.plugin.settings.rag;
        await this.plugin.services.ragService.rebuild(
          rag,
          this.plugin.settings.embeddingModels,
          this.plugin.settings.providerSettings,
        );
      },
      onRagStop: () => {
        this.plugin.services.ragService.stopIndexing();
      },
      onSubscribe: (onUpdate) => {
        this.plugin.services.ragService.onIndexingStateChange(() => onUpdate());
        this.plugin.services.graphService.onBuildStateChange(() => onUpdate());
      },
      onUnsubscribe: () => {
        this.plugin.services.ragService.onIndexingStateChange(null);
        this.plugin.services.graphService.onBuildStateChange(null);
      },
      onBeforeOpen: () => {
        if (this.toolUsePopover?.isOpen()) this.toolUsePopover.close();
        if (this.profilePopover?.isOpen()) this.profilePopover.close();
      },
    });

    this.toolUsePopover = new ToolUsePopover(this.layout, {
      getAgenticMode: () => this.plugin.settings.agenticMode,
      getPreferEditTools: () => this.plugin.settings.preferToolUse,
      getActiveModel: () => this.sessionStore?.getResolvedConversationModel() ?? null,
      getTrainedForToolUse: (modelId) =>
        this.plugin.services.modelAvailability.getTrainedForToolUse(modelId),
      onAgenticToggle: async (enabled) => {
        this.plugin.settings.agenticMode = enabled;
        await this.plugin.saveSettings();
        this.composer?.refreshToolUseIndicator(
          this.sessionStore?.getResolvedConversationModel() ?? null,
        );
      },
      onEditToolsToggle: async (enabled) => {
        this.plugin.settings.preferToolUse = enabled;
        await this.plugin.saveSettings();
      },
      onBeforeOpen: () => {
        if (this.knowledgePopover?.isOpen()) this.knowledgePopover.close();
        if (this.profilePopover?.isOpen()) this.profilePopover.close();
      },
    });

    this.contextPickerPopover = new ContextPickerPopover(this.app, this.layout, {
      isActiveNoteAttached: () => this.composer?.isActiveNoteAttached() ?? false,
      getActiveFileName: () => this.app.workspace.getActiveFile()?.name ?? null,
      onAddActiveNote: () => {
        this.composer?.attachActiveNote();
      },
      onAddVaultNote: (filePath, fileName) => {
        this.composer?.addExtraContextItem({ filePath, fileName });
      },
      onBeforeOpen: () => {
        if (this.knowledgePopover?.isOpen()) this.knowledgePopover.close();
        if (this.toolUsePopover?.isOpen()) this.toolUsePopover.close();
        if (this.profilePopover?.isOpen()) this.profilePopover.close();
      },
    });

    this.historyDrawer = new ChatHistoryDrawer(this.layout.messagesPaneEl, {
      onSelect: (id) => void this.conversation.switchConversation(id),
      onNew: () => void this.conversation.startNewConversation(),
      onDelete: (id) => void this.conversation.deleteConversation(id),
      onClose: () => this.historyDrawer?.close(),
    });

    this.registerDomEvent(this.layout.historyBtn, "click", (event) => {
      event.stopPropagation();
      this.dismissAllOverlays({ keepHistory: true });
      this.conversation.toggleHistoryDrawer();
    });

    this.registerDomEvent(this.layout.modelSelectorBtn, "click", () => {
      this.dismissAllOverlays({ keepModelSelector: true });
    });

    this.registerDomEvent(document, "click", () => {
      this.dismissAllOverlays();
    });

    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => {
        this.updateHeader();
        this.composer?.updateContextChips();
        void this.refreshDocumentContext().then(() => {
          this.contextUpdater?.scheduleUpdate(this.buildContextInputs());
        });
      })
    );

    this.registerDomEvent(this.layout.generateResponseBtn, "click", () => {
      void this.orchestrator.generateResponse();
    });

    await this.sessionStore.restorePersistedState();
    await this.syncConversationUi();
    await this.modelSelector.refreshAvailability();
    this.refreshComposerIndicators();

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
    this.orchestrator.stopGeneration();
    await this.sessionStore?.persistActiveConversation();
    this.contextUpdater?.destroy();
    this.transcript?.destroy();
    this.modelSelector?.destroy();
    this.profilePopover?.destroy();
    this.contextPickerPopover?.destroy();
    this.knowledgePopover?.destroy();
    this.toolUsePopover?.destroy();
    this.composer?.destroy();
  }

  seedPrompt(text: string): void {
    this.composer?.seedPrompt(text);
    this.sessionStore?.setDraft(text);
    this.sessionStore?.scheduleDraftSave();
  }

  async sendCommand(expandedPrompt: string): Promise<void> {
    await this.orchestrator.send(expandedPrompt);
  }

  setMode(mode: ChatMode): void {
    this.composer?.setMode(mode);
  }

  /**
   * Full conversation sync — re-renders messages from store state and updates
   * all UI chrome. Used for conversation switches, message deletion, branching,
   * and other structural changes to the message list.
   */
  private async syncConversationUi(): Promise<void> {
    if (!this.sessionStore || !this.transcript || !this.composer) return;

    const snapshot = this.sessionStore.getSnapshot();
    const isConversationSwitch = snapshot.activeConversationId !== this.lastRenderedConversationId;
    this.lastRenderedConversationId = snapshot.activeConversationId;

    await this.transcript.renderMessages(
      snapshot.messageHistory,
      this.bubbleActions.createCallbacks(),
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

    await this.syncUiChrome();
  }

  /**
   * Lightweight post-generation sync — adopts bubbles that were created
   * imperatively during the send/generate flow (attaching action toolbars)
   * and updates UI chrome, WITHOUT re-rendering messages from scratch.
   */
  private async postGenerationSync(): Promise<void> {
    if (!this.sessionStore || !this.transcript) return;

    const snapshot = this.sessionStore.getSnapshot();

    this.transcript.adoptPendingBubbles(
      snapshot.messageHistory,
      this.bubbleActions.createCallbacks(),
    );

    await this.syncUiChrome();
  }

  /**
   * Update all non-message UI elements: empty state, header, composer
   * indicators, model selector, history drawer, and context capacity.
   */
  private async syncUiChrome(): Promise<void> {
    if (!this.sessionStore || !this.transcript || !this.composer) return;

    const snapshot = this.sessionStore.getSnapshot();

    this.composer.setDraft(snapshot.draft);
    this.transcript.setEmptyStateVisible(
      snapshot.messageHistory.length === 0 && !this.orchestrator.getIsGenerating()
    );
    this.updateHeader();
    this.composer.updateContextChips();
    this.composer.refreshToolUseIndicator(
      this.sessionStore.getResolvedConversationModel()
    );
    this.toolUsePopover?.refresh();
    this.composer.refreshKnowledgeIndicator(
      this.plugin.services.ragService.isReady(),
      this.plugin.services.graphService.isReady(),
    );
    this.composer.refreshVisionIndicator(
      this.sessionStore.getResolvedConversationModel()
    );
    this.modelSelector?.syncActiveModel();

    this.profilePopover?.syncVisibility();

    if (this.historyDrawer?.isOpen()) {
      this.historyDrawer.refresh(
        this.sessionStore.getConversations(),
        snapshot.activeConversationId
      );
    }

    this.contextUpdater?.refreshUsage(snapshot.messageHistory);
    await this.refreshDocumentContext();
    this.contextUpdater?.immediateUpdate(this.buildContextInputs());
    this.orchestrator.updateGenerateResponseButton(snapshot.messageHistory);
  }

  private refreshComposerIndicators(): void {
    if (!this.composer || !this.sessionStore) return;
    const model = this.sessionStore.getResolvedConversationModel();
    this.composer.refreshToolUseIndicator(model);
    this.composer.refreshVisionIndicator(model);
    this.composer.refreshKnowledgeIndicator(
      this.plugin.services.ragService.isReady(),
      this.plugin.services.graphService.isReady(),
    );
  }

  private updateHeader(): void {
    if (!this.layout || !this.sessionStore) return;

    const activeModel = this.sessionStore.getResolvedConversationModel();
    this.layout.headerMetaEl.setText(
      activeModel?.name || NO_MODEL_SELECTED_LABEL
    );
  }


  private dismissAllOverlays(options?: {
    keepModelSelector?: boolean;
    keepHistory?: boolean;
  }): void {
    if (!options?.keepModelSelector) this.modelSelector?.close();
    if (this.profilePopover?.isOpen()) this.profilePopover.close();
    if (this.contextPickerPopover?.isOpen()) this.contextPickerPopover.close();
    if (this.knowledgePopover?.isOpen()) this.knowledgePopover.close();
    if (this.toolUsePopover?.isOpen()) this.toolUsePopover.close();
    if (!options?.keepHistory && this.historyDrawer?.isOpen()) this.historyDrawer.close();
  }

  private handleWidthChange(width: number): void {
    if (!this.layout) return;

    const isCollapsed = width < MIN_VIEW_WIDTH_PX;
    this.layout.rootEl.toggleClass("is-collapsed", isCollapsed);

    if (isCollapsed && this.historyDrawer?.isOpen()) {
      this.historyDrawer.close();
    }

    if (isCollapsed && this.modelSelector?.isOpen()) {
      this.modelSelector.close();
    }

    if (isCollapsed && this.profilePopover?.isOpen()) {
      this.profilePopover.close();
    }
  }


  private async refreshDocumentContext(): Promise<void> {
    if (!this.composer?.isActiveNoteAttached()) {
      this.cachedDocumentContext = null;
      return;
    }

    const file = this.app.workspace.getActiveFile();
    if (!file) {
      this.cachedDocumentContext = null;
      return;
    }

    const text = await getActiveNoteText(this.app, this.plugin.settings.maxContextChars);
    if (!text) {
      this.cachedDocumentContext = null;
      return;
    }

    this.cachedDocumentContext = {
      filePath: file.path,
      content: text,
      isFull: false,
    };
  }

  private buildContextInputs(draft?: string): ContextInputs {
    const snapshot = this.sessionStore?.getSnapshot();
    const activeModel = this.sessionStore?.getResolvedConversationModel();

    return {
      systemPrompt: getActiveProfile(
        this.plugin.settings,
        activeModel?.provider ?? "lmstudio",
      ).systemPrompt,
      documentContext: this.cachedDocumentContext,
      messages: snapshot?.messageHistory ?? [],
      draft: draft ?? this.composer?.getDraft() ?? "",
      contextWindowSize: activeModel?.contextWindowSize
        ?? this.plugin.services.modelAvailability.getActiveContextLength(activeModel?.modelId ?? ""),
    };
  }
}
