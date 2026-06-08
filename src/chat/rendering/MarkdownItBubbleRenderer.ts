import type { MarkdownBubbleRenderer } from "./MarkdownBubbleRenderer";
import { renderMessageMarkdownToHtml } from "./messageMarkdown";

export class MarkdownItBubbleRenderer implements MarkdownBubbleRenderer {
  async render(contentEl: HTMLElement, text: string): Promise<void> {
    contentEl.empty();
    contentEl.innerHTML = renderMessageMarkdownToHtml(text);
    this.attachCopyHandlers(contentEl);
  }

  clear(_containerEl: HTMLElement): void {}

  clearAll(): void {}

  private attachCopyHandlers(contentEl: HTMLElement): void {
    const copyButtons = Array.from(
      contentEl.querySelectorAll<HTMLButtonElement>(".lmsa-md-codeblock-copy")
    );
    for (const button of copyButtons) {
      button.addEventListener("click", () => {
        const codeEl = button
          .closest(".lmsa-md-codeblock")
          ?.querySelector("code");
        const codeText = codeEl?.textContent ?? "";
        if (!codeText) return;

        void navigator.clipboard.writeText(codeText).then(() => {
          const originalLabel = button.textContent;
          button.textContent = "Copied";
          window.setTimeout(() => {
            button.textContent = originalLabel;
          }, 1200);
        }).catch(() => undefined);
      });
    }
  }
}
