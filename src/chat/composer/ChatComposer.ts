import { setIcon } from "obsidian";
import type { App } from "obsidian";
import type { CompletionModel } from "../../shared/types";
import type WritingAssistantChat from "../../main";
import { shouldUseToolCall } from "../../tools/registry";
import { getActiveFileName } from "../../context/noteContext";
import type { ExtraContextItem } from "../../shared/chatRequest";
import type { ChatLayoutRefs, ChatMode } from "../types";

const MODE_OPTIONS: { mode: ChatMode; label: string; icon: string }[] = [
  { mode: "plan", icon: "zap", label: "Plan" },
  { mode: "conversation", icon: "message-square", label: "Chat" },
  { mode: "edit", icon: "pen-line", label: "Edit" },
];

const MODE_PLACEHOLDERS: Record<ChatMode, string> = {
  plan: "Describe what you want to plan...",
  conversation: "Send a message to the model...",
  edit: "Describe the changes you want to make...",
};

type ChatComposerCallbacks = {
  onDraftChange: (draft: string) => void;
  onSendRequest: () => void;
  onStopRequest: () => void;
  onModeChange: (mode: ChatMode) => void;
  onContextToggle: () => void;
};

export class ChatComposer {
  /**
   * Whether the active note is currently attached to the context.
   * Initialized from `includeNoteContext` setting; can be toggled per-session
   * by the user (remove chip or add via context picker).
   */
  private activeNoteAttached: boolean;
  private extraContextItems: ExtraContextItem[] = [];
  private isSending = false;
  private currentMode: ChatMode = "conversation";
  private modeButtons = new Map<ChatMode, HTMLButtonElement>();
  constructor(
    private readonly app: App,
    private readonly plugin: WritingAssistantChat,
    private readonly refs: Pick<
      ChatLayoutRefs,
      | "contextChipsEl"
      | "textareaEl"
      | "modeToggleEl"
      | "toolUseIndicatorEl"
      | "toolUsePopoverEl"
      | "knowledgeIndicatorEl"
      | "visionIndicatorEl"
      | "actionBtn"
    >,
    private readonly callbacks: ChatComposerCallbacks
  ) {
    this.activeNoteAttached =
      this.plugin.settings.includeNoteContext && !!this.app.workspace.getActiveFile();

    this.refs.textareaEl.addEventListener("keydown", (event) => {
      if (
        event.key === "Enter" &&
        !event.shiftKey &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey
      ) {
        event.preventDefault();
        this.callbacks.onSendRequest();
      }
    });

    this.refs.textareaEl.addEventListener("input", () => {
      this.autoResizeTextarea();
      this.callbacks.onDraftChange(this.refs.textareaEl.value);
    });

    this.refs.actionBtn.addEventListener("click", () => {
      if (this.isSending) {
        this.callbacks.onStopRequest();
      } else {
        this.callbacks.onSendRequest();
      }
    });

    this.renderModeToggle();
  }

  getMode(): ChatMode {
    return this.currentMode;
  }

  setMode(mode: ChatMode): void {
    this.currentMode = mode;
    this.syncModeToggle();
    this.refs.textareaEl.placeholder = MODE_PLACEHOLDERS[mode];
    this.updateContextChips();
    this.callbacks.onModeChange(mode);
  }

  seedPrompt(text: string): void {
    this.setDraft(text);
    this.refs.textareaEl.focus();
  }

  getDraft(): string {
    return this.refs.textareaEl.value;
  }

  setDraft(text: string): void {
    this.refs.textareaEl.value = text;
    this.autoResizeTextarea();
  }

  clearDraft(): void {
    this.setDraft("");
    this.refs.textareaEl.setCssStyles({ height: "auto" });
  }

  setSendingState(sending: boolean): void {
    this.isSending = sending;
    this.refs.actionBtn.empty();
    setIcon(this.refs.actionBtn, sending ? "square" : "arrow-up");
    this.refs.actionBtn.toggleClass("is-stop", sending);
    this.refs.textareaEl.disabled = sending;
  }

  isActiveNoteAttached(): boolean {
    return this.activeNoteAttached;
  }

  getExtraContextItems(): ExtraContextItem[] {
    return [...this.extraContextItems];
  }

  /**
   * Attach the active note manually (used by ContextPickerPopover).
   * Ignored if the active note is already attached.
   */
  attachActiveNote(): void {
    if (this.activeNoteAttached) return;
    this.activeNoteAttached = true;
    this.updateContextChips();
    this.callbacks.onContextToggle();
  }

  /**
   * Add a vault note to the extra context. Deduplicates by filePath.
   * Used by ContextPickerPopover after the user picks a file.
   */
  addExtraContextItem(item: ExtraContextItem): void {
    if (this.extraContextItems.some((i) => i.filePath === item.filePath)) return;
    this.extraContextItems.push(item);
    this.updateContextChips();
  }

  /**
   * Reset context to the default state for a new conversation:
   * re-apply the auto-attach setting, clear manual vault-note items.
   */
  resetContextForNewConversation(): void {
    this.activeNoteAttached =
      this.plugin.settings.includeNoteContext && !!this.app.workspace.getActiveFile();
    this.extraContextItems = [];
    this.updateContextChips();
  }

  updateContextChips(): void {
    // Preserve the + button (first child) and re-render the rest.
    // Remove all chips except the + button.
    const children = Array.from(this.refs.contextChipsEl.children);
    for (const child of children) {
      if (!child.hasClass("lmsa-chat-composer-add-context-btn")) {
        child.remove();
      }
    }

    const fileName = getActiveFileName(this.app);
    if (fileName && this.activeNoteAttached) {
      this.renderChip(
        this.currentMode === "edit" ? "file-pen-line" : "file-text",
        fileName,
        () => {
          this.activeNoteAttached = false;
          this.updateContextChips();
          this.callbacks.onContextToggle();
        },
      );
    }

    for (const item of this.extraContextItems) {
      this.renderChip("file-text", item.fileName, () => {
        this.extraContextItems = this.extraContextItems.filter(
          (i) => i.filePath !== item.filePath,
        );
        this.updateContextChips();
      });
    }
  }

  /**
   * Updates the tool-use indicator state based on agentic mode and model capability.
   * Orange when agentic mode is on and the model supports tool use.
   */
  refreshToolUseIndicator(activeModel: CompletionModel | null): void {
    const el = this.refs.toolUseIndicatorEl;
    el.removeClass("lmsa-hidden");

    if (!activeModel) {
      el.removeClass("is-active");
      el.setAttribute("aria-label", "No model selected");
      return;
    }

    const trainedForToolUse = activeModel.trainedForToolUse
      ?? this.plugin.services.modelAvailability.getTrainedForToolUse(activeModel.modelId);
    const modelCapable = shouldUseToolCall(activeModel.provider, { trainedForToolUse });
    const active = this.plugin.settings.agenticMode && modelCapable;

    el.toggleClass("is-active", active);
    el.setAttribute("aria-label", active
      ? "Agentic mode on — vault search and edit tools available"
      : "Agentic mode off — no tools used");
  }

  /**
   * Updates the knowledge indicator based on RAG and knowledge graph readiness.
   * Cyan when at least one knowledge source is active, gray otherwise.
   */
  refreshKnowledgeIndicator(ragReady: boolean, graphReady: boolean): void {
    const el = this.refs.knowledgeIndicatorEl;
    const active = ragReady || graphReady;

    el.toggleClass("is-active", active);

    if (ragReady && graphReady) {
      el.setAttribute("aria-label", "Knowledge active \u2014 retrieval + graph");
    } else if (ragReady) {
      el.setAttribute("aria-label", "Knowledge active \u2014 retrieval");
    } else if (graphReady) {
      el.setAttribute("aria-label", "Knowledge active \u2014 graph");
    } else {
      el.setAttribute("aria-label", "No knowledge sources active");
    }
  }

  /**
   * Updates the vision indicator based on the active model's vision capability.
   * Purple when the model supports vision, gray otherwise.
   */
  refreshVisionIndicator(activeModel: CompletionModel | null): void {
    const el = this.refs.visionIndicatorEl;

    if (!activeModel) {
      el.removeClass("is-active");
      el.setAttribute("aria-label", "No model selected");
      return;
    }

    const supportsVision = activeModel.vision
      ?? this.plugin.services.modelAvailability.getVision(activeModel.modelId)
      ?? false;

    el.toggleClass("is-active", supportsVision);
    el.setAttribute("aria-label", supportsVision
      ? "Vision supported — model can process images"
      : "Vision not available");
  }

  destroy(): void {}

  private renderChip(icon: string, label: string, onRemove: () => void): void {
    const chip = this.refs.contextChipsEl.createDiv({ cls: "lmsa-chat-composer-chip" });
    const fileIcon = chip.createEl("span", { cls: "lmsa-chat-composer-chip-icon" });
    setIcon(fileIcon, icon);
    chip.createEl("span", { cls: "lmsa-chat-composer-chip-label", text: label });
    const removeBtn = chip.createEl("button", {
      cls: "lmsa-chat-composer-chip-remove",
      attr: { "aria-label": "Remove context" },
    });
    setIcon(removeBtn.createEl("span"), "x");
    removeBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      onRemove();
    });
  }

  private renderModeToggle(): void {
    this.refs.modeToggleEl.empty();
    this.modeButtons.clear();

    for (const { mode, label, icon } of MODE_OPTIONS) {
      const btn = this.refs.modeToggleEl.createEl("button", {
        cls: "lmsa-chat-composer-mode-toggle-btn",
        attr: { "aria-label": `${label} mode`, "data-mode": mode },
      });
      const iconEl = btn.createEl("span", { cls: "lmsa-chat-composer-mode-toggle-icon" });
      setIcon(iconEl, icon);
      btn.createEl("span", { text: label });
      if (mode === this.currentMode) {
        btn.addClass("is-active");
      }
      btn.addEventListener("click", () => this.setMode(mode));
      this.modeButtons.set(mode, btn);
    }
  }

  private syncModeToggle(): void {
    for (const [mode, btn] of this.modeButtons) {
      btn.toggleClass("is-active", mode === this.currentMode);
    }
  }

  private autoResizeTextarea(): void {
    this.refs.textareaEl.setCssStyles({ height: "auto" });
    this.refs.textareaEl.setCssStyles({ height: `${this.refs.textareaEl.scrollHeight}px` });
  }
}
