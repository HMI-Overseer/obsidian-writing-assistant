import { setIcon } from "obsidian";
import type { App } from "obsidian";
import type { CompletionModel, CustomCommand } from "../../shared/types";
import type LMStudioWritingAssistant from "../../main";
import { shouldUseToolCall } from "../../tools/registry";
import { getActiveFileName } from "../../context/noteContext";
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
  onRunCommand: (command: CustomCommand) => void;
  onModeChange: (mode: ChatMode) => void;
  onContextToggle: () => void;
};

export class ChatComposer {
  private sessionContextEnabled = true;
  private isSending = false;
  private currentMode: ChatMode = "conversation";
  private modeButtons = new Map<ChatMode, HTMLButtonElement>();

  constructor(
    private readonly app: App,
    private readonly plugin: LMStudioWritingAssistant,
    private readonly refs: Pick<
      ChatLayoutRefs,
      "commandBarEl" | "contextChipsEl" | "textareaEl" | "modeToggleEl" | "toolUseIndicatorEl" | "knowledgeIndicatorEl" | "visionIndicatorEl" | "actionBtn"
    >,
    private readonly callbacks: ChatComposerCallbacks
  ) {
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

  isSessionContextEnabled(): boolean {
    return this.sessionContextEnabled;
  }

  updateContextChips(): void {
    this.refs.contextChipsEl.empty();

    const fileName = getActiveFileName(this.app);
    if (
      !fileName ||
      !this.plugin.settings.includeNoteContext ||
      !this.sessionContextEnabled
    ) {
      return;
    }

    const isEditMode = this.currentMode === "edit";
    const chip = this.refs.contextChipsEl.createDiv({ cls: "lmsa-chat-composer-chip" });
    const fileIcon = chip.createEl("span", { cls: "lmsa-chat-composer-chip-icon" });
    setIcon(fileIcon, isEditMode ? "file-pen-line" : "file-text");
    chip.createEl("span", { cls: "lmsa-chat-composer-chip-label", text: fileName });
    const removeBtn = chip.createEl("button", {
      cls: "lmsa-chat-composer-chip-remove",
      attr: { "aria-label": "Remove context" },
    });
    setIcon(removeBtn.createEl("span"), "x");
    removeBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      this.sessionContextEnabled = false;
      this.updateContextChips();
      this.callbacks.onContextToggle();
    });
  }

  /**
   * Updates the tool-use indicator state based on the active model.
   * Orange when the model supports tool use, gray when it doesn't.
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
      ?? this.plugin.modelAvailability.getTrainedForToolUse(activeModel.modelId);
    const supportsTools = shouldUseToolCall(
      activeModel.provider,
      { trainedForToolUse },
      this.plugin.settings.preferToolUse,
    );

    el.toggleClass("is-active", supportsTools);
    el.setAttribute("aria-label", supportsTools
      ? "Tool use supported — edit mode uses structured tool calls"
      : "Tool use not available — edit mode uses text fallback");
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
      ?? this.plugin.modelAvailability.getVision(activeModel.modelId)
      ?? false;

    el.toggleClass("is-active", supportsVision);
    el.setAttribute("aria-label", supportsVision
      ? "Vision supported — model can process images"
      : "Vision not available");
  }

  renderCommandBar(): void {
    this.refs.commandBarEl.empty();

    const hasCustomCommands = this.plugin.settings.commands.length > 0;
    if (!hasCustomCommands) return;

    this.refs.commandBarEl.createEl("div", {
      cls: "lmsa-chat-composer-command-bar-label",
      text: "Quick commands",
    });
    const chips = this.refs.commandBarEl.createDiv({ cls: "lmsa-chat-composer-command-chips" });

    for (const command of this.plugin.settings.commands) {
      const chip = chips.createEl("button", {
        cls: "lmsa-chat-composer-command-chip",
        text: command.name,
      });
      chip.addEventListener("click", () => {
        this.callbacks.onRunCommand(command);
      });
    }
  }

  destroy(): void {
    /* Reserved for future cleanup. */
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
