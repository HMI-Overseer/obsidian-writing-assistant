import { Notice, type App } from "obsidian";
import type { MarkdownBubbleRenderer } from "./MarkdownBubbleRenderer";
import { renderMessageMarkdownToHtml } from "./messageMarkdown";

export class MarkdownItBubbleRenderer implements MarkdownBubbleRenderer {
  constructor(private readonly app: App) {}

  async render(contentEl: HTMLElement, text: string): Promise<void> {
    contentEl.empty();
    contentEl.innerHTML = renderMessageMarkdownToHtml(text);
    this.attachCopyHandlers(contentEl);
    this.attachLinkHandlers(contentEl);
  }

  clear(_containerEl: HTMLElement): void {}

  clearAll(): void {}

  private attachLinkHandlers(contentEl: HTMLElement): void {
    const links = Array.from(contentEl.querySelectorAll<HTMLAnchorElement>("a[href]"));
    for (const link of links) {
      link.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();

        const rawHref = link.dataset.lmsaLinkHref ?? link.getAttribute("href") ?? "";
        const vaultHref = this.resolveVaultHref(rawHref);
        if (!vaultHref) return;

        void this.app.workspace.openLinkText(vaultHref, this.getSourcePath()).catch(() => {
          new Notice(`Could not open file reference: ${vaultHref}`);
        });
      });
    }
  }

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

  private resolveVaultHref(rawHref: string): string | null {
    const href = rawHref.trim();
    if (!href || href.startsWith("#")) return null;
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(href)) return null;

    const sourcePath = this.getSourcePath();
    const decodedHref = this.safeDecodeUri(href);
    const candidates = new Set([
      href,
      href.replace(/^\/+/, ""),
      decodedHref,
      decodedHref.replace(/^\/+/, ""),
    ]);

    for (const candidate of candidates) {
      const linkPath = candidate.trim();
      if (!linkPath) continue;

      const pathOnly = linkPath.split("#", 1)[0];
      if (!pathOnly) continue;

      if (this.app.metadataCache.getFirstLinkpathDest(pathOnly, sourcePath)) {
        return linkPath;
      }
    }

    return null;
  }

  private getSourcePath(): string {
    return this.app.workspace.getActiveFile()?.path ?? "";
  }

  private safeDecodeUri(value: string): string {
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }
}
