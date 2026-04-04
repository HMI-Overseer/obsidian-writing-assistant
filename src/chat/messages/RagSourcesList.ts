import type { App } from "obsidian";
import type { RagSourceRef } from "../../shared/types";

function formatScore(score: number): string {
  return `${Math.round(score * 100)}%`;
}

function formatSourceLabel(source: RagSourceRef): string {
  const file = source.filePath.replace(/\.md$/, "");
  return source.headingPath ? `${file} > ${source.headingPath}` : file;
}

function positionTooltip(linkEl: HTMLElement, tooltipEl: HTMLElement): void {
  const scrollParent = linkEl.closest(".lmsa-messages");
  if (!scrollParent) return;

  const containerRect = scrollParent.getBoundingClientRect();
  const linkRect = linkEl.getBoundingClientRect();
  const tooltipHeight = tooltipEl.offsetHeight;
  const tooltipWidth = tooltipEl.offsetWidth;

  // Flip above if not enough space below within the scroll container
  const spaceBelow = containerRect.bottom - linkRect.bottom;
  const spaceAbove = linkRect.top - containerRect.top;
  const top = spaceBelow >= tooltipHeight || spaceBelow >= spaceAbove
    ? linkRect.bottom
    : linkRect.top - tooltipHeight;

  // Clamp horizontal position within the container
  const left = Math.min(linkRect.left, containerRect.right - tooltipWidth);

  tooltipEl.setCssProps({
    "--tooltip-top": `${top}px`,
    "--tooltip-left": `${Math.max(containerRect.left, left)}px`,
  });
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
      const heading = source.headingPath?.split(" > ").pop();
      const linkPath = heading ? `${source.filePath}#${heading}` : source.filePath;
      void app.workspace.openLinkText(linkPath, "");
    });

    rowEl.createSpan({
      cls: "lmsa-rag-source-score",
      text: formatScore(source.score),
    });

    if (source.content) {
      const tooltipEl = linkEl.createDiv({
        cls: "lmsa-rag-source-tooltip",
        text: source.content,
      });

      linkEl.addEventListener("mouseenter", () => {
        tooltipEl.classList.add("is-visible");
        positionTooltip(linkEl, tooltipEl);
      });
      linkEl.addEventListener("mouseleave", () => {
        tooltipEl.classList.remove("is-visible");
      });
    }
  }

  return detailsEl;
}
