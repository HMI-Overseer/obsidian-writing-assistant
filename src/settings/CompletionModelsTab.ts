import type { ModelDigest } from "../api/types";
import type LMStudioWritingAssistant from "../main";
import type { CompletionModel } from "../shared/types";
import { CompletionModelModal } from "./modals";
import { renderModelProfileTab } from "./ModelProfileTab";

function formatContextLength(value?: number): string {
  if (!value || value <= 0) return "Context window unavailable";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value % 1_000_000 === 0 ? 0 : 1)}M max context tokens`;
  if (value >= 1_000) return `${Math.round(value / 1_000).toLocaleString()}K max context tokens`;
  return `${value.toLocaleString()} max context tokens`;
}

function formatDiscoveryMeta(model: ModelDigest): string {
  if (model.summary) return model.summary;

  if (model.provider === "lmstudio") {
    if (model.activeContextLength && model.activeContextLength > 0) {
      return `${model.activeContextLength.toLocaleString()} tokens active`;
    }
    return formatContextLength(model.maxContextLength);
  }

  return formatContextLength(model.maxContextLength);
}

export function renderCompletionModelsTab(
  container: HTMLElement,
  plugin: LMStudioWritingAssistant,
  refresh: () => void
): void {
  const { settings } = plugin;

  renderModelProfileTab<CompletionModel>(container, plugin, refresh, {
    kind: "completion",
    profileNoun: "completion profile",
    sectionDescription:
      "Reusable chat profiles that target a specific model.",
    sectionIcon: "cpu",
    addSectionDescription:
      "Create a new completion profile by selecting a provider and discovering available models.",
    addSectionIcon: "plus-circle",
    emptyProfilesText: "No completion profiles configured yet.",
    emptyDiscoveryText:
      "No live model data loaded yet. Use Refresh models to discover available models.",
    noModelsFoundText:
      "The provider responded, but no completion-ready models were reported.",
    getModels: () => settings.completionModels,
    setModels: (m) => { settings.completionModels = m; },
    renderItemMeta: undefined,
    formatDiscoveryMeta,
    openModal: (app, p, source, onSave, prefill) => {
      new CompletionModelModal(app, p, source, onSave, prefill).open();
    },
    fetchCandidates: {
      lmstudio: (opts) => plugin.modelAvailability.discoverCompletionCandidates("lmstudio", opts),
      anthropic: (opts) => plugin.modelAvailability.discoverCompletionCandidates("anthropic", opts),
    },
  });
}
