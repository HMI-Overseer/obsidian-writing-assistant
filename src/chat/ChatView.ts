import type { WorkspaceLeaf } from "obsidian";
import { ItemView, Notice, setIcon } from "obsidian";
import type { CustomCommand, Message } from "../shared/types";
import { VIEW_TYPE_CHAT } from "../constants";
import { resolveActiveCompletionModel } from "../utils";
import { LMStudioClient } from "../api";
import { getActiveFileName, getActiveNoteContext, getActiveNoteText } from "../context/noteContext";
import type { ChatTranscriptMessage } from "./chatState";
import { CHAT_DRAFT_SAVE_DELAY_MS, createChatState, hydrateTranscript } from "./chatState";
import type LMStudioWritingAssistant from "../main";

type BubbleRefs = {
  rowEl: HTMLElement;
  bodyEl: HTMLElement;
  contentEl: HTMLElement;
  actionsEl: HTMLElement | null;
};

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

export class ChatView extends ItemView {
  plugin: LMStudioWritingAssistant;
  private messageHistory: ChatTranscriptMessage[] = [];
  private lastAssistantResponse = "";
  private draftSaveTimer: number | null = null;
  private activeAbortController: AbortController | null = null;
  private isGenerating = false;

  private headerMetaEl!: HTMLElement;
  private statusPillEl!: HTMLElement;
  private messagesEl!: HTMLElement;
  private emptyStateEl!: HTMLElement;
  private contextBarEl!: HTMLElement;
  private commandBarEl!: HTMLElement;
  private textareaEl!: HTMLTextAreaElement;
  private sendBtn!: HTMLButtonElement;
  private stopBtn!: HTMLButtonElement;
  private insertBtn!: HTMLButtonElement;

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
    const root = this.containerEl.children[1] as HTMLElement;
    root.empty();
    root.addClass("lmsa-root");

    const shell = root.createDiv({ cls: "lmsa-shell" });

    const header = shell.createDiv({ cls: "lmsa-header" });
    const titleGroup = header.createDiv({ cls: "lmsa-header-copy" });
    titleGroup.createEl("div", {
      cls: "lmsa-header-title",
      text: "LM Studio Chat",
    });
    this.headerMetaEl = titleGroup.createEl("div", {
      cls: "lmsa-header-meta",
    });

    const headerActions = header.createDiv({ cls: "lmsa-header-actions" });
    this.statusPillEl = headerActions.createDiv({ cls: "lmsa-status-pill" });
    const clearBtn = headerActions.createEl("button", {
      cls: "lmsa-header-btn",
      attr: { "aria-label": "Clear conversation" },
    });
    setIcon(clearBtn, "trash-2");
    clearBtn.addEventListener("click", () => this.clearConversation());

    this.contextBarEl = shell.createDiv({ cls: "lmsa-context-bar" });

    const messagesPane = shell.createDiv({ cls: "lmsa-messages-pane" });
    this.emptyStateEl = messagesPane.createDiv({ cls: "lmsa-empty-view" });
    this.emptyStateEl.createEl("div", {
      cls: "lmsa-empty-title",
      text: "Start a conversation",
    });
    this.emptyStateEl.createEl("div", {
      cls: "lmsa-empty-copy",
      text: "Ask a question, paste a passage, or use a quick command to rewrite, expand, or tighten your draft.",
    });

    this.messagesEl = messagesPane.createDiv({ cls: "lmsa-messages" });

    const composer = shell.createDiv({ cls: "lmsa-composer" });
    this.commandBarEl = composer.createDiv({ cls: "lmsa-command-bar" });

    const composerPanel = composer.createDiv({ cls: "lmsa-composer-panel" });
    this.textareaEl = composerPanel.createEl("textarea", {
      cls: "lmsa-textarea",
      attr: {
        placeholder: "Message LM Studio about your writing...",
        rows: "3",
      },
    }) as HTMLTextAreaElement;

    this.textareaEl.addEventListener("keydown", (event) => {
      if (
        event.key === "Enter" &&
        !event.shiftKey &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey
      ) {
        event.preventDefault();
        void this.handleSend();
      }
    });

    this.textareaEl.addEventListener("input", () => {
      this.autoResizeTextarea();
      this.scheduleDraftSave();
    });

    const composerFooter = composerPanel.createDiv({ cls: "lmsa-composer-footer" });
    const hintEl = composerFooter.createDiv({ cls: "lmsa-compose-hint" });
    hintEl.setText("Enter to send, Shift+Enter for a new line");

    const buttonRow = composerFooter.createDiv({ cls: "lmsa-btn-row" });

    this.insertBtn = buttonRow.createEl("button", {
      cls: "lmsa-secondary-btn",
      text: "Insert latest",
    });
    this.insertBtn.disabled = true;
    this.insertBtn.addEventListener("click", () => {
      void this.insertLastResponse();
    });

    this.stopBtn = buttonRow.createEl("button", {
      cls: "lmsa-secondary-btn lmsa-stop-btn",
      text: "Stop",
    });
    this.stopBtn.disabled = true;
    this.stopBtn.addEventListener("click", () => this.stopGeneration());

    this.sendBtn = buttonRow.createEl("button", {
      cls: "lmsa-send-btn",
      text: "Send",
    });
    this.sendBtn.addEventListener("click", () => {
      void this.handleSend();
    });

    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => {
        this.updateContextBar();
        this.renderCommandBar();
      })
    );

    this.restorePersistedState();
    this.updateHeader();
    this.updateContextBar();
    this.renderCommandBar();
    this.updateEmptyState();
    this.setStatus("Ready");
  }

  async onClose(): Promise<void> {
    this.clearDraftSaveTimer();
    this.stopGeneration();
    await this.persistChatState();
  }

  seedPrompt(text: string): void {
    this.textareaEl.value = text;
    this.autoResizeTextarea();
    this.textareaEl.focus();
    this.scheduleDraftSave();
  }

  private restorePersistedState(): void {
    const persisted = hydrateTranscript(this.plugin.settings.chatState);
    this.messageHistory = persisted.messages;
    this.lastAssistantResponse = persisted.lastAssistantResponse;
    this.insertBtn.disabled = !this.lastAssistantResponse;

    for (const message of this.messageHistory) {
      const bubble = this.createBubble(message.role);
      this.renderBubbleContent(bubble, message.role, message.content);
    }

    this.textareaEl.value = persisted.draft;
    this.autoResizeTextarea();
  }

  private updateHeader(): void {
    const activeModel = resolveActiveCompletionModel(this.plugin.settings);
    this.headerMetaEl.setText(
      activeModel.modelId
        ? `${activeModel.name} · ${activeModel.modelId}`
        : "No completion model selected yet"
    );
  }

  private updateContextBar(): void {
    const fileName = getActiveFileName(this.app);
    if (fileName && this.plugin.settings.includeNoteContext) {
      this.contextBarEl.setText(`Using current note as context: ${fileName}`);
      this.contextBarEl.removeClass("lmsa-context-bar--hidden");
    } else {
      this.contextBarEl.addClass("lmsa-context-bar--hidden");
    }
  }

  private updateEmptyState(): void {
    this.emptyStateEl.toggleClass(
      "lmsa-empty-view--hidden",
      this.messageHistory.length > 0 || this.isGenerating
    );
  }

  private setStatus(text: string, muted: boolean = false): void {
    this.statusPillEl.setText(text);
    this.statusPillEl.toggleClass("is-muted", muted);
  }

  private renderCommandBar(): void {
    this.commandBarEl.empty();
    if (this.plugin.settings.commands.length === 0) {
      return;
    }

    this.commandBarEl.createEl("div", {
      cls: "lmsa-command-label",
      text: "Quick commands",
    });

    const chips = this.commandBarEl.createDiv({ cls: "lmsa-command-chips" });
    for (const command of this.plugin.settings.commands) {
      const chip = chips.createEl("button", {
        cls: "lmsa-command-chip",
        text: command.name,
      });
      chip.addEventListener("click", () => {
        void this.runCommand(command);
      });
    }
  }

  private autoResizeTextarea(): void {
    this.textareaEl.style.height = "auto";
    this.textareaEl.style.height = `${this.textareaEl.scrollHeight}px`;
  }

  private clearConversation(): void {
    if (this.isGenerating) {
      this.stopGeneration();
    }

    this.messageHistory = [];
    this.lastAssistantResponse = "";
    this.messagesEl.empty();
    this.insertBtn.disabled = true;
    this.updateEmptyState();
    this.setStatus("Ready", true);
    void this.persistChatState();
  }

  private stopGeneration(): void {
    if (!this.activeAbortController) return;
    this.activeAbortController.abort();
    this.activeAbortController = null;
  }

  private scheduleDraftSave(): void {
    this.clearDraftSaveTimer();
    this.draftSaveTimer = window.setTimeout(() => {
      this.draftSaveTimer = null;
      void this.persistChatState();
    }, CHAT_DRAFT_SAVE_DELAY_MS);
  }

  private clearDraftSaveTimer(): void {
    if (this.draftSaveTimer !== null) {
      window.clearTimeout(this.draftSaveTimer);
      this.draftSaveTimer = null;
    }
  }

  private async persistChatState(): Promise<void> {
    this.plugin.settings.chatState = createChatState(
      this.messageHistory,
      this.textareaEl?.value ?? ""
    );
    await this.plugin.saveSettings();
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

    await this.handleSend(prompt, command.autoInsert);
  }

  private async handleSend(
    promptOverride?: string,
    autoInsertAfterResponse: boolean = false
  ): Promise<void> {
    if (this.isGenerating) return;

    const text = (promptOverride ?? this.textareaEl.value).trim();
    if (!text) return;

    const activeModel = resolveActiveCompletionModel(this.plugin.settings);
    if (!activeModel.modelId) {
      new Notice(
        "No active completion model is configured yet. Open the plugin settings and add one."
      );
      return;
    }

    this.textareaEl.value = "";
    this.textareaEl.style.height = "auto";
    this.setSendingState(true);
    this.setStatus("Generating");

    const userBubble = this.createBubble("user");
    this.renderBubbleContent(userBubble, "user", text);
    this.updateEmptyState();

    let systemContent = activeModel.systemPrompt;
    if (this.plugin.settings.includeNoteContext) {
      const context = await getActiveNoteContext(this.app, this.plugin.settings.maxContextChars);
      if (context) systemContent += context;
    }

    const messages: Message[] = [
      { role: "system", content: systemContent },
      ...this.messageHistory,
      { role: "user", content: text },
    ];

    this.messageHistory.push({ role: "user", content: text });
    await this.persistChatState();

    const assistantBubble = this.createBubble("assistant");
    assistantBubble.bodyEl.addClass("is-streaming");
    let fullResponse = "";

    const client = new LMStudioClient(
      this.plugin.settings.lmStudioUrl,
      this.plugin.settings.bypassCors
    );
    this.activeAbortController = new AbortController();

    try {
      for await (const delta of client.stream(
        messages,
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
        this.messageHistory.push({ role: "assistant", content: fullResponse });
        this.lastAssistantResponse = fullResponse;
        this.insertBtn.disabled = false;
        this.renderBubbleContent(assistantBubble, "assistant", fullResponse);

        if (autoInsertAfterResponse) {
          await this.insertLastResponse();
        }
      } else {
        assistantBubble.contentEl.setText("(no response)");
      }
      this.setStatus("Ready", true);
    } catch (error) {
      assistantBubble.bodyEl.removeClass("is-streaming");
      if (isAbortError(error)) {
        if (fullResponse) {
          this.messageHistory.push({ role: "assistant", content: fullResponse });
          this.lastAssistantResponse = fullResponse;
          this.insertBtn.disabled = false;
          this.renderBubbleContent(assistantBubble, "assistant", fullResponse);
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
      await this.persistChatState();
      this.setSendingState(false);
      this.scrollToBottom();
    }
  }

  private createBubble(role: "user" | "assistant"): BubbleRefs {
    const rowEl = this.messagesEl.createDiv({
      cls: `lmsa-message lmsa-message--${role}`,
    });

    const avatarEl = rowEl.createDiv({ cls: "lmsa-message-avatar" });
    setIcon(avatarEl, role === "user" ? "user-round" : "bot");

    const columnEl = rowEl.createDiv({ cls: "lmsa-message-column" });
    const chromeEl = columnEl.createDiv({ cls: "lmsa-message-chrome" });
    chromeEl.createDiv({
      cls: "lmsa-message-role",
      text: role === "user" ? "You" : "Assistant",
    });

    const actionsEl =
      role === "assistant" ? chromeEl.createDiv({ cls: "lmsa-message-actions" }) : null;

    const bodyEl = columnEl.createDiv({ cls: "lmsa-message-body" });
    const contentEl = bodyEl.createDiv({ cls: "lmsa-message-content" });

    this.scrollToBottom();

    return { rowEl, bodyEl, contentEl, actionsEl };
  }

  private renderBubbleContent(bubble: BubbleRefs, role: "user" | "assistant", text: string): void {
    bubble.contentEl.empty();
    bubble.bodyEl.removeClass("is-error", "is-muted", "is-streaming");
    bubble.contentEl.setText(text);

    if (bubble.actionsEl) {
      this.renderAssistantActions(bubble.actionsEl, text);
    }
  }

  private renderAssistantActions(actionsEl: HTMLElement, text: string): void {
    actionsEl.empty();

    const copyBtn = actionsEl.createEl("button", {
      cls: "lmsa-message-action",
      attr: { "aria-label": "Copy response" },
    });
    setIcon(copyBtn, "copy");
    copyBtn.addEventListener("click", async () => {
      await navigator.clipboard.writeText(text);
      new Notice("Response copied.");
    });

    const insertBtn = actionsEl.createEl("button", {
      cls: "lmsa-message-action",
      attr: { "aria-label": "Insert response into note" },
    });
    setIcon(insertBtn, "corner-down-left");
    insertBtn.addEventListener("click", async () => {
      this.lastAssistantResponse = text;
      this.insertBtn.disabled = false;
      await this.insertLastResponse();
    });
  }

  private scrollToBottom(): void {
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
  }

  private setSendingState(sending: boolean): void {
    this.isGenerating = sending;
    this.sendBtn.disabled = sending;
    this.sendBtn.setText(sending ? "Sending..." : "Send");
    this.stopBtn.disabled = !sending;
    this.textareaEl.disabled = sending;
    this.updateEmptyState();
  }

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
