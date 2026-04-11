import type { ModelDigest } from "../api/types";
import type WritingAssistantChat from "../main";
import type { EmbeddingModel } from "../shared/types";
import { EmbeddingModelModal } from "./modals";
import { renderModelProfileTab } from "./ModelProfileTab";

function formatEmbeddingSummary(model: ModelDigest): string {
  if (model.summary) return model.summary;
  return model.isLoaded
    ? "Loaded and ready for embedding requests."
    : "Available for embedding requests.";
}

export function renderEmbeddingModelsTab(
  container: HTMLElement,
  plugin: WritingAssistantChat
): void {
  const { settings } = plugin;

  renderModelProfileTab<EmbeddingModel>(container, plugin, {
    kind: "embedding",
    profileNoun: "embedding profile",
    sectionDescription:
      "Reusable embedding profiles for semantic search, retrieval, and future note-aware features.",
    sectionIcon: "database",
    addSectionDescription:
      "Create a new embedding profile by selecting a provider and discovering available models.",
    addSectionIcon: "plus-circle",
    emptyProfilesText: "No embedding models configured.",
    emptyDiscoveryText:
      "No live model data loaded yet. Use Refresh models to discover available models.",
    noModelsFoundText:
      "The provider responded, but no embedding-ready models were reported.",
    getModels: () => settings.embeddingModels,
    setModels: (m) => { settings.embeddingModels = m; },
    formatDiscoveryMeta: formatEmbeddingSummary,
    openModal: (app, p, source, onSave, prefill) => {
      new EmbeddingModelModal(app, p, source, onSave, prefill).open();
    },
    fetchCandidates: {
      lmstudio: (opts) => plugin.modelAvailability.discoverEmbeddingCandidates(opts),
      // Anthropic has no embedding models — omitted so UI shows the "not available" message
    },
  });
}
