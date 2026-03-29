import type LMStudioWritingAssistant from "../main";
import type { CompletionModel } from "../shared/types";
import type { LMStudioModelDigest } from "../api/types";
import { CompletionModelModal } from "./modals";
import { renderModelProfileTab } from "./ModelProfileTab";

function formatContextLength(value?: number): string {
  if (!value || value <= 0) return "Context window unavailable";
  return `${value.toLocaleString()} max context tokens`;
}

function formatDiscoveryContext(model: LMStudioModelDigest): string {
  if (model.activeContextLength && model.activeContextLength > 0) {
    return `${model.activeContextLength.toLocaleString()} tokens active`;
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
      "No live model data loaded yet. Use Refresh models to fetch suggestions from LM Studio.",
    noModelsFoundText:
      "LM Studio responded, but no completion-ready models were reported.",
    getModels: () => settings.completionModels,
    setModels: (m) => { settings.completionModels = m; },
    renderItemMeta: undefined,
    formatDiscoveryMeta: formatDiscoveryContext,
    openModal: (app, p, source, onSave, prefill) => {
      new CompletionModelModal(app, p, source, onSave, prefill).open();
    },
    getCandidates: (service, opts) => service.getCompletionCandidates(opts),
  });
}
