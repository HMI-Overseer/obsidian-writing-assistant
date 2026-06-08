import { type App, Component, MarkdownRenderer } from "obsidian";
import type { MarkdownBubbleRenderer } from "./MarkdownBubbleRenderer";

export class ObsidianMarkdownBubbleRenderer implements MarkdownBubbleRenderer {
  private readonly bubbleRenderChildren = new Map<HTMLElement, Component>();

  constructor(
    private readonly owner: Component,
    private readonly app: App,
    private readonly getSourcePath: () => string
  ) {}

  async render(contentEl: HTMLElement, text: string): Promise<void> {
    const renderVersion = Number(contentEl.dataset.lmsaRenderVersion ?? "0") + 1;
    contentEl.dataset.lmsaRenderVersion = String(renderVersion);

    this.clear(contentEl);
    contentEl.empty();

    const renderChild = new Component();
    this.owner.addChild(renderChild);
    this.bubbleRenderChildren.set(contentEl, renderChild);

    try {
      await MarkdownRenderer.render(
        this.app,
        text,
        contentEl,
        this.getSourcePath(),
        renderChild
      );
    } catch (error) {
      if (this.bubbleRenderChildren.get(contentEl) === renderChild) {
        this.bubbleRenderChildren.delete(contentEl);
      }
      this.owner.removeChild(renderChild);
      throw error instanceof Error
        ? error
        : new Error("Assistant bubble markdown render failed.");
    }

    const isCurrentRender =
      this.bubbleRenderChildren.get(contentEl) === renderChild &&
      contentEl.dataset.lmsaRenderVersion === String(renderVersion) &&
      contentEl.isConnected;

    if (!isCurrentRender) {
      if (this.bubbleRenderChildren.get(contentEl) === renderChild) {
        this.bubbleRenderChildren.delete(contentEl);
      }
      this.owner.removeChild(renderChild);
    }
  }

  clear(containerEl: HTMLElement): void {
    for (const [contentEl, child] of this.bubbleRenderChildren.entries()) {
      if (contentEl !== containerEl && !containerEl.contains(contentEl)) continue;
      this.owner.removeChild(child);
      this.bubbleRenderChildren.delete(contentEl);
    }
  }

  clearAll(): void {
    for (const child of this.bubbleRenderChildren.values()) {
      this.owner.removeChild(child);
    }

    this.bubbleRenderChildren.clear();
  }
}
