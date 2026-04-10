import { type App, Component, MarkdownRenderer, setIcon } from "obsidian";
import type { ConversationMessage } from "../../shared/types";
import type { BubbleRefs, BubbleRenderOptions, ChatLayoutRefs } from "../types";
import { BubbleActionToolbar } from "./BubbleActionToolbar";
import { BubbleVersionNav } from "./BubbleVersionNav";
import { renderUsageBadge } from "./UsageBadge";
import { renderRagSources } from "./RagSourcesList";
import { AgenticTimeline } from "./AgenticTimeline";

export type BubbleActionCallbacks = {
  onCopy: (messageId: string) => void;
  onEdit: (messageId: string) => void;
  onDelete: (messageId: string) => void;
  onBranch: (messageId: string) => void;
  onRegenerate: (messageId: string) => void;
  onVersionChange: (messageId: string, newIndex: number) => void;
};

const AUTO_SCROLL_BOTTOM_THRESHOLD_PX = 10;

export class ChatTranscript {
  private bubbleRenderChildren = new Map<HTMLElement, Component>();
  private bubblesByMessageId = new Map<string, BubbleRefs>();
  private shouldAutoScroll = true;

  constructor(
    private readonly owner: Component,
    private readonly app: App,
    private readonly refs: Pick<ChatLayoutRefs, "messagesEl" | "emptyStateEl">
  ) {
    this.owner.registerDomEvent(this.refs.messagesEl, "scroll", () => {
      this.shouldAutoScroll = this.isNearBottom();
    });
  }

  async renderMessages(
    messages: ConversationMessage[],
    actionCallbacks?: BubbleActionCallbacks,
    forceScroll = true
  ): Promise<void> {
    const wasAutoScroll = this.shouldAutoScroll;
    this.clear();
    this.shouldAutoScroll = wasAutoScroll;

    const lastAssistantIndex = this.findLastAssistantIndex(messages);

    for (let i = 0; i < messages.length; i++) {
      const message = messages[i];
      const bubble = this.createBubble(message.role, message.id);

      if (message.role === "assistant" && message.agenticSteps?.length) {
        AgenticTimeline.render(bubble.timelineEl, message.agenticSteps);
      }

      if (message.isError) {
        bubble.bodyEl.addClass("is-error");
        this.renderPlainTextContent(bubble, message.content);
      } else {
        await this.renderBubbleContent(bubble, message.content);
      }

      this.bubblesByMessageId.set(message.id, bubble);

      if (actionCallbacks) {
        const isLastAssistant = i === lastAssistantIndex;
        this.attachBubbleActions(bubble, message, isLastAssistant, actionCallbacks);
      }
    }

    this.scrollToBottom(forceScroll);
  }

  getBubbleForMessage(messageId: string): BubbleRefs | null {
    return this.bubblesByMessageId.get(messageId) ?? null;
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

    this.scrollToBottom();
    return { role, rowEl, columnEl, chromeEl, timelineEl, bodyEl, contentEl };
  }

  setEmptyStateVisible(isVisible: boolean): void {
    this.refs.emptyStateEl.toggleClass("lmsa-empty-view--hidden", !isVisible);
  }

  scrollToBottom(force = false): void {
    if (!force && !this.shouldAutoScroll) return;

    this.refs.messagesEl.scrollTop = this.refs.messagesEl.scrollHeight;
    this.shouldAutoScroll = true;
  }

  clear(): void {
    this.clearAllBubbleMarkdownRenders();
    this.bubblesByMessageId.clear();
    this.refs.messagesEl.empty();
    this.shouldAutoScroll = true;
  }

  destroy(): void {
    this.clearAllBubbleMarkdownRenders();
  }

  renderPlainTextContent(bubble: BubbleRefs, text: string): void {
    this.clearBubbleMarkdownRender(bubble.contentEl);
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

    if (bubble.role === "assistant") {
      await this.renderAssistantMarkdown(bubble, text, options);
      return;
    }

    this.renderPlainTextContent(bubble, text);
  }

  private isNearBottom(): boolean {
    const distanceFromBottom =
      this.refs.messagesEl.scrollHeight -
      this.refs.messagesEl.scrollTop -
      this.refs.messagesEl.clientHeight;

    return distanceFromBottom <= AUTO_SCROLL_BOTTOM_THRESHOLD_PX;
  }

  private clearBubbleMarkdownRender(contentEl: HTMLElement): void {
    const child = this.bubbleRenderChildren.get(contentEl);
    if (!child) return;

    this.owner.removeChild(child);
    this.bubbleRenderChildren.delete(contentEl);
  }

  private clearAllBubbleMarkdownRenders(): void {
    for (const child of this.bubbleRenderChildren.values()) {
      this.owner.removeChild(child);
    }

    this.bubbleRenderChildren.clear();
  }

  private getMarkdownSourcePath(): string {
    return this.app.workspace.getActiveFile()?.path ?? "";
  }

  private async renderAssistantMarkdown(
    bubble: BubbleRefs,
    text: string,
    options: BubbleRenderOptions = {}
  ): Promise<void> {
    const renderVersion = Number(bubble.contentEl.dataset.lmsaRenderVersion ?? "0") + 1;
    bubble.contentEl.dataset.lmsaRenderVersion = String(renderVersion);

    this.clearBubbleMarkdownRender(bubble.contentEl);
    bubble.bodyEl.removeClass("is-error", "is-muted");
    if (!options.preserveStreaming) {
      bubble.bodyEl.removeClass("is-streaming");
    }
    bubble.contentEl.empty();
    bubble.contentEl.removeClass("lmsa-chat-window-message-content--plain");
    bubble.contentEl.addClass("lmsa-chat-window-message-content--markdown");

    const renderChild = new Component();
    this.owner.addChild(renderChild);
    this.bubbleRenderChildren.set(bubble.contentEl, renderChild);

    try {
      await MarkdownRenderer.render(
        this.app,
        text,
        bubble.contentEl,
        this.getMarkdownSourcePath(),
        renderChild
      );
    } catch {
      if (this.bubbleRenderChildren.get(bubble.contentEl) === renderChild) {
        this.bubbleRenderChildren.delete(bubble.contentEl);
      }
      this.owner.removeChild(renderChild);
      this.renderPlainTextContent(bubble, text);
      return;
    }

    const isCurrentRender =
      this.bubbleRenderChildren.get(bubble.contentEl) === renderChild &&
      bubble.contentEl.dataset.lmsaRenderVersion === String(renderVersion) &&
      bubble.contentEl.isConnected;

    if (!isCurrentRender) {
      if (this.bubbleRenderChildren.get(bubble.contentEl) === renderChild) {
        this.bubbleRenderChildren.delete(bubble.contentEl);
      }
      this.owner.removeChild(renderChild);
    }
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
    // Usage badge — shown below assistant bubbles before the toolbar.
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
