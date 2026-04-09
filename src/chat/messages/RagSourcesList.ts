import type { App } from "obsidian";
import type { RagSourceRef } from "../../shared/types";

const ENTITY_TYPES = ["character", "location", "object", "concept", "event"] as const;

function renderGraphContext(containerEl: HTMLElement, sources: RagSourceRef[]): void {
  // Deduplicate entities and relationships across all annotated sources.
  const entityMap = new Map<string, { name: string; type: string; description: string }>();
  const relSet = new Set<string>();
  const relationships: { source: string; target: string; type: string }[] = [];

  for (const source of sources) {
    if (!source.graphContext) continue;
    for (const e of source.graphContext.entities) {
      if (!entityMap.has(e.name.toLowerCase())) entityMap.set(e.name.toLowerCase(), e);
    }
    for (const r of source.graphContext.relationships) {
      const key = `${r.source}|${r.target}|${r.type}`;
      if (!relSet.has(key)) {
        relSet.add(key);
        relationships.push(r);
      }
    }
  }

  if (entityMap.size === 0 && relationships.length === 0) return;

  const parts: string[] = [];
  if (entityMap.size > 0) parts.push(`${entityMap.size} ${entityMap.size === 1 ? "entity" : "entities"}`);
  if (relationships.length > 0) parts.push(`${relationships.length} ${relationships.length === 1 ? "relationship" : "relationships"}`);

  const sectionEl = containerEl.createEl("details", { cls: "lmsa-chat-window-graph-context" });
  sectionEl.createEl("summary", { cls: "lmsa-chat-window-graph-context-summary", text: `Graph: ${parts.join(", ")}` });

  if (entityMap.size > 0) {
    const pillsEl = sectionEl.createDiv({ cls: "lmsa-chat-window-graph-entity-pills" });
    for (const e of entityMap.values()) {
      const typeClass = ENTITY_TYPES.includes(e.type as (typeof ENTITY_TYPES)[number])
        ? `lmsa-chat-window-graph-entity-type--${e.type}`
        : "lmsa-chat-window-graph-entity-type--concept";
      const pill = pillsEl.createDiv({ cls: "lmsa-chat-window-graph-entity-pill" });
      pill.createSpan({ cls: `lmsa-chat-window-graph-entity-type ${typeClass}`, text: e.type });
      pill.createSpan({ cls: "lmsa-chat-window-graph-entity-name", text: e.name });
      if (e.description) pill.setAttr("title", e.description);
    }
  }

  if (relationships.length > 0) {
    const relsEl = sectionEl.createDiv({ cls: "lmsa-chat-window-graph-relations" });
    for (const r of relationships) {
      relsEl.createDiv({ cls: "lmsa-chat-window-graph-relation", text: `${r.source} → ${r.type} → ${r.target}` });
    }
  }
}

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
  app: App,
  rewrittenQuery?: string
): HTMLElement | null {
  if (sources.length === 0) return null;

  const detailsEl = parentEl.createEl("details", { cls: "lmsa-chat-window-rag-sources" });
  detailsEl.createEl("summary", {
    cls: "lmsa-chat-window-rag-sources-summary",
    text: `${sources.length} vault source${sources.length === 1 ? "" : "s"}`,
  });

  const listEl = detailsEl.createDiv({ cls: "lmsa-chat-window-rag-sources-list" });

  if (rewrittenQuery) {
    listEl.createDiv({
      cls: "lmsa-chat-window-rag-rewritten-query",
      text: `Retrieved as: "${rewrittenQuery}"`,
    });
  }

  for (const source of sources) {
    const rowEl = listEl.createDiv({ cls: "lmsa-chat-window-rag-source-row" });

    const linkEl = rowEl.createEl("a", {
      cls: "lmsa-chat-window-rag-source-link",
      text: formatSourceLabel(source),
    });
    linkEl.addEventListener("click", (e) => {
      e.preventDefault();
      const heading = source.headingPath?.split(" > ").pop();
      const linkPath = heading ? `${source.filePath}#${heading}` : source.filePath;
      void app.workspace.openLinkText(linkPath, "");
    });

    rowEl.createSpan({
      cls: "lmsa-chat-window-rag-source-score",
      text: formatScore(source.score),
    });


  }

  renderGraphContext(detailsEl, sources);
  return detailsEl;
}
