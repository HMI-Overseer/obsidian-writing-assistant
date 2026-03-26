import { setIcon } from "obsidian";
import type { Conversation } from "../shared/types";
import { MAX_CONVERSATIONS } from "../constants";
import { formatRelativeDate } from "./conversationHistory";

export type DrawerCallbacks = {
  onSelect: (conversationId: string) => void;
  onNew: () => void;
  onDelete: (conversationId: string) => void;
  onClose: () => void;
};

export class ChatHistoryDrawer {
  private drawerEl: HTMLElement;
  private listEl: HTMLElement;
  private countEl: HTMLElement;
  private callbacks: DrawerCallbacks;

  /** id of a conversation currently showing the confirm/cancel delete UI */
  private pendingDeleteId: string | null = null;

  constructor(containerEl: HTMLElement, callbacks: DrawerCallbacks) {
    this.callbacks = callbacks;
    this.drawerEl = containerEl.createDiv({ cls: "lmsa-history-drawer" });
    this.buildShell();
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  open(conversations: Conversation[], activeId: string | null): void {
    this.pendingDeleteId = null;
    this.render(conversations, activeId);
    this.drawerEl.addClass("is-open");
  }

  close(): void {
    this.drawerEl.removeClass("is-open");
    this.pendingDeleteId = null;
  }

  isOpen(): boolean {
    return this.drawerEl.hasClass("is-open");
  }

  /** Re-render list in-place (e.g. after a conversation title updates mid-session). */
  refresh(conversations: Conversation[], activeId: string | null): void {
    if (!this.isOpen()) return;
    this.render(conversations, activeId);
  }

  // ---------------------------------------------------------------------------
  // Private — DOM construction
  // ---------------------------------------------------------------------------

  private buildShell(): void {
    const header = this.drawerEl.createDiv({ cls: "lmsa-history-header" });

    const titleGroup = header.createDiv({ cls: "lmsa-history-title-group" });
    titleGroup.createEl("span", { cls: "lmsa-history-title", text: "Chat History" });
    this.countEl = titleGroup.createEl("span", { cls: "lmsa-history-count", text: "" });

    const actions = header.createDiv({ cls: "lmsa-history-header-actions" });

    const newBtn = actions.createEl("button", {
      cls: "lmsa-header-btn",
      attr: { "aria-label": "New conversation" },
    });
    setIcon(newBtn, "plus");
    newBtn.addEventListener("click", () => this.callbacks.onNew());

    this.listEl = this.drawerEl.createDiv({ cls: "lmsa-history-list" });
  }

  private render(conversations: Conversation[], activeId: string | null): void {
    this.listEl.empty();

    // Update counter
    this.countEl.setText(`${conversations.length} / ${MAX_CONVERSATIONS}`);

    if (conversations.length === 0) {
      this.listEl.createDiv({
        cls: "lmsa-history-empty",
        text: "No conversations yet. Start one below.",
      });
      return;
    }

    for (const conv of conversations) {
      this.renderItem(conv, conv.id === activeId);
    }
  }

  private renderItem(conv: Conversation, isActive: boolean): void {
    const item = this.listEl.createDiv({
      cls: "lmsa-history-item" + (isActive ? " is-active" : ""),
      attr: { "data-conv-id": conv.id },
    });

    // Clickable body
    const body = item.createDiv({ cls: "lmsa-history-item-body" });
    const displayTitle =
      conv.title || (conv.messages.length === 0 ? "New conversation" : "Untitled");
    body.createDiv({ cls: "lmsa-history-item-title", text: displayTitle });

    const msgCount = conv.messages.length;
    const msgLabel = msgCount === 1 ? "1 msg" : `${msgCount} msgs`;
    const dateLabel = formatRelativeDate(conv.updatedAt);
    const meta = [dateLabel, msgLabel, conv.modelName].filter(Boolean).join(" · ");
    body.createDiv({ cls: "lmsa-history-item-meta", text: meta });

    body.addEventListener("click", () => {
      if (this.pendingDeleteId === conv.id) return; // ignore while confirm is shown
      this.callbacks.onSelect(conv.id);
    });

    // Delete / confirm area
    const deleteArea = item.createDiv({ cls: "lmsa-history-item-delete-area" });
    this.renderDeleteControl(deleteArea, conv.id);
  }

  private renderDeleteControl(container: HTMLElement, convId: string): void {
    container.empty();

    if (this.pendingDeleteId === convId) {
      // Show confirm / cancel
      const confirmBtn = container.createEl("button", {
        cls: "lmsa-history-delete-confirm",
        text: "Delete",
      });
      confirmBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        this.pendingDeleteId = null;
        this.callbacks.onDelete(convId);
      });

      const cancelBtn = container.createEl("button", {
        cls: "lmsa-history-delete-cancel",
        text: "Cancel",
      });
      cancelBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        this.pendingDeleteId = null;
        // Re-render the delete control back to the trash icon
        this.renderDeleteControl(container, convId);
      });
    } else {
      const trashBtn = container.createEl("button", {
        cls: "lmsa-header-btn lmsa-history-trash-btn",
        attr: { "aria-label": "Delete conversation" },
      });
      setIcon(trashBtn, "trash-2");
      trashBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        // Cancel any other pending delete first
        if (this.pendingDeleteId && this.pendingDeleteId !== convId) {
          // Find the old pending item's delete area and reset it
          const oldArea = this.listEl.querySelector(
            `.lmsa-history-item[data-conv-id="${this.pendingDeleteId}"] .lmsa-history-item-delete-area`
          );
          if (oldArea instanceof HTMLElement) {
            this.renderDeleteControl(oldArea, this.pendingDeleteId);
          }
        }
        this.pendingDeleteId = convId;
        this.renderDeleteControl(container, convId);
      });
    }
  }
}
