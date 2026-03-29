import type LMStudioWritingAssistant from "../main";
import type { EmbeddingModel } from "../shared/types";
import type { LMStudioModelDigest } from "../api/types";
import { EmbeddingModelModal } from "./modals";
import { renderModelProfileTab } from "./ModelProfileTab";

function formatEmbeddingSummary(model: LMStudioModelDigest): string {
  if (model.summary) return model.summary;
  return model.isLoaded
    ? "Loaded in LM Studio and ready for embedding requests."
    : "Available in LM Studio.";
}

export function renderEmbeddingModelsTab(
  container: HTMLElement,
  plugin: LMStudioWritingAssistant,
  refresh: () => void
): void {
  const { settings } = plugin;

  renderModelProfileTab<EmbeddingModel>(container, plugin, refresh, {
    kind: "embedding",
    profileNoun: "embedding profile",
    sectionDescription:
      "Reusable embedding profiles for semantic search, retrieval, and future note-aware features.",
    sectionIcon: "database",
    discoverySectionDescription:
      "Load live embedding model suggestions from LM Studio when you want to create or update an embedding profile.",
    discoverySectionIcon: "search",
    emptyProfilesText: "No embedding models configured.",
    emptyDiscoveryText:
      "No live model data loaded yet. Use Refresh models to fetch suggestions from LM Studio.",
    noModelsFoundText:
      "LM Studio responded, but no embedding-ready models were reported.",
    getModels: () => settings.embeddingModels,
    setModels: (m) => { settings.embeddingModels = m; },
    formatDiscoveryMeta: formatEmbeddingSummary,
    openModal: (app, p, source, onSave, prefill) => {
      new EmbeddingModelModal(app, p, source, onSave, prefill).open();
    },
    getCandidates: (service, opts) => service.getEmbeddingCandidates(opts),
  });
}
