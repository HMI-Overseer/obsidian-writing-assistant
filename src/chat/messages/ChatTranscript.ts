import { setIcon } from "obsidian";
import type { App, Component } from "obsidian";
import type { Attachment, ConversationMessage } from "../../shared/types";
import type { BubbleRefs, BubbleRenderOptions, ChatLayoutRefs } from "../types";
import { GENERATION_STOPPED_LABEL } from "../types";
import type { MarkdownBubbleRenderer } from "../rendering/MarkdownBubbleRenderer";
import { MarkdownItBubbleRenderer } from "../rendering/MarkdownItBubbleRenderer";
import { BubbleActionToolbar } from "./BubbleActionToolbar";
import { BubbleVersionNav } from "./BubbleVersionNav";
import { renderUsageBadge } from "./UsageBadge";
import { renderRagSources } from "./RagSourcesList";
import { AgenticTimeline } from "./AgenticTimeline";
import { ImagePreviewModal } from "./ImagePreviewModal";

export type BubbleActionCallbacks = {
  onCopy: (messageId: string) => void;
  onEdit: (messageId: string) => void;
  onDelete: (messageId: string) => void;
  onBranch: (messageId: string) => void;
  onRegenerate: (messageId: string) => void;
  onVersionChange: (messageId: string, newIndex: number) => void;
};

const AUTO_SCROLL_BOTTOM_THRESHOLD_PX = 10;
/** Past this much scroll-up, the jump-to-latest button appears (above the tiny re-arm zone). */
const SCROLL_TO_BOTTOM_VISIBILITY_PX = 120;

export class ChatTranscript {
  private bubblesByMessageId = new Map<string, BubbleRefs>();
  private renderedMessageIds: string[] = [];
  private shouldAutoScroll = true;
  private readonly markdownRenderer: MarkdownBubbleRenderer;
  private readonly scrollToBottomBtn: HTMLElement | null;

  constructor(
    private readonly owner: Component,
    private readonly app: App,
    private readonly refs: Pick<ChatLayoutRefs, "messagesEl" | "emptyStateEl">,
    markdownRenderer?: MarkdownBubbleRenderer
  ) {
    this.markdownRenderer =
      markdownRenderer ??
      new MarkdownItBubbleRenderer(this.app);
    this.scrollToBottomBtn = this.createScrollToBottomButton();
    this.owner.registerDomEvent(this.refs.messagesEl, "scroll", () => {
      this.shouldAutoScroll = this.isNearBottom();
      this.updateScrollToBottomButton();
    });
  }

  /**
   * Floating jump-to-latest affordance. Auto-follow silently disengages when the reader
   * scrolls up mid-stream (shouldAutoScroll goes false), so without this new tokens land
   * off-screen with no way back short of dragging to the very bottom. Mounted on the
   * (positioned) messages pane so it floats over the scroll area.
   */
  private createScrollToBottomButton(): HTMLElement | null {
    const pane = this.refs.messagesEl.parentElement;
    if (!pane) return null;
    const btn = pane.createEl("button", {
      cls: "lmsa-scroll-to-bottom lmsa-hidden",
      attr: { "aria-label": "Jump to latest" },
    });
    const icon = btn.createEl("span", { cls: "lmsa-scroll-to-bottom-icon" });
    setIcon(icon, "chevron-down");
    btn.createEl("span", { text: "Jump to latest" });
    this.owner.registerDomEvent(btn, "click", () => this.scrollToBottom(true));
    return btn;
  }

  private updateScrollToBottomButton(): void {
    if (!this.scrollToBottomBtn) return;
    const distanceFromBottom =
      this.refs.messagesEl.scrollHeight -
      this.refs.messagesEl.scrollTop -
      this.refs.messagesEl.clientHeight;
    this.scrollToBottomBtn.toggleClass(
      "lmsa-hidden",
      distanceFromBottom <= SCROLL_TO_BOTTOM_VISIBILITY_PX
    );
  }

  async renderMessages(
    messages: ConversationMessage[],
    actionCallbacks?: BubbleActionCallbacks,
    forceScroll = true
  ): Promise<void> {
    const newIds = messages.map((m) => m.id);
    const canIncrement = this.canIncrementalUpdate(newIds);

    if (canIncrement) {
      await this.incrementalRender(messages, actionCallbacks);
    } else {
      await this.fullRender(messages, actionCallbacks);
    }

    this.renderedMessageIds = newIds;
    this.scrollToBottom(forceScroll);
  }

  /**
   * Incremental render is possible when the existing messages are a prefix
   * of the new message list (same IDs in the same order). This handles the
   * common case: new messages appended to the end of a conversation.
   */
  private canIncrementalUpdate(newIds: string[]): boolean {
    if (this.renderedMessageIds.length === 0) return false;
    if (this.renderedMessageIds.length > newIds.length) return false;
    if (this.renderedMessageIds.length === newIds.length) return false;

    for (let i = 0; i < this.renderedMessageIds.length; i++) {
      if (this.renderedMessageIds[i] !== newIds[i]) return false;
    }
    return true;
  }

  private async incrementalRender(
    messages: ConversationMessage[],
    actionCallbacks?: BubbleActionCallbacks,
  ): Promise<void> {
    const lastAssistantIndex = this.findLastAssistantIndex(messages);
    const startIndex = this.renderedMessageIds.length;

    for (let i = startIndex; i < messages.length; i++) {
      const message = messages[i];
      const bubble = this.createBubble(message.role, message.id);
      await this.renderMessageBody(bubble, message);

      if (actionCallbacks) {
        const isLastAssistant = i === lastAssistantIndex;
        this.attachBubbleActions(bubble, message, isLastAssistant, actionCallbacks);
      }
    }
  }

  /**
   * Renders a persisted message's timeline and body into its bubble. A persisted
   * empty assistant turn is a stopped (aborted) claudecode generation
   * (`GENERATION_STOPPED_LABEL` persist-always, ADR-0016): render
   * the same muted face `finalizeAbortedResponse` shows live, not a blank bubble.
   */
  private async renderMessageBody(bubble: BubbleRefs, message: ConversationMessage): Promise<void> {
    if (message.role === "assistant" && message.agenticSteps?.length) {
      AgenticTimeline.render(bubble.timelineEl, message.agenticSteps);
    }

    if (message.isError) {
      bubble.bodyEl.addClass("is-error");
      this.renderPlainTextContent(bubble, message.content);
    } else if (message.role === "assistant" && message.content === "") {
      this.renderPlainTextContent(bubble, GENERATION_STOPPED_LABEL);
      bubble.bodyEl.addClass("is-muted");
    } else {
      await this.renderBubbleContent(bubble, message.content, { attachments: message.attachments });
    }
  }

  private async fullRender(
    messages: ConversationMessage[],
    actionCallbacks?: BubbleActionCallbacks,
  ): Promise<void> {
    const wasAutoScroll = this.shouldAutoScroll;
    this.clear();
    this.shouldAutoScroll = wasAutoScroll;

    const lastAssistantIndex = this.findLastAssistantIndex(messages);

    for (let i = 0; i < messages.length; i++) {
      const message = messages[i];
      const bubble = this.createBubble(message.role, message.id);
      await this.renderMessageBody(bubble, message);

      if (actionCallbacks) {
        const isLastAssistant = i === lastAssistantIndex;
        this.attachBubbleActions(bubble, message, isLastAssistant, actionCallbacks);
      }
    }
  }

  getBubbleForMessage(messageId: string): BubbleRefs | null {
    return this.bubblesByMessageId.get(messageId) ?? null;
  }

  /**
   * Register a bubble that was created outside of `renderMessages` (e.g. by
   * finalization after the assistant message ID is known). Sets the data
   * attribute and adds to the lookup map for later adoption.
   */
  registerBubble(messageId: string, bubble: BubbleRefs): void {
    bubble.rowEl.dataset.messageId = messageId;
    this.bubblesByMessageId.set(messageId, bubble);
  }

  /**
   * Adopt bubbles that were created imperatively during the send/generate flow.
   * For each message whose bubble exists in `bubblesByMessageId` but is not yet
   * in `renderedMessageIds`, attach action toolbars. Then update tracking so
   * that subsequent `renderMessages` calls see the full picture.
   */
  adoptPendingBubbles(
    messages: ConversationMessage[],
    actionCallbacks: BubbleActionCallbacks,
  ): void {
    const renderedSet = new Set(this.renderedMessageIds);
    const lastAssistantIndex = this.findLastAssistantIndex(messages);

    for (let i = 0; i < messages.length; i++) {
      const message = messages[i];
      if (renderedSet.has(message.id)) continue;

      const bubble = this.bubblesByMessageId.get(message.id);
      if (!bubble) continue;

      const isLastAssistant = i === lastAssistantIndex;
      this.attachBubbleActions(bubble, message, isLastAssistant, actionCallbacks);
    }

    this.renderedMessageIds = messages.map((m) => m.id);
    this.scrollToBottom();
  }

  async updateBubbleVersion(
    messageId: string,
    messages: ConversationMessage[],
    callbacks: BubbleActionCallbacks
  ): Promise<void> {
    const bubble = this.bubblesByMessageId.get(messageId);
    if (!bubble) return;

    const message = messages.find((m) => m.id === messageId);
    if (!message) return;

    const lastAssistantIndex = this.findLastAssistantIndex(messages);
    const messageIndex = messages.indexOf(message);
    const isLastAssistant = messageIndex === lastAssistantIndex;

    // Scroll anchor: capture toolbar position before content swap
    const oldToolbarEl = bubble.rowEl.querySelector(
      ".lmsa-chat-window-bubble-toolbar"
    ) as HTMLElement | null;
    const anchorY = oldToolbarEl?.getBoundingClientRect().top ?? null;

    // In-place content swap
    await this.renderBubbleContent(bubble, message.content);

    // Replace toolbar, usage badge, and rag sources with updated state
    oldToolbarEl?.remove();
    bubble.rowEl.querySelector(".lmsa-chat-window-usage-badge")?.remove();
    bubble.bodyEl.querySelector(".lmsa-chat-window-rag-sources")?.remove();
    this.attachBubbleActions(bubble, message, isLastAssistant, callbacks);

    // Restore scroll anchor so version nav stays at the same screen position
    if (anchorY !== null) {
      const newToolbarEl = bubble.rowEl.querySelector(
        ".lmsa-chat-window-bubble-toolbar"
      ) as HTMLElement | null;
      if (newToolbarEl) {
        const delta = newToolbarEl.getBoundingClientRect().top - anchorY;
        this.refs.messagesEl.scrollTop += delta;
      }
    }
  }

  createBubble(role: "user" | "assistant", messageId?: string): BubbleRefs {
    const rowEl = this.refs.messagesEl.createDiv({
      cls: `lmsa-chat-window-message lmsa-chat-window-message--${role}`,
    });
    if (messageId) {
      rowEl.dataset.messageId = messageId;
    }

    const avatarEl = rowEl.createDiv({ cls: "lmsa-chat-window-message-avatar" });
    setIcon(avatarEl, role === "user" ? "user-round" : "bot");

    const columnEl = rowEl.createDiv({ cls: "lmsa-chat-window-message-column" });
    const chromeEl = columnEl.createDiv({ cls: "lmsa-chat-window-message-chrome" });
    chromeEl.createDiv({
      cls: "lmsa-chat-window-message-role",
      text: role === "user" ? "You" : "Assistant",
    });

    const timelineEl = columnEl.createDiv({ cls: "lmsa-chat-window-message-timeline" });
    const bodyEl = columnEl.createDiv({ cls: "lmsa-chat-window-message-body lmsa-ui-card" });
    const contentEl = bodyEl.createDiv({ cls: "lmsa-chat-window-message-content" });

    const refs: BubbleRefs = { role, rowEl, columnEl, chromeEl, timelineEl, bodyEl, contentEl };

    if (messageId) {
      this.bubblesByMessageId.set(messageId, refs);
    }

    this.scrollToBottom();
    return refs;
  }

  setEmptyStateVisible(isVisible: boolean): void {
    this.refs.emptyStateEl.toggleClass("lmsa-empty-view--hidden", !isVisible);
  }

  scrollToBottom(force = false): void {
    if (force || this.shouldAutoScroll) {
      this.refs.messagesEl.scrollTop = this.refs.messagesEl.scrollHeight;
      this.shouldAutoScroll = true;
    }
    this.updateScrollToBottomButton();
  }

  clear(): void {
    this.markdownRenderer.clearAll();
    this.bubblesByMessageId.clear();
    this.renderedMessageIds = [];
    this.refs.messagesEl.empty();
    this.shouldAutoScroll = true;
    this.updateScrollToBottomButton();
  }

  destroy(): void {
    this.markdownRenderer.clearAll();
  }

  renderPlainTextContent(bubble: BubbleRefs, text: string): void {
    this.markdownRenderer.clear(bubble.contentEl);
    bubble.contentEl.empty();
    bubble.contentEl.removeClass("lmsa-chat-window-message-content--markdown");
    bubble.contentEl.addClass("lmsa-chat-window-message-content--plain");
    bubble.contentEl.setText(text);
  }

  async renderBubbleContent(
    bubble: BubbleRefs,
    text: string,
    options: BubbleRenderOptions = {}
  ): Promise<void> {
    bubble.bodyEl.removeClass("is-error", "is-muted");
    if (!options.preserveStreaming) {
      bubble.bodyEl.removeClass("is-streaming");
    }

    if (options.attachments?.length) {
      const markdownHostEl = this.prepareBubbleContentWithAttachments(bubble, options.attachments);
      if (!text) return;

      try {
        await this.markdownRenderer.render(markdownHostEl, text);
      } catch {
        this.prepareBubbleContentWithAttachments(bubble, options.attachments).setText(text);
      }
      return;
    }

    bubble.contentEl.removeClass("lmsa-chat-window-message-content--plain");
    bubble.contentEl.addClass("lmsa-chat-window-message-content--markdown");

    try {
      await this.markdownRenderer.render(bubble.contentEl, text);
    } catch {
      this.renderPlainTextContent(bubble, text);
    }
  }

  private renderAttachmentGallery(containerEl: HTMLElement, attachments: Attachment[]): void {
    // Note snapshots embed their own images, so don't double-render those in the
    // gallery, only directly attached images get thumbnails.
    const galleryAttachments = attachments.filter(
      (a) => a.type === "note" || (a.type === "image" && !a.sourceNotePath),
    );
    if (galleryAttachments.length === 0) return;

    const galleryEl = containerEl.createDiv({ cls: "lmsa-chat-window-attachment-gallery" });
    for (const attachment of galleryAttachments) {
      if (attachment.type === "image") {
        const imageSrc = `data:${attachment.mimeType};base64,${attachment.data}`;
        const imageAlt = attachment.fileName ?? "Image attachment";
        const thumbEl = galleryEl.createEl("button", {
          cls: "lmsa-chat-window-attachment-thumb",
          attr: {
            type: "button",
            "aria-label": `Open ${imageAlt}`,
          },
        });
        thumbEl.createEl("img", {
          cls: "lmsa-chat-window-attachment-img",
          attr: {
            src: imageSrc,
            alt: imageAlt,
          },
        });

        thumbEl.addEventListener("click", () => {
          new ImagePreviewModal(this.app, imageSrc, imageAlt).open();
        });
      } else if (attachment.type === "note") {
        const chipEl = galleryEl.createDiv({ cls: "lmsa-chat-window-attachment-note" });
        setIcon(chipEl.createEl("span", { cls: "lmsa-chat-window-attachment-note-icon" }), "file-text");
        chipEl.createEl("span", {
          cls: "lmsa-chat-window-attachment-note-label",
          text: attachment.truncated ? `${attachment.fileName} · truncated` : attachment.fileName,
        });
      }
    }
  }

  private prepareBubbleContentWithAttachments(
    bubble: BubbleRefs,
    attachments: Attachment[]
  ): HTMLElement {
    this.markdownRenderer.clear(bubble.contentEl);
    bubble.contentEl.empty();
    bubble.contentEl.removeClass("lmsa-chat-window-message-content--plain");
    bubble.contentEl.addClass("lmsa-chat-window-message-content--markdown");
    this.renderAttachmentGallery(bubble.contentEl, attachments);
    return bubble.contentEl.createDiv({ cls: "lmsa-chat-window-message-markdown-host" });
  }

  private isNearBottom(): boolean {
    const distanceFromBottom =
      this.refs.messagesEl.scrollHeight -
      this.refs.messagesEl.scrollTop -
      this.refs.messagesEl.clientHeight;

    return distanceFromBottom <= AUTO_SCROLL_BOTTOM_THRESHOLD_PX;
  }
  private findLastAssistantIndex(messages: ConversationMessage[]): number {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "assistant") return i;
    }
    return -1;
  }

  private attachBubbleActions(
    bubble: BubbleRefs,
    message: ConversationMessage,
    isLastAssistant: boolean,
    callbacks: BubbleActionCallbacks
  ): void {
    // Usage badge, shown below assistant bubbles before the toolbar.
    if (message.role === "assistant") {
      renderUsageBadge(bubble.rowEl, message.usage, message.modelId, message.provider);
      if (message.ragSources?.length) {
        renderRagSources(bubble.bodyEl, message.ragSources, this.app, message.rewrittenQuery);
      }
    }

    const toolbarEl = bubble.rowEl.createDiv({ cls: "lmsa-chat-window-bubble-toolbar" });

    if (message.role === "assistant" && message.versions && message.versions.length > 1) {
      BubbleVersionNav.render(toolbarEl, message, callbacks.onVersionChange);
    }

    BubbleActionToolbar.render(toolbarEl, message, {
      isLastAssistant,
      callbacks,
    });
  }
}
