import { type App, Component, MarkdownRenderer, setIcon } from "obsidian";
import type { ConversationMessage } from "../../shared/types";
import type { BubbleRefs, BubbleRenderOptions, ChatLayoutRefs } from "../types";
import { BubbleActionToolbar } from "./BubbleActionToolbar";
import { BubbleVersionNav } from "./BubbleVersionNav";

export type BubbleActionCallbacks = {
  onCopy: (messageId: string) => void;
  onEdit: (messageId: string) => void;
  onDelete: (messageId: string) => void;
  onBranch: (messageId: string) => void;
  onRegenerate: (messageId: string) => void;
  onVersionChange: (messageId: string, newIndex: number) => void;
};

const AUTO_SCROLL_BOTTOM_THRESHOLD_PX = 48;

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
    this.clear();

    const lastAssistantIndex = this.findLastAssistantIndex(messages);

    for (let i = 0; i < messages.length; i++) {
      const message = messages[i];
      const bubble = this.createBubble(message.role, message.id);
      await this.renderBubbleContent(bubble, message.content);
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

  createBubble(role: "user" | "assistant", messageId?: string): BubbleRefs {
    const rowEl = this.refs.messagesEl.createDiv({
      cls: `lmsa-message lmsa-message--${role}`,
    });
    if (messageId) {
      rowEl.dataset.messageId = messageId;
    }

    const avatarEl = rowEl.createDiv({ cls: "lmsa-message-avatar" });
    setIcon(avatarEl, role === "user" ? "user-round" : "bot");

    const columnEl = rowEl.createDiv({ cls: "lmsa-message-column" });
    const chromeEl = columnEl.createDiv({ cls: "lmsa-message-chrome" });
    chromeEl.createDiv({
      cls: "lmsa-message-role",
      text: role === "user" ? "You" : "Assistant",
    });

    const bodyEl = columnEl.createDiv({ cls: "lmsa-message-body lmsa-ui-card" });
    const contentEl = bodyEl.createDiv({ cls: "lmsa-message-content" });

    this.scrollToBottom();
    return { role, rowEl, columnEl, chromeEl, bodyEl, contentEl };
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
  }

  destroy(): void {
    this.clearAllBubbleMarkdownRenders();
  }

  renderPlainTextContent(bubble: BubbleRefs, text: string): void {
    this.clearBubbleMarkdownRender(bubble.contentEl);
    bubble.contentEl.empty();
    bubble.contentEl.removeClass("lmsa-message-content--markdown");
    bubble.contentEl.addClass("lmsa-message-content--plain");
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
    bubble.contentEl.removeClass("lmsa-message-content--plain");
    bubble.contentEl.addClass("lmsa-message-content--markdown");

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
    const toolbarEl = bubble.columnEl.createDiv({ cls: "lmsa-bubble-toolbar" });

    if (message.role === "assistant" && message.versions && message.versions.length > 1) {
      BubbleVersionNav.render(toolbarEl, message, callbacks.onVersionChange);
    }

    BubbleActionToolbar.render(toolbarEl, message, {
      isLastAssistant,
      callbacks,
    });
  }
}
