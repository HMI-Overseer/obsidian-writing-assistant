import { setIcon } from "obsidian";
import { MAX_CONVERSATIONS } from "../../constants";
import type { Conversation } from "../../shared/types";
import { formatRelativeDate } from "../conversation/conversationUtils";

export type DrawerCallbacks = {
  onSelect: (conversationId: string) => void;
  onNew: () => void;
  onDelete: (conversationId: string) => void;
  onClose: () => void;
};

export class ChatHistoryDrawer {
  private hostEl: HTMLElement;
  private backdropEl: HTMLElement;
  private drawerEl: HTMLElement;
  private listEl!: HTMLElement;
  private countEl!: HTMLElement;
  private callbacks: DrawerCallbacks;

  private pendingDeleteId: string | null = null;

  constructor(containerEl: HTMLElement, callbacks: DrawerCallbacks) {
    this.hostEl = containerEl;
    this.callbacks = callbacks;
    this.backdropEl = containerEl.createDiv({ cls: "lmsa-history-backdrop" });
    this.backdropEl.addEventListener("click", () => this.callbacks.onClose());
    this.drawerEl = containerEl.createDiv({ cls: "lmsa-history-drawer" });
    this.buildShell();
  }

  open(conversations: Conversation[], activeId: string | null): void {
    this.pendingDeleteId = null;
    this.render(conversations, activeId);
    this.hostEl.addClass("is-history-open");
    this.backdropEl.addClass("is-open");
    this.drawerEl.addClass("is-open");
  }

  close(): void {
    this.hostEl.removeClass("is-history-open");
    this.backdropEl.removeClass("is-open");
    this.drawerEl.removeClass("is-open");
    this.pendingDeleteId = null;
  }

  isOpen(): boolean {
    return this.drawerEl.hasClass("is-open");
  }

  refresh(conversations: Conversation[], activeId: string | null): void {
    if (!this.isOpen()) return;
    this.render(conversations, activeId);
  }

  destroy(): void {
    /* Reserved for future cleanup. */
  }

  private buildShell(): void {
    const header = this.drawerEl.createDiv({ cls: "lmsa-history-header" });

    const titleGroup = header.createDiv({ cls: "lmsa-history-title-group" });
    titleGroup.createEl("span", { cls: "lmsa-history-title", text: "Chat History" });
    this.countEl = titleGroup.createEl("span", {
      cls: "lmsa-history-count",
      text: "",
    });

    const actions = header.createDiv({ cls: "lmsa-history-header-actions" });

    const newBtn = actions.createEl("button", {
      cls: "lmsa-header-btn lmsa-ui-icon-btn",
      attr: { "aria-label": "New conversation" },
    });
    setIcon(newBtn, "plus");
    newBtn.addEventListener("click", () => this.callbacks.onNew());

    this.listEl = this.drawerEl.createDiv({ cls: "lmsa-history-list" });
  }

  private render(conversations: Conversation[], activeId: string | null): void {
    this.listEl.empty();
    this.countEl.setText(`${conversations.length} / ${MAX_CONVERSATIONS}`);

    if (conversations.length === 0) {
      this.listEl.createDiv({
        cls: "lmsa-history-empty",
        text: "No conversations yet. Start one below.",
      });
      return;
    }

    for (const conversation of conversations) {
      this.renderItem(conversation, conversation.id === activeId);
    }
  }

  private renderItem(conversation: Conversation, isActive: boolean): void {
    const item = this.listEl.createDiv({
      cls: "lmsa-history-item lmsa-ui-list-item" + (isActive ? " is-active" : ""),
      attr: { "data-conv-id": conversation.id },
    });

    const body = item.createDiv({ cls: "lmsa-history-item-body" });
    const displayTitle =
      conversation.title ||
      (conversation.messages.length === 0 ? "New conversation" : "Untitled");
    body.createDiv({ cls: "lmsa-history-item-title", text: displayTitle });

    const messageCount = conversation.messages.length;
    const messageLabel = messageCount === 1 ? "1 msg" : `${messageCount} msgs`;
    const dateLabel = formatRelativeDate(conversation.updatedAt);
    const meta = [dateLabel, messageLabel, conversation.modelName]
      .filter(Boolean)
      .join(" - ");
    body.createDiv({ cls: "lmsa-history-item-meta", text: meta });

    body.addEventListener("click", () => {
      if (this.pendingDeleteId === conversation.id) return;
      this.callbacks.onSelect(conversation.id);
    });

    const deleteArea = item.createDiv({ cls: "lmsa-history-item-delete-area" });
    this.renderDeleteControl(deleteArea, conversation.id);
  }

  private renderDeleteControl(container: HTMLElement, conversationId: string): void {
    container.empty();

    if (this.pendingDeleteId === conversationId) {
      const confirmBtn = container.createEl("button", {
        cls: "lmsa-history-delete-confirm lmsa-ui-compact-btn lmsa-ui-compact-btn-danger",
        text: "Delete",
      });
      confirmBtn.addEventListener("click", (event) => {
        event.stopPropagation();
        this.pendingDeleteId = null;
        this.callbacks.onDelete(conversationId);
      });

      const cancelBtn = container.createEl("button", {
        cls: "lmsa-history-delete-cancel lmsa-ui-compact-btn lmsa-ui-compact-btn-secondary",
        text: "Cancel",
      });
      cancelBtn.addEventListener("click", (event) => {
        event.stopPropagation();
        this.pendingDeleteId = null;
        this.renderDeleteControl(container, conversationId);
      });
      return;
    }

    const trashBtn = container.createEl("button", {
      cls: "lmsa-header-btn lmsa-history-trash-btn lmsa-ui-icon-btn",
      attr: { "aria-label": "Delete conversation" },
    });
    setIcon(trashBtn, "trash-2");
    trashBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      if (this.pendingDeleteId && this.pendingDeleteId !== conversationId) {
        const oldArea = this.listEl.querySelector(
          `.lmsa-history-item[data-conv-id="${this.pendingDeleteId}"] .lmsa-history-item-delete-area`
        );
        if (oldArea instanceof HTMLElement) {
          this.renderDeleteControl(oldArea, this.pendingDeleteId);
        }
      }
      this.pendingDeleteId = conversationId;
      this.renderDeleteControl(container, conversationId);
    });
  }
}
