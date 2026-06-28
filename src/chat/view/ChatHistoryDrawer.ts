import { setIcon } from "obsidian";
import { MAX_CONVERSATIONS } from "../../constants";
import type { ConversationMeta } from "../../shared/types";
import { formatRelativeDate } from "../conversation/conversationUtils";

export type DrawerCallbacks = {
  onSelect: (conversationId: string) => void;
  onNew: () => void;
  onDelete: (conversationId: string) => void;
  onRename: (conversationId: string, title: string) => void;
  onClose: () => void;
};

export class ChatHistoryDrawer {
  private hostEl: HTMLElement;
  private backdropEl: HTMLElement;
  private drawerEl: HTMLElement;
  private listEl!: HTMLElement;
  private countEl!: HTMLElement;
  private searchRowEl!: HTMLElement;
  private searchInputEl!: HTMLInputElement;
  private callbacks: DrawerCallbacks;

  private pendingDeleteId: string | null = null;
  private renamingId: string | null = null;
  private filterQuery = "";
  private conversations: ConversationMeta[] = [];
  private activeId: string | null = null;

  constructor(containerEl: HTMLElement, callbacks: DrawerCallbacks) {
    this.hostEl = containerEl;
    this.callbacks = callbacks;
    this.backdropEl = containerEl.createDiv({ cls: "lmsa-history-backdrop" });
    this.backdropEl.addEventListener("click", () => this.callbacks.onClose());
    this.drawerEl = containerEl.createDiv({ cls: "lmsa-history-drawer" });
    this.buildShell();
  }

  open(conversations: ConversationMeta[], activeId: string | null): void {
    this.pendingDeleteId = null;
    this.renamingId = null;
    this.filterQuery = "";
    this.searchInputEl.value = "";
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
    this.renamingId = null;
  }

  isOpen(): boolean {
    return this.drawerEl.hasClass("is-open");
  }

  refresh(conversations: ConversationMeta[], activeId: string | null): void {
    if (!this.isOpen()) return;
    this.render(conversations, activeId);
  }

  destroy(): void {
    /* Reserved for future cleanup. */
  }

  private buildShell(): void {
    const header = this.drawerEl.createDiv({ cls: "lmsa-history-header" });

    const titleGroup = header.createDiv({ cls: "lmsa-history-title-group" });
    titleGroup.createEl("span", { cls: "lmsa-history-title", text: "Chat history" });
    this.countEl = titleGroup.createEl("span", {
      cls: "lmsa-history-count",
      text: "",
    });

    const actions = header.createDiv({ cls: "lmsa-history-header-actions" });

    const newBtn = actions.createEl("button", {
      cls: "lmsa-history-btn lmsa-ui-icon-btn",
      attr: { "aria-label": "New conversation" },
    });
    setIcon(newBtn, "plus");
    newBtn.addEventListener("click", () => this.callbacks.onNew());

    // Substring filter over title and model name, so a thread is findable in a full
    // 50-item drawer without eyeball-scrolling. Filtering only re-renders the list.
    this.searchRowEl = this.drawerEl.createDiv({ cls: "lmsa-history-search" });
    this.searchInputEl = this.searchRowEl.createEl("input", {
      cls: "lmsa-history-search-input",
      attr: { type: "text", placeholder: "Search conversations..." },
    }) as HTMLInputElement;
    this.searchInputEl.addEventListener("input", () => {
      this.filterQuery = this.searchInputEl.value.trim().toLowerCase();
      this.renderList();
    });

    this.listEl = this.drawerEl.createDiv({ cls: "lmsa-history-list" });
  }

  private render(conversations: ConversationMeta[], activeId: string | null): void {
    this.conversations = conversations;
    this.activeId = activeId;
    this.countEl.setText(`${conversations.length} / ${MAX_CONVERSATIONS}`);
    this.searchRowEl.toggleClass("lmsa-hidden", conversations.length === 0);
    this.renderList();
  }

  private renderList(): void {
    this.listEl.empty();

    if (this.conversations.length === 0) {
      this.listEl.createDiv({
        cls: "lmsa-history-empty",
        text: "No conversations yet. Start one below.",
      });
      return;
    }

    const matches = this.filterQuery
      ? this.conversations.filter((c) => this.matchesFilter(c))
      : this.conversations;

    if (matches.length === 0) {
      this.listEl.createDiv({
        cls: "lmsa-history-empty",
        text: "No conversations match your search.",
      });
      return;
    }

    for (const conversation of matches) {
      this.renderItem(conversation, conversation.id === this.activeId);
    }
  }

  private matchesFilter(conversation: ConversationMeta): boolean {
    const title =
      conversation.title ||
      (conversation.messageCount === 0 ? "New conversation" : "Untitled");
    const haystack = `${title} ${conversation.modelName ?? ""}`.toLowerCase();
    return haystack.includes(this.filterQuery);
  }

  private renderItem(conversation: ConversationMeta, isActive: boolean): void {
    const item = this.listEl.createDiv({
      cls: "lmsa-history-item lmsa-ui-list-item" + (isActive ? " is-active" : ""),
      attr: { "data-conv-id": conversation.id },
    });

    const body = item.createDiv({ cls: "lmsa-history-item-body" });
    const displayTitle =
      conversation.title ||
      (conversation.messageCount === 0 ? "New conversation" : "Untitled");
    const titleEl = body.createDiv({ cls: "lmsa-history-item-title", text: displayTitle });

    const messageLabel = conversation.messageCount === 1 ? "1 msg" : `${conversation.messageCount} msgs`;
    const dateLabel = formatRelativeDate(conversation.updatedAt);
    const meta = [dateLabel, messageLabel, conversation.modelName]
      .filter(Boolean)
      .join(" - ");
    body.createDiv({ cls: "lmsa-history-item-meta", text: meta });

    body.addEventListener("click", () => {
      if (this.pendingDeleteId === conversation.id) return;
      if (this.renamingId === conversation.id) return;
      this.callbacks.onSelect(conversation.id);
    });

    const renameBtn = item.createEl("button", {
      cls: "lmsa-history-btn lmsa-history-rename-btn lmsa-ui-icon-btn",
      attr: { "aria-label": "Rename conversation" },
    });
    setIcon(renameBtn, "pencil");
    renameBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      this.startRename(titleEl, conversation, displayTitle);
    });

    const deleteArea = item.createDiv({ cls: "lmsa-history-item-delete-area" });
    this.renderDeleteControl(deleteArea, conversation.id);
  }

  /** Turn a conversation title into an inline editable input. Enter commits, Escape cancels. */
  private startRename(titleEl: HTMLElement, conversation: ConversationMeta, currentLabel: string): void {
    if (this.renamingId) return;
    this.renamingId = conversation.id;

    titleEl.empty();
    titleEl.addClass("is-renaming");
    const input = titleEl.createEl("input", {
      cls: "lmsa-history-rename-input",
      attr: { type: "text" },
    }) as HTMLInputElement;
    input.value = conversation.title || currentLabel;
    input.focus();
    input.select();

    const finish = (commit: boolean): void => {
      if (this.renamingId !== conversation.id) return;
      this.renamingId = null;
      const next = input.value.trim();
      if (commit && next && next !== conversation.title) {
        // onRename triggers a refresh that re-renders the row with the new title.
        this.callbacks.onRename(conversation.id, next);
        return;
      }
      titleEl.removeClass("is-renaming");
      titleEl.empty();
      titleEl.setText(currentLabel);
    };

    // Keep clicks inside the editor from bubbling to the row's select handler.
    input.addEventListener("click", (e) => e.stopPropagation());
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") {
        e.preventDefault();
        finish(true);
      } else if (e.key === "Escape") {
        e.preventDefault();
        finish(false);
      }
    });
    input.addEventListener("blur", () => finish(true));
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
      cls: "lmsa-history-btn lmsa-history-trash-btn lmsa-ui-icon-btn",
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
