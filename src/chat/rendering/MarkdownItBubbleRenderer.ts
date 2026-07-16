import { Notice, type App } from "obsidian";
import type { MarkdownBubbleRenderer } from "./MarkdownBubbleRenderer";
import { renderMessageMarkdownToHtml } from "./messageMarkdown";

const EXTERNAL_HREF_RE = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;

export class MarkdownItBubbleRenderer implements MarkdownBubbleRenderer {
  constructor(private readonly app: App) {}

  // Synchronous, but returns Promise<void> to satisfy the MarkdownBubbleRenderer contract
  // (the Obsidian-backed sibling implementation genuinely awaits). No `async`, so require-await
  // is satisfied without an empty await.
  render(contentEl: HTMLElement, text: string): Promise<void> {
    // markdown-it runs with html disabled and all token content escaped, but the
    // string is still adopted through an inert DOMParser document rather than
    // assigned via innerHTML so no markup is ever parsed in the live document.
    const doc = new DOMParser().parseFromString(
      renderMessageMarkdownToHtml(text),
      "text/html"
    );
    contentEl.empty();
    contentEl.append(...Array.from(doc.body.childNodes));
    this.attachCopyHandlers(contentEl);
    this.attachLinkHandlers(contentEl);
    return Promise.resolve();
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
        if (!vaultHref) {
          // External links are intentionally never opened: AI-generated URLs
          // have no provenance, so the safe behavior is a brief explanation.
          if (EXTERNAL_HREF_RE.test(rawHref.trim())) {
            new Notice("External links in chat responses are disabled for safety.");
          }
          return;
        }

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
    if (EXTERNAL_HREF_RE.test(href)) return null;

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
