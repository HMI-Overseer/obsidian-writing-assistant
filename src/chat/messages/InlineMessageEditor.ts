import { setIcon } from "obsidian";
import type { BubbleRefs } from "../types";
import { collectInlineEdits } from "./inlineEditSession";
import type { InlineEdit, InlineEditTarget } from "./inlineEditSession";

interface EditorSurface {
  target: InlineEditTarget;
  hostEl: HTMLElement;
  textareaEl: HTMLTextAreaElement;
}

/**
 * One edit session over one assistant turn or one message.
 *
 * An agentic turn opens every prose item at once, because the turn is the unit
 * that regeneration and branching already address; there is no way to act on
 * half of one. The session therefore has one Save and one Cancel, in the
 * bubble's own action bar, and commits once.
 */
export class InlineMessageEditor {
  private surfaces: EditorSurface[] = [];
  private injectedEls: HTMLElement[] = [];

  constructor(
    private readonly bubble: BubbleRefs,
    private readonly targets: readonly InlineEditTarget[],
    private readonly callbacks: {
      onSave: (edits: InlineEdit[]) => void;
      onCancel: () => void;
    },
  ) {}

  activate(): void {
    for (const target of this.targets) {
      const hostEl = this.resolveHost(target);
      const textareaEl = hostEl ? this.openSurface(hostEl, target) : null;
      if (hostEl && textareaEl) {
        this.surfaces.push({ target, hostEl, textareaEl });
      }
    }
    if (this.surfaces.length === 0) {
      this.callbacks.onCancel();
      return;
    }

    this.bubble.rowEl.addClass("is-editing");
    this.renderActions();

    window.requestAnimationFrame(() => {
      this.surfaces[0]?.textareaEl.focus();
    });
  }

  private resolveHost(target: InlineEditTarget): HTMLElement | null {
    if (this.bubble.role !== "assistant") return this.bubble.contentEl;
    return target.proseItemId
      ? this.bubble.turnView.getProseHost(target.proseItemId)
      : this.bubble.turnView.getPrimaryProseHost();
  }

  /**
   * Edit in place: the textarea takes the content's exact spot, transparent and
   * borderless, so no extra box appears around the text.
   */
  private openSurface(
    hostEl: HTMLElement,
    target: InlineEditTarget,
  ): HTMLTextAreaElement | null {
    const editorHostEl =
      this.bubble.role === "assistant" ? hostEl.parentElement : this.bubble.bodyEl;
    if (!editorHostEl) return null;
    const textareaEl = editorHostEl.createEl("textarea", {
      cls: "lmsa-chat-window-inline-editor-textarea",
      attr: { rows: "1" },
    });
    if (this.bubble.role === "assistant") {
      textareaEl.addClass("lmsa-assistant-turn-item-body");
      hostEl.before(textareaEl);
    }
    hostEl.addClass("lmsa-hidden");
    textareaEl.value = target.originalText;

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
    return textareaEl;
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
    for (const surface of this.surfaces) {
      surface.hostEl.removeClass("lmsa-hidden");
      surface.textareaEl.remove();
    }
    this.surfaces = [];
    for (const el of this.injectedEls) el.remove();
    this.injectedEls = [];
  }

  private save(): void {
    const edits = collectInlineEdits(
      this.surfaces.map((surface) => surface.target),
      this.surfaces.map((surface) => surface.textareaEl.value),
    );

    if (edits.length === 0) {
      this.cancel();
      return;
    }

    this.callbacks.onSave(edits);
    this.destroy();
  }

  private cancel(): void {
    this.callbacks.onCancel();
    this.destroy();
  }
}
