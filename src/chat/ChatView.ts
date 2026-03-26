import type { WorkspaceLeaf } from "obsidian";
import { ItemView, Notice, setIcon } from "obsidian";
import type { Conversation, ConversationMessage, Message } from "../shared/types";
import { VIEW_TYPE_CHAT, MAX_CONVERSATIONS } from "../constants";
import { resolveActiveCompletionModel } from "../utils";
import { LMStudioClient } from "../api";
import { getActiveFileName, getActiveNoteContext, getActiveNoteText } from "../context/noteContext";
import { CHAT_DRAFT_SAVE_DELAY_MS } from "./chatState";
import {
  createConversation,
  generateConversationTitle,
  makeMessage,
  pruneHistory,
} from "./conversationHistory";
import { ChatHistoryDrawer } from "./ChatHistoryDrawer";
import type LMStudioWritingAssistant from "../main";

type BubbleRefs = {
  rowEl: HTMLElement;
  bodyEl: HTMLElement;
  contentEl: HTMLElement;
};

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

export class ChatView extends ItemView {
  plugin: LMStudioWritingAssistant;

  // In-memory conversation state
  private activeConversationId: string | null = null;
  private messageHistory: ConversationMessage[] = [];
  private lastAssistantResponse = "";
  private draftSaveTimer: number | null = null;
  private activeAbortController: AbortController | null = null;
  private isGenerating = false;
  private sessionContextEnabled = true;
  private modelDropdownOpen = false;

  // DOM refs
  private headerMetaEl!: HTMLElement;
  private statusPillEl!: HTMLElement;
  private messagesEl!: HTMLElement;
  private emptyStateEl!: HTMLElement;
  private commandBarEl!: HTMLElement;
  private contextChipsEl!: HTMLElement;
  private textareaEl!: HTMLTextAreaElement;
  private sendBtn!: HTMLButtonElement;
  private stopBtn!: HTMLButtonElement;
  private modelSelectorBtn!: HTMLButtonElement;
  private modelDropdownEl!: HTMLElement;
  private historyDrawer!: ChatHistoryDrawer;
  private historyBtn!: HTMLButtonElement;

  constructor(leaf: WorkspaceLeaf, plugin: LMStudioWritingAssistant) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string { return VIEW_TYPE_CHAT; }
  getDisplayText(): string { return "LM Studio Chat"; }
  getIcon(): string { return "message-square"; }

  async onOpen(): Promise<void> {
    const root = this.containerEl.children[1] as HTMLElement;
    root.empty();
    root.addClass("lmsa-root");

    const shell = root.createDiv({ cls: "lmsa-shell" });

    // ------------------------------------------------------------------
    // Header
    // ------------------------------------------------------------------
    const header = shell.createDiv({ cls: "lmsa-header" });
    const titleGroup = header.createDiv({ cls: "lmsa-header-copy" });
    titleGroup.createEl("div", { cls: "lmsa-header-title", text: "LM Studio Chat" });
    this.headerMetaEl = titleGroup.createEl("div", { cls: "lmsa-header-meta" });

    const headerActions = header.createDiv({ cls: "lmsa-header-actions" });
    this.statusPillEl = headerActions.createDiv({ cls: "lmsa-status-pill" });

    this.historyBtn = headerActions.createEl("button", {
      cls: "lmsa-header-btn",
      attr: { "aria-label": "Chat history" },
    });
    setIcon(this.historyBtn, "clock");
    this.historyBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.toggleHistoryDrawer();
    });

    // ------------------------------------------------------------------
    // Messages pane
    // ------------------------------------------------------------------
    const messagesPane = shell.createDiv({ cls: "lmsa-messages-pane" });
    this.emptyStateEl = messagesPane.createDiv({ cls: "lmsa-empty-view" });
    this.emptyStateEl.createEl("div", { cls: "lmsa-empty-title", text: "Start a conversation" });
    this.emptyStateEl.createEl("div", {
      cls: "lmsa-empty-copy",
      text: "Ask a question, paste a passage, or use a quick command to rewrite, expand, or tighten your draft.",
    });
    this.messagesEl = messagesPane.createDiv({ cls: "lmsa-messages" });

    // History drawer lives inside messages-pane (slides over it)
    this.historyDrawer = new ChatHistoryDrawer(messagesPane, {
      onSelect: (id) => { void this.switchToConversation(id); },
      onNew: () => { void this.newConversation(); },
      onDelete: (id) => { void this.deleteConversation(id); },
      onClose: () => this.historyDrawer.close(),
    });

    // ------------------------------------------------------------------
    // Composer
    // ------------------------------------------------------------------
    const composer = shell.createDiv({ cls: "lmsa-composer" });
    this.commandBarEl = composer.createDiv({ cls: "lmsa-command-bar" });

    const composerPanel = composer.createDiv({ cls: "lmsa-composer-panel" });

    // Context chips
    this.contextChipsEl = composerPanel.createDiv({ cls: "lmsa-composer-chips" });

    this.textareaEl = composerPanel.createEl("textarea", {
      cls: "lmsa-textarea",
      attr: { placeholder: "Message LM Studio about your writing...", rows: "3" },
    }) as HTMLTextAreaElement;

    this.textareaEl.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) {
        event.preventDefault();
        void this.handleSend();
      }
    });
    this.textareaEl.addEventListener("input", () => {
      this.autoResizeTextarea();
      this.scheduleDraftSave();
    });

    // Model dropdown
    this.modelDropdownEl = composerPanel.createDiv({ cls: "lmsa-model-dropdown" });
    this.modelDropdownEl.style.display = "none";

    // Composer footer
    const composerFooter = composerPanel.createDiv({ cls: "lmsa-composer-footer" });

    this.modelSelectorBtn = composerFooter.createEl("button", { cls: "lmsa-model-selector-btn" });
    const iconSpan = this.modelSelectorBtn.createEl("span", { cls: "lmsa-model-selector-icon" });
    setIcon(iconSpan, "cpu");
    this.modelSelectorBtn.createEl("span", { cls: "lmsa-model-selector-label" });
    const chevronSpan = this.modelSelectorBtn.createEl("span", { cls: "lmsa-model-selector-chevron" });
    setIcon(chevronSpan, "chevron-up");
    this.modelSelectorBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.toggleModelDropdown();
    });

    composerFooter.createDiv({ cls: "lmsa-compose-hint", text: "Enter to send · Shift+Enter for newline" });

    const buttonRow = composerFooter.createDiv({ cls: "lmsa-btn-row" });

    this.stopBtn = buttonRow.createEl("button", { cls: "lmsa-secondary-btn lmsa-stop-btn", text: "Stop" });
    this.stopBtn.disabled = true;
    this.stopBtn.addEventListener("click", () => this.stopGeneration());

    this.sendBtn = buttonRow.createEl("button", { cls: "lmsa-send-btn", text: "Send" });
    this.sendBtn.addEventListener("click", () => { void this.handleSend(); });

    // Close dropdowns/drawer on outside click
    this.registerDomEvent(document, "click", () => {
      if (this.modelDropdownOpen) this.closeModelDropdown();
      if (this.historyDrawer.isOpen()) this.historyDrawer.close();
    });

    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => {
        this.updateComposerChips();
        this.renderCommandBar();
      })
    );

    this.restorePersistedState();
    this.updateHeader();
    this.updateComposerChips();
    this.renderCommandBar();
    this.updateEmptyState();
    this.setStatus("Ready");
  }

  async onClose(): Promise<void> {
    this.clearDraftSaveTimer();
    this.stopGeneration();
    await this.persistActiveConversation();
  }

  seedPrompt(text: string): void {
    this.textareaEl.value = text;
    this.autoResizeTextarea();
    this.textareaEl.focus();
    this.scheduleDraftSave();
  }

  // ---------------------------------------------------------------------------
  // State restore
  // ---------------------------------------------------------------------------

  private restorePersistedState(): void {
    const history = this.plugin.settings.chatHistory;
    const id = history.activeConversationId;
    const conv = id ? history.conversations.find((c) => c.id === id) : null;

    if (conv) {
      this.loadConversationIntoView(conv);
    } else if (history.conversations.length > 0) {
      this.loadConversationIntoView(history.conversations[0]);
    } else {
      // No history at all — start fresh silently (don't persist until there's content)
      const activeModel = resolveActiveCompletionModel(this.plugin.settings);
      const fresh = createConversation(activeModel.id, activeModel.name);
      history.conversations.unshift(fresh);
      history.activeConversationId = fresh.id;
      this.activeConversationId = fresh.id;
      this.messageHistory = [];
    }
  }

  private loadConversationIntoView(conv: Conversation): void {
    this.activeConversationId = conv.id;
    this.messageHistory = [...conv.messages];
    this.lastAssistantResponse =
      [...conv.messages].reverse().find((m) => m.role === "assistant")?.content ?? "";

    this.messagesEl.empty();
    for (const msg of conv.messages) {
      const bubble = this.createBubble(msg.role);
      this.renderBubbleContent(bubble, msg.content);
    }

    if (this.textareaEl) {
      this.textareaEl.value = conv.draft;
      this.autoResizeTextarea();
    }

    this.plugin.settings.chatHistory.activeConversationId = conv.id;
  }

  // ---------------------------------------------------------------------------
  // Conversation management
  // ---------------------------------------------------------------------------

  private async newConversation(): Promise<void> {
    const history = this.plugin.settings.chatHistory;

    // Warn if at the limit
    if (history.conversations.length >= MAX_CONVERSATIONS) {
      const oldest = [...history.conversations]
        .filter((c) => c.id !== this.activeConversationId)
        .sort((a, b) => a.updatedAt - b.updatedAt)[0];

      if (oldest) {
        const oldestTitle = oldest.title || "Untitled conversation";
        new Notice(
          `History is full (${MAX_CONVERSATIONS}/${MAX_CONVERSATIONS}). Starting a new conversation will remove "${oldestTitle}".`,
          6000
        );
      }
    }

    if (this.isGenerating) this.stopGeneration();

    // Save current before switching
    await this.persistActiveConversation();

    const activeModel = resolveActiveCompletionModel(this.plugin.settings);
    const newConv = createConversation(activeModel.id, activeModel.name);

    history.conversations.unshift(newConv);
    pruneHistory(history);

    this.loadConversationIntoView(newConv);
    this.messagesEl.empty();
    this.messageHistory = [];
    this.lastAssistantResponse = "";

    this.updateEmptyState();
    this.setStatus("Ready", true);
    this.historyDrawer.close();

    await this.plugin.saveSettings();
  }

  private async switchToConversation(id: string): Promise<void> {
    if (id === this.activeConversationId) {
      this.historyDrawer.close();
      return;
    }

    if (this.isGenerating) this.stopGeneration();

    await this.persistActiveConversation();

    const history = this.plugin.settings.chatHistory;
    const target = history.conversations.find((c) => c.id === id);
    if (!target) return;

    this.loadConversationIntoView(target);
    this.updateEmptyState();
    this.updateHeader();
    this.updateComposerChips();
    this.setStatus("Ready", true);
    this.historyDrawer.close();
    this.scrollToBottom();

    await this.plugin.saveSettings();
  }

  private async deleteConversation(id: string): Promise<void> {
    const history = this.plugin.settings.chatHistory;
    const isActive = id === this.activeConversationId;

    history.conversations = history.conversations.filter((c) => c.id !== id);

    if (isActive) {
      if (history.conversations.length > 0) {
        const next = history.conversations[0];
        this.loadConversationIntoView(next);
        this.updateEmptyState();
        this.updateHeader();
        this.updateComposerChips();
        this.setStatus("Ready", true);
        this.scrollToBottom();
      } else {
        // No conversations left — start a fresh one
        const activeModel = resolveActiveCompletionModel(this.plugin.settings);
        const fresh = createConversation(activeModel.id, activeModel.name);
        history.conversations.unshift(fresh);
        history.activeConversationId = fresh.id;
        this.activeConversationId = fresh.id;
        this.messageHistory = [];
        this.messagesEl.empty();
        this.updateEmptyState();
        this.setStatus("Ready", true);
      }
    }

    // Re-render the drawer list
    this.historyDrawer.open(history.conversations, history.activeConversationId);
    await this.plugin.saveSettings();
  }

  // ---------------------------------------------------------------------------
  // History drawer
  // ---------------------------------------------------------------------------

  private toggleHistoryDrawer(): void {
    if (this.historyDrawer.isOpen()) {
      this.historyDrawer.close();
    } else {
      const history = this.plugin.settings.chatHistory;
      this.historyDrawer.open(history.conversations, this.activeConversationId);
    }
  }

  // ---------------------------------------------------------------------------
  // Persistence
  // ---------------------------------------------------------------------------

  private async persistActiveConversation(): Promise<void> {
    const id = this.activeConversationId;
    if (!id) return;

    const history = this.plugin.settings.chatHistory;
    const idx = history.conversations.findIndex((c) => c.id === id);
    if (idx === -1) return; // Deleted externally — don't resurrect

    const conv = history.conversations[idx];
    const draft = this.textareaEl?.value ?? "";
    const isEmpty = this.messageHistory.length === 0 && !draft.trim();

    if (isEmpty && !conv.title) {
      // Empty unsaved conversation — discard rather than clutter history
      history.conversations.splice(idx, 1);
      if (history.activeConversationId === id) {
        history.activeConversationId = history.conversations[0]?.id ?? null;
      }
      await this.plugin.saveSettings();
      return;
    }

    history.conversations[idx] = {
      ...conv,
      messages: [...this.messageHistory],
      draft,
      updatedAt: Date.now(),
    };

    await this.plugin.saveSettings();
  }

  private scheduleDraftSave(): void {
    this.clearDraftSaveTimer();
    this.draftSaveTimer = window.setTimeout(() => {
      this.draftSaveTimer = null;
      void this.persistActiveConversation();
    }, CHAT_DRAFT_SAVE_DELAY_MS);
  }

  private clearDraftSaveTimer(): void {
    if (this.draftSaveTimer !== null) {
      window.clearTimeout(this.draftSaveTimer);
      this.draftSaveTimer = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Header & status
  // ---------------------------------------------------------------------------

  private updateHeader(): void {
    const activeModel = resolveActiveCompletionModel(this.plugin.settings);
    this.headerMetaEl.setText(
      activeModel.modelId
        ? `${activeModel.name} · ${activeModel.modelId}`
        : "No completion model selected yet"
    );
    const label = this.modelSelectorBtn?.querySelector<HTMLElement>(".lmsa-model-selector-label");
    if (label) label.setText(activeModel.name || "No model");
  }

  private setStatus(text: string, muted = false): void {
    this.statusPillEl.setText(text);
    this.statusPillEl.toggleClass("is-muted", muted);
  }

  private updateEmptyState(): void {
    this.emptyStateEl.toggleClass(
      "lmsa-empty-view--hidden",
      this.messageHistory.length > 0 || this.isGenerating
    );
  }

  // ---------------------------------------------------------------------------
  // Context chips
  // ---------------------------------------------------------------------------

  private updateComposerChips(): void {
    this.contextChipsEl.empty();

    const fileName = getActiveFileName(this.app);
    if (!fileName || !this.plugin.settings.includeNoteContext || !this.sessionContextEnabled) return;

    const chip = this.contextChipsEl.createDiv({ cls: "lmsa-chip" });
    const fileIcon = chip.createEl("span", { cls: "lmsa-chip-icon" });
    setIcon(fileIcon, "file-text");
    chip.createEl("span", { cls: "lmsa-chip-label", text: fileName });
    const removeBtn = chip.createEl("button", {
      cls: "lmsa-chip-remove",
      attr: { "aria-label": "Remove context" },
    });
    setIcon(removeBtn.createEl("span"), "x");
    removeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.sessionContextEnabled = false;
      this.updateComposerChips();
    });
  }

  // ---------------------------------------------------------------------------
  // Model selector dropdown
  // ---------------------------------------------------------------------------

  private toggleModelDropdown(): void {
    this.modelDropdownOpen ? this.closeModelDropdown() : this.openModelDropdown();
  }

  private openModelDropdown(): void {
    this.modelDropdownEl.empty();
    this.modelDropdownEl.style.display = "block";
    this.modelDropdownOpen = true;
    this.modelSelectorBtn.addClass("is-active");

    const models = this.plugin.settings.completionModels;
    if (models.length === 0) {
      this.modelDropdownEl.createDiv({
        cls: "lmsa-model-dropdown-empty",
        text: "No models configured. Add one in Settings.",
      });
      return;
    }

    for (const model of models) {
      const item = this.modelDropdownEl.createEl("button", { cls: "lmsa-model-dropdown-item" });
      const checkSpan = item.createEl("span", { cls: "lmsa-model-dropdown-check" });
      if (model.id === this.plugin.settings.activeCompletionModelId) {
        item.addClass("is-active");
        setIcon(checkSpan, "check");
      }
      item.createEl("span", { cls: "lmsa-model-dropdown-name", text: model.name });
      if (model.modelId) {
        item.createEl("span", { cls: "lmsa-model-dropdown-id", text: model.modelId });
      }
      item.addEventListener("click", async (e) => {
        e.stopPropagation();
        this.plugin.settings.activeCompletionModelId = model.id;
        await this.plugin.saveSettings();
        this.updateHeader();
        this.closeModelDropdown();
      });
    }
  }

  private closeModelDropdown(): void {
    this.modelDropdownEl.style.display = "none";
    this.modelDropdownOpen = false;
    this.modelSelectorBtn.removeClass("is-active");
  }

  // ---------------------------------------------------------------------------
  // Command bar
  // ---------------------------------------------------------------------------

  private renderCommandBar(): void {
    this.commandBarEl.empty();
    if (this.plugin.settings.commands.length === 0) return;

    this.commandBarEl.createEl("div", { cls: "lmsa-command-label", text: "Quick commands" });
    const chips = this.commandBarEl.createDiv({ cls: "lmsa-command-chips" });
    for (const command of this.plugin.settings.commands) {
      const chip = chips.createEl("button", { cls: "lmsa-command-chip", text: command.name });
      chip.addEventListener("click", () => { void this.runCommand(command); });
    }
  }

  private async runCommand(command: import("../shared/types").CustomCommand): Promise<void> {
    const selection = this.app.workspace.activeEditor?.editor?.getSelection() ?? "";
    const noteText = (await getActiveNoteText(this.app, this.plugin.settings.maxContextChars)) ?? "";
    const prompt = command.prompt
      .replace(/\{\{selection\}\}/g, selection)
      .replace(/\{\{note\}\}/g, noteText)
      .trim();

    if (!prompt) { new Notice("This command produced an empty prompt."); return; }
    await this.handleSend(prompt, command.autoInsert);
  }

  // ---------------------------------------------------------------------------
  // Textarea helpers
  // ---------------------------------------------------------------------------

  private autoResizeTextarea(): void {
    this.textareaEl.style.height = "auto";
    this.textareaEl.style.height = `${this.textareaEl.scrollHeight}px`;
  }

  private scrollToBottom(): void {
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
  }

  // ---------------------------------------------------------------------------
  // Generation
  // ---------------------------------------------------------------------------

  private stopGeneration(): void {
    if (!this.activeAbortController) return;
    this.activeAbortController.abort();
    this.activeAbortController = null;
  }

  private setSendingState(sending: boolean): void {
    this.isGenerating = sending;
    this.sendBtn.disabled = sending;
    this.sendBtn.setText(sending ? "Sending..." : "Send");
    this.stopBtn.disabled = !sending;
    this.textareaEl.disabled = sending;
    this.updateEmptyState();
  }

  private async handleSend(
    promptOverride?: string,
    autoInsertAfterResponse = false
  ): Promise<void> {
    if (this.isGenerating) return;

    const text = (promptOverride ?? this.textareaEl.value).trim();
    if (!text) return;

    const activeModel = resolveActiveCompletionModel(this.plugin.settings);
    if (!activeModel.modelId) {
      new Notice("No active completion model is configured yet. Open the plugin settings and add one.");
      return;
    }

    this.textareaEl.value = "";
    this.textareaEl.style.height = "auto";
    this.setSendingState(true);
    this.setStatus("Generating");

    // Set conversation title from first message
    if (this.messageHistory.length === 0 && this.activeConversationId) {
      const history = this.plugin.settings.chatHistory;
      const conv = history.conversations.find((c) => c.id === this.activeConversationId);
      if (conv && !conv.title) {
        conv.title = generateConversationTitle(text);
        this.updateHeader();
      }
    }

    const userMsg = makeMessage("user", text);
    const userBubble = this.createBubble("user");
    this.renderBubbleContent(userBubble, text);
    this.messageHistory.push(userMsg);
    this.updateEmptyState();

    let systemContent = activeModel.systemPrompt;
    if (this.plugin.settings.includeNoteContext && this.sessionContextEnabled) {
      const context = await getActiveNoteContext(this.app, this.plugin.settings.maxContextChars);
      if (context) systemContent += context;
    }

    const apiMessages: Message[] = [
      { role: "system", content: systemContent },
      ...this.messageHistory.map((m) => ({ role: m.role, content: m.content })),
    ];

    await this.persistActiveConversation();

    const assistantBubble = this.createBubble("assistant");
    assistantBubble.bodyEl.addClass("is-streaming");
    let fullResponse = "";

    const client = new LMStudioClient(this.plugin.settings.lmStudioUrl, this.plugin.settings.bypassCors);
    this.activeAbortController = new AbortController();

    try {
      for await (const delta of client.stream(
        apiMessages,
        activeModel.modelId,
        activeModel.maxTokens,
        activeModel.temperature,
        this.activeAbortController.signal
      )) {
        fullResponse += delta;
        assistantBubble.contentEl.setText(fullResponse);
        this.scrollToBottom();
      }

      assistantBubble.bodyEl.removeClass("is-streaming");
      if (fullResponse) {
        const assistantMsg = makeMessage("assistant", fullResponse);
        this.messageHistory.push(assistantMsg);
        this.lastAssistantResponse = fullResponse;
        this.renderBubbleContent(assistantBubble, fullResponse);
        if (autoInsertAfterResponse) await this.insertLastResponse();
      } else {
        assistantBubble.contentEl.setText("(no response)");
      }
      this.setStatus("Ready", true);
    } catch (error) {
      assistantBubble.bodyEl.removeClass("is-streaming");
      if (isAbortError(error)) {
        if (fullResponse) {
          const assistantMsg = makeMessage("assistant", fullResponse);
          this.messageHistory.push(assistantMsg);
          this.lastAssistantResponse = fullResponse;
          this.renderBubbleContent(assistantBubble, fullResponse);
        } else {
          assistantBubble.contentEl.setText("Generation stopped.");
          assistantBubble.bodyEl.addClass("is-muted");
        }
        this.setStatus("Stopped", true);
      } else {
        assistantBubble.bodyEl.addClass("is-error");
        assistantBubble.contentEl.setText(
          `Error: ${(error as Error).message}\n\nMake sure LM Studio is running and a model is loaded.`
        );
        this.setStatus("Error", true);
      }
    } finally {
      this.activeAbortController = null;
      await this.persistActiveConversation();
      this.setSendingState(false);
      this.scrollToBottom();
    }
  }

  // ---------------------------------------------------------------------------
  // Bubble rendering
  // ---------------------------------------------------------------------------

  private createBubble(role: "user" | "assistant"): BubbleRefs {
    const rowEl = this.messagesEl.createDiv({ cls: `lmsa-message lmsa-message--${role}` });
    const avatarEl = rowEl.createDiv({ cls: "lmsa-message-avatar" });
    setIcon(avatarEl, role === "user" ? "user-round" : "bot");

    const columnEl = rowEl.createDiv({ cls: "lmsa-message-column" });
    const chromeEl = columnEl.createDiv({ cls: "lmsa-message-chrome" });
    chromeEl.createDiv({ cls: "lmsa-message-role", text: role === "user" ? "You" : "Assistant" });

    const bodyEl = columnEl.createDiv({ cls: "lmsa-message-body" });
    const contentEl = bodyEl.createDiv({ cls: "lmsa-message-content" });

    this.scrollToBottom();
    return { rowEl, bodyEl, contentEl };
  }

  private renderBubbleContent(bubble: BubbleRefs, text: string): void {
    bubble.contentEl.empty();
    bubble.bodyEl.removeClass("is-error", "is-muted", "is-streaming");
    bubble.contentEl.setText(text);
  }

  // ---------------------------------------------------------------------------
  // Insert last response (used by autoInsert commands)
  // ---------------------------------------------------------------------------

  private async insertLastResponse(): Promise<void> {
    if (!this.lastAssistantResponse) return;

    const editor = this.app.workspace.activeEditor?.editor;
    if (editor) {
      const selection = editor.getSelection();
      if (selection) {
        editor.replaceSelection(this.lastAssistantResponse);
      } else {
        const cursor = editor.getCursor("to");
        editor.replaceRange("\n\n" + this.lastAssistantResponse, cursor);
      }
      new Notice("Response inserted into note.");
      return;
    }

    const file = this.app.workspace.getActiveFile();
    if (file) {
      const content = await this.app.vault.read(file);
      await this.app.vault.modify(file, content + "\n\n" + this.lastAssistantResponse);
      new Notice("Response appended to note.");
    } else {
      new Notice("No active note to insert into.");
    }
  }
}
