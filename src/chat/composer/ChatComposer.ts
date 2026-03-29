import { setIcon } from "obsidian";
import type { App } from "obsidian";
import type { CustomCommand } from "../../shared/types";
import type LMStudioWritingAssistant from "../../main";
import { getActiveFileName } from "../../context/noteContext";
import type { ChatLayoutRefs, ChatMode } from "../types";

const MODE_OPTIONS: { mode: ChatMode; label: string }[] = [
  { mode: "plan", label: "Plan" },
  { mode: "conversation", label: "Chat" },
  { mode: "edit", label: "Edit" },
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
      "commandBarEl" | "contextChipsEl" | "textareaEl" | "modeToggleEl" | "actionBtn"
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
    this.refs.textareaEl.style.height = "auto";
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
    const chip = this.refs.contextChipsEl.createDiv({
      cls: `lmsa-chip lmsa-ui-chip${isEditMode ? " lmsa-chip--edit" : ""}`,
    });
    const fileIcon = chip.createEl("span", { cls: "lmsa-chip-icon" });
    setIcon(fileIcon, isEditMode ? "file-pen-line" : "file-text");
    chip.createEl("span", { cls: "lmsa-chip-label", text: fileName });
    const removeBtn = chip.createEl("button", {
      cls: "lmsa-chip-remove lmsa-ui-chip-dismiss",
      attr: { "aria-label": "Remove context" },
    });
    setIcon(removeBtn.createEl("span"), "x");
    removeBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      this.sessionContextEnabled = false;
      this.updateContextChips();
    });
  }

  renderCommandBar(): void {
    this.refs.commandBarEl.empty();

    const hasCustomCommands = this.plugin.settings.commands.length > 0;
    if (!hasCustomCommands) return;

    this.refs.commandBarEl.createEl("div", {
      cls: "lmsa-command-label",
      text: "Quick commands",
    });
    const chips = this.refs.commandBarEl.createDiv({ cls: "lmsa-command-chips" });

    for (const command of this.plugin.settings.commands) {
      const chip = chips.createEl("button", {
        cls: "lmsa-command-chip lmsa-ui-pill-button",
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

    for (const { mode, label } of MODE_OPTIONS) {
      const btn = this.refs.modeToggleEl.createEl("button", {
        cls: "lmsa-mode-toggle-btn",
        text: label,
        attr: { "aria-label": `${label} mode` },
      });
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
    this.refs.textareaEl.style.height = "auto";
    this.refs.textareaEl.style.height = `${this.refs.textareaEl.scrollHeight}px`;
  }
}
