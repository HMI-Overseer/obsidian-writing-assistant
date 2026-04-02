import type { BubbleRefs } from "../types";

export class InlineMessageEditor {
  private editorEl: HTMLElement | null = null;
  private textareaEl: HTMLTextAreaElement | null = null;

  constructor(
    private readonly bubble: BubbleRefs,
    private readonly originalContent: string,
    private readonly callbacks: {
      onSave: (newContent: string) => void;
      onCancel: () => void;
    }
  ) {}

  activate(): void {
    const contentHeight = this.bubble.contentEl.offsetHeight;

    this.bubble.rowEl.addClass("is-editing");
    this.bubble.contentEl.addClass("lmsa-hidden");

    this.editorEl = this.bubble.bodyEl.createDiv({ cls: "lmsa-inline-editor" });

    this.textareaEl = this.editorEl.createEl("textarea", {
      cls: "lmsa-inline-editor-textarea",
      attr: { rows: "1" },
    });
    this.textareaEl.value = this.originalContent;
    this.textareaEl.style.minHeight = `${contentHeight}px`;

    const actionsEl = this.editorEl.createDiv({
      cls: "lmsa-inline-editor-actions",
    });

    const cancelBtn = actionsEl.createEl("button", {
      cls: "lmsa-ui-compact-btn lmsa-ui-compact-btn-secondary",
      text: "Cancel",
      attr: { type: "button" },
    });

    const saveBtn = actionsEl.createEl("button", {
      cls: "lmsa-ui-compact-btn lmsa-inline-editor-save",
      text: "Save",
      attr: { type: "button" },
    });

    requestAnimationFrame(() => {
      this.autoResize();
      this.textareaEl?.focus();
    });

    this.textareaEl.addEventListener("input", () => this.autoResize());

    this.textareaEl.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        this.cancel();
      }
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        this.save();
      }
    });

    saveBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.save();
    });

    cancelBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.cancel();
    });
  }

  destroy(): void {
    this.bubble.rowEl.removeClass("is-editing");
    this.bubble.contentEl.removeClass("lmsa-hidden");
    this.editorEl?.remove();
    this.editorEl = null;
    this.textareaEl = null;
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

  private autoResize(): void {
    if (!this.textareaEl) return;
    this.textareaEl.setCssStyles({ height: "auto" });
    this.textareaEl.setCssStyles({ height: `${this.textareaEl.scrollHeight}px` });
  }
}
