export interface MarkdownBubbleRenderer {
  render(contentEl: HTMLElement, text: string): Promise<void>;
  clear(containerEl: HTMLElement): void;
  clearAll(): void;
}
