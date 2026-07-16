import { setIcon } from "obsidian";
import { MAX_CONVERSATIONS } from "../../constants";
import type { ConversationMeta } from "../../shared/types";
import { conversationDisplayTitle, formatRelativeDate } from "../conversation/conversationUtils";
import type { ConversationSearchHit } from "../conversation/ConversationSearch";

export type DrawerCallbacks = {
  onSelect: (conversationId: string) => void;
  onNew: () => void;
  onDelete: (conversationId: string) => void;
  onRename: (conversationId: string, title: string) => void;
  onClose: () => void;
  /** Resolve the conversations matching a body/title search (see ChatSessionStore.searchConversations). */
  onSearch: (query: string) => Promise<ConversationSearchHit[]>;
  /** Fired after the drawer closes, so the search cache can be released. */
  onAfterClose?: () => void;
};

/** Debounce between keystroke and search, so a scan of long prose threads does not run per character. */
const SEARCH_DEBOUNCE_MS = 150;

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
  /** Raw trimmed search text; normalization happens in the search itself. */
  private filterQuery = "";
  /** Monotonic token so a slow search resolving after a newer keystroke is discarded. */
  private searchSeq = 0;
  private filterDebounceTimer: number | null = null;
  private conversations: ConversationMeta[] = [];
  private activeId: string | null = null;

  constructor(containerEl: HTMLElement, callbacks: DrawerCallbacks) {
    this.hostEl = containerEl;
    this.callbacks = callbacks;
    this.backdropEl = containerEl.createDiv({ cls: "lmsa-history-backdrop" });
    this.backdropEl.addEventListener("click", () => this.callbacks.onClose());
    this.drawerEl = containerEl.createDiv({ cls: "lmsa-history-drawer" });
    // Clicks inside the drawer must not bubble to the view's document-level
    // "click anywhere dismisses overlays" handler, which would otherwise close
    // the drawer the instant you click the search input. The backdrop still
    // handles outside-clicks; conversation select/new close it explicitly.
    this.drawerEl.addEventListener("click", (event) => event.stopPropagation());
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
    this.clearFilterTimer();
    this.callbacks.onAfterClose?.();
  }

  isOpen(): boolean {
    return this.drawerEl.hasClass("is-open");
  }

  refresh(conversations: ConversationMeta[], activeId: string | null): void {
    if (!this.isOpen()) return;
    this.render(conversations, activeId);
  }

  destroy(): void {
    this.clearFilterTimer();
  }

  private buildShell(): void {
    const header = this.drawerEl.createDiv({ cls: "lmsa-history-header" });

    const titleGroup = header.createDiv({ cls: "lmsa-history-title-group" });
    titleGroup.createSpan({ cls: "lmsa-history-title", text: "Chat history" });
    this.countEl = titleGroup.createSpan({
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

    // Substring filter over title, model name, and message body, so a thread is
    // findable in a full 50-item drawer without eyeball-scrolling. Body text is
    // scanned on demand (index-free); the input is debounced because a body scan of
    // long prose threads is heavier than the old title-only filter.
    this.searchRowEl = this.drawerEl.createDiv({ cls: "lmsa-history-search" });
    this.searchInputEl = this.searchRowEl.createEl("input", {
      cls: "lmsa-history-search-input",
      attr: { type: "text", placeholder: "Search conversations..." },
    });
    this.searchInputEl.addEventListener("input", () => {
      this.filterQuery = this.searchInputEl.value.trim();
      this.scheduleFilter();
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

  private scheduleFilter(): void {
    this.clearFilterTimer();
    this.filterDebounceTimer = window.setTimeout(() => {
      this.filterDebounceTimer = null;
      this.renderList();
    }, SEARCH_DEBOUNCE_MS);
  }

  private clearFilterTimer(): void {
    if (this.filterDebounceTimer === null) return;
    window.clearTimeout(this.filterDebounceTimer);
    this.filterDebounceTimer = null;
  }

  private renderList(): void {
    if (this.conversations.length === 0) {
      this.listEl.empty();
      this.listEl.createDiv({
        cls: "lmsa-history-empty",
        text: "No conversations yet. Start one below.",
      });
      return;
    }

    // No query: render every conversation immediately, no async round-trip.
    if (!this.filterQuery) {
      this.renderHits(this.conversations.map((meta) => ({ meta })));
      return;
    }

    // A query: search asynchronously (body scan) and keep the current rows visible
    // until results arrive. A stale token or a closed drawer discards the result.
    const seq = ++this.searchSeq;
    const query = this.filterQuery;
    void this.callbacks.onSearch(query).then((hits) => {
      if (seq !== this.searchSeq || !this.isOpen()) return;
      this.renderHits(hits, query);
    });
  }

  private renderHits(hits: ConversationSearchHit[], query = ""): void {
    this.listEl.empty();

    if (hits.length === 0) {
      this.listEl.createDiv({
        cls: "lmsa-history-empty",
        text: "No conversations match your search.",
      });
      return;
    }

    for (const hit of hits) {
      this.renderItem(hit.meta, hit.meta.id === this.activeId, hit.snippet, query);
    }
  }

  private renderItem(
    conversation: ConversationMeta,
    isActive: boolean,
    snippet?: string,
    query = "",
  ): void {
    const item = this.listEl.createDiv({
      cls: "lmsa-history-item lmsa-ui-list-item" + (isActive ? " is-active" : ""),
      attr: { "data-conv-id": conversation.id },
    });

    const body = item.createDiv({ cls: "lmsa-history-item-body" });
    const displayTitle = conversationDisplayTitle(conversation);
    const titleEl = body.createDiv({ cls: "lmsa-history-item-title", text: displayTitle });

    const messageLabel = conversation.messageCount === 1 ? "1 msg" : `${conversation.messageCount} msgs`;
    const dateLabel = formatRelativeDate(conversation.updatedAt);
    const meta = [dateLabel, messageLabel, conversation.modelName]
      .filter(Boolean)
      .join(" - ");
    body.createDiv({ cls: "lmsa-history-item-meta", text: meta });

    if (snippet) this.renderSnippet(body, snippet, query);

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

  /** Render a body-match excerpt under the row, highlighting the matched span when it can be located. */
  private renderSnippet(container: HTMLElement, snippet: string, query: string): void {
    const el = container.createDiv({ cls: "lmsa-history-item-snippet" });
    const index = query ? snippet.toLowerCase().indexOf(query.toLowerCase()) : -1;
    if (index < 0) {
      el.setText(snippet);
      return;
    }
    el.createSpan({ text: snippet.slice(0, index) });
    el.createSpan({
      cls: "lmsa-history-item-snippet-mark",
      text: snippet.slice(index, index + query.length),
    });
    el.createSpan({ text: snippet.slice(index + query.length) });
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
    });
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
