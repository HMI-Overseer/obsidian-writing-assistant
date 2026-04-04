import type { App } from "obsidian";
import type { RagSourceRef } from "../../shared/types";

function formatScore(score: number): string {
  return `${Math.round(score * 100)}%`;
}

function formatSourceLabel(source: RagSourceRef): string {
  const file = source.filePath.replace(/\.md$/, "");
  return source.headingPath ? `${file} > ${source.headingPath}` : file;
}

export function renderRagSources(
  parentEl: HTMLElement,
  sources: RagSourceRef[],
  app: App
): HTMLElement | null {
  if (sources.length === 0) return null;

  const detailsEl = parentEl.createEl("details", { cls: "lmsa-rag-sources" });
  detailsEl.createEl("summary", {
    cls: "lmsa-rag-sources-summary",
    text: `${sources.length} vault source${sources.length === 1 ? "" : "s"}`,
  });

  const listEl = detailsEl.createDiv({ cls: "lmsa-rag-sources-list" });

  for (const source of sources) {
    const rowEl = listEl.createDiv({ cls: "lmsa-rag-source-row" });

    const linkEl = rowEl.createEl("a", {
      cls: "lmsa-rag-source-link",
      text: formatSourceLabel(source),
    });
    linkEl.addEventListener("click", (e) => {
      e.preventDefault();
      void app.workspace.openLinkText(source.filePath, "");
    });

    rowEl.createSpan({
      cls: "lmsa-rag-source-score",
      text: formatScore(source.score),
    });

    if (source.content) {
      linkEl.createDiv({
        cls: "lmsa-rag-source-tooltip",
        text: source.content,
      });
    }
  }

  return detailsEl;
}
