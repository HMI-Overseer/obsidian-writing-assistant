import { setIcon } from "obsidian";
import type { BubbleRefs } from "../types";

export class InlineMessageEditor {
  private textareaEl: HTMLTextAreaElement | null = null;
  private editingContentEl: HTMLElement | null = null;
  private injectedEls: HTMLElement[] = [];

  constructor(
    private readonly bubble: BubbleRefs,
    private readonly originalContent: string,
    private readonly callbacks: {
      onSave: (newContent: string) => void;
      onCancel: () => void;
    }
  ) {}

  activate(): void {
    const contentEl =
      this.bubble.role === "assistant"
        ? this.bubble.turnView.getPrimaryProseHost()
        : this.bubble.contentEl;
    if (!contentEl) {
      this.callbacks.onCancel();
      return;
    }
    const editorHostEl =
      this.bubble.role === "assistant"
        ? this.bubble.turnView.rootEl
        : this.bubble.bodyEl;

    this.bubble.rowEl.addClass("is-editing");
    contentEl.addClass("lmsa-hidden");
    this.editingContentEl = contentEl;

    // Edit in place: the textarea takes the content's exact spot in the bubble
    // body, transparent and borderless, so no extra box appears around the text.
    const textareaEl = editorHostEl.createEl("textarea", {
      cls: "lmsa-chat-window-inline-editor-textarea",
      attr: { rows: "1" },
    });
    this.textareaEl = textareaEl;
    textareaEl.value = this.originalContent;

    this.renderActions();

    window.requestAnimationFrame(() => {
      this.textareaEl?.focus();
    });

    textareaEl.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        this.cancel();
      }
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        this.save();
      }
    });
  }

  /**
   * Inject Save straight into the bubble's own action-button row (the same row
   * the edit button lives in). It reuses the action-button class so it is visually
   * one of the bubble actions, and the other icons are hidden by CSS. Nothing is
   * added to the bubble's flow, so entering edit mode never shifts the layout.
   */
  private renderActions(): void {
    const actionsHost = this.bubble.rowEl.querySelector<HTMLElement>(
      ".lmsa-chat-window-message-actions"
    );
    if (!actionsHost) return;

    const cancelBtn = actionsHost.createEl("button", {
      cls: "lmsa-chat-window-action-btn is-edit-control",
      attr: { "aria-label": "Cancel (esc)", type: "button" },
    });
    setIcon(cancelBtn, "x");
    cancelBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.cancel();
    });
    this.injectedEls.push(cancelBtn);

    const saveBtn = actionsHost.createEl("button", {
      cls: "lmsa-chat-window-action-btn is-edit-control lmsa-chat-window-inline-editor-save",
      attr: { "aria-label": "Save changes (Ctrl+Enter)", type: "button" },
    });
    setIcon(saveBtn, "save");
    saveBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.save();
    });
    this.injectedEls.push(saveBtn);
  }

  destroy(): void {
    this.bubble.rowEl.removeClass("is-editing");
    this.editingContentEl?.removeClass("lmsa-hidden");
    this.textareaEl?.remove();
    for (const el of this.injectedEls) el.remove();
    this.injectedEls = [];
    this.textareaEl = null;
    this.editingContentEl = null;
  }

  private save(): void {
    const newContent = this.textareaEl?.value ?? this.originalContent;
    const trimmed = newContent.trim();

    if (!trimmed || trimmed === this.originalContent) {
      this.cancel();
      return;
    }

    this.callbacks.onSave(trimmed);
    this.destroy();
  }

  private cancel(): void {
    this.callbacks.onCancel();
    this.destroy();
  }
}
