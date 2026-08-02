import type { SettingDefinitionRender } from "obsidian";
import type WritingAssistantChat from "../main";
import type { GraphBuildState } from "../rag/graph";
import type { ModelAvailabilityState } from "../shared/types";
import {
  getSelectableCompletionModels,
  getSelectableEmbeddingModels,
} from "../providers/selectableModels";
import { createModelSelector, pluginModelDropdownDeps, Button } from "./ui";
import type { ModelSelectorItem, ModelSelectorRefs } from "./ui";
import { voidAsync } from "../asyncCallbacks";
import type { SettingsSection } from "./definitions/sections";
import { blockRow, settingRow } from "./definitions/sections";
import { formatLineList, parseLineList } from "./definitions/lineList";

/**
 * What the rows publish to rows in other cards that act on them: the two model selectors, which the
 * graph status block's buttons validate against, and the status repaint, which either model change
 * triggers.
 *
 * Each is set by the row that owns the thing and nulled by that row's cleanup, so a card Obsidian
 * re-renders on its own never leaves another card holding a handle into DOM that is gone.
 */
interface GraphPageRefs {
  completionSelector: ModelSelectorRefs | null;
  embeddingSelector: ModelSelectorRefs | null;
  refreshStatus: (() => void) | null;
}

/**
 * Renders the Knowledge Graph settings tab.
 *
 * `refreshDomState` is the setting tab's own, and the enable toggle calls it: the graph and
 * filtering cards carry `visible`, and Obsidian re-evaluates those predicates in place.
 */
export function knowledgeGraphTabSections(
  plugin: WritingAssistantChat,
  refreshDomState: () => void,
): SettingsSection[] {
  const refs: GraphPageRefs = {
    completionSelector: null,
    embeddingSelector: null,
    refreshStatus: null,
  };

  /** Everything below the enable toggle. */
  const dependent = (section: SettingsSection): SettingsSection => ({
    ...section,
    visible: () => plugin.settings.knowledgeGraph.enabled,
  });

  return [
    beforeYouBeginCard(),
    knowledgeGraphCard(plugin, refs, refreshDomState),
    dependent(graphCard(plugin, refs)),
    dependent(filteringCard(plugin)),
  ];
}

/** Hands the current graph settings to the service. Every row that changes the build calls it. */
function reconfigureGraph(plugin: WritingAssistantChat): Promise<void> {
  return plugin.services.graphService.configure(
    plugin.settings.knowledgeGraph,
    getSelectableCompletionModels(plugin.settings),
    getSelectableEmbeddingModels(plugin.settings),
    plugin.settings.providerSettings,
  );
}

/**
 * Four description-only rows. They set no value and read none: the card exists to state the cost
 * before a user turns the feature on, and each row is its own search entry.
 */
function beforeYouBeginCard(): SettingsSection {
  return {
    name: "Before you begin",
    desc: "",
    icon: "triangle-alert",
    // The animated conic-gradient border that marks this card as a caution rather than a control.
    cls: "lmsa-kg-warning",
    rows: [
      settingRow(
        "Compute",
        "Every note is sent to a completion model to find relationships and interconnect entities, then each entity is embedded. This is resource intensive on both compute and memory.",
        () => {},
      ),
      settingRow(
        "Large vaults",
        "Vaults with hundreds or thousands of notes will take considerably longer to process.",
        () => {},
      ),
      settingRow(
        "Cost",
        "Cloud providers charge per token. A full build can consume a meaningful amount of API credits.",
        () => {},
      ),
      settingRow(
        "Benefits",
        "Once built, the graph surfaces connections across notes that are hard to find manually, useful for world-building, story planning, and discovering narrative threads between characters, locations, and events.",
        () => {},
      ),
    ],
  };
}

function knowledgeGraphCard(
  plugin: WritingAssistantChat,
  refs: GraphPageRefs,
  refreshDomState: () => void,
): SettingsSection {
  return {
    name: "Knowledge graph",
    desc: "Use an LLM to extract entities and relationships from your vault, building a semantic knowledge graph that discovers connections across notes.",
    icon: "git-fork",
    rows: [
      settingRow(
        "Enable knowledge graph",
        "When enabled, the plugin can extract entities and relationships from your vault using a completion model.",
        (item) => {
          item.addToggle((toggle) =>
            toggle
              .setValue(plugin.settings.knowledgeGraph.enabled)
              .onChange(async (value) => {
                plugin.settings.knowledgeGraph.enabled = value;
                await plugin.saveSettings();
                await reconfigureGraph(plugin);
                refreshDomState();
              }),
          );
        },
      ),
      modelRow(plugin, refs, "completion"),
      modelRow(plugin, refs, "embedding"),
    ],
  };
}

/** The two pickers differ only in which models they list and which setting they write. */
const MODEL_ROLES = {
  completion: {
    name: "Completion model",
    desc: "Generates structured entity and relationship data from your notes.",
    error: "Failed to update the knowledge graph completion model.",
  },
  embedding: {
    name: "Embedding model",
    desc: "Encodes extracted entities as vectors for similarity search.",
    error: "Failed to update the knowledge graph embedding model.",
  },
} as const;

/**
 * A model picker. `createModelSelector` mounts on the row element rather than the control slot, so
 * the selector spans the row's full width under the name and description.
 */
function modelRow(
  plugin: WritingAssistantChat,
  refs: GraphPageRefs,
  role: "completion" | "embedding",
): SettingDefinitionRender {
  const meta = MODEL_ROLES[role];
  return settingRow(meta.name, meta.desc, (item) => {
    const models =
      role === "completion"
        ? getSelectableCompletionModels(plugin.settings)
        : getSelectableEmbeddingModels(plugin.settings);
    const activeId =
      role === "completion"
        ? plugin.settings.knowledgeGraph.activeCompletionModelId
        : plugin.settings.knowledgeGraph.activeEmbeddingModelId;
    const current = models.find((m) => m.id === activeId) ?? null;

    const selector = createModelSelector(item.settingEl, models, pluginModelDropdownDeps(plugin), {
      initial: current,
      placeholder: "None selected",
      onSelect: voidAsync(async (model: ModelSelectorItem | null) => {
        const kg = plugin.settings.knowledgeGraph;
        if (role === "completion") kg.activeCompletionModelId = model?.id ?? null;
        else kg.activeEmbeddingModelId = model?.id ?? null;
        await plugin.saveSettings();
        await reconfigureGraph(plugin);
        refs.refreshStatus?.();
      }, meta.error),
    });

    if (role === "completion") refs.completionSelector = selector;
    else refs.embeddingSelector = selector;

    return () => {
      if (role === "completion") refs.completionSelector = null;
      else refs.embeddingSelector = null;
      selector.destroy();
    };
  });
}

/**
 * Checks that both models are selected and available (loaded or cloud).
 * Triggers the attention effect on any selector that fails validation.
 */
async function validateModelsReady(
  plugin: WritingAssistantChat,
  refs: GraphPageRefs,
): Promise<boolean> {
  const { completionSelector, embeddingSelector } = refs;
  // Both pickers' card renders before this one, so a click can only arrive while they are mounted.
  if (!completionSelector || !embeddingSelector) return false;

  const kg = plugin.settings.knowledgeGraph;
  if (!kg.activeCompletionModelId || !kg.activeEmbeddingModelId) {
    if (!kg.activeCompletionModelId) completionSelector.retriggerAttention();
    if (!kg.activeEmbeddingModelId) embeddingSelector.retriggerAttention();
    return false;
  }

  const [compState, embState] = await Promise.all([
    completionSelector.refreshAvailability(),
    embeddingSelector.refreshAvailability(),
  ]);

  const isReady = (s: ModelAvailabilityState) => s === "loaded" || s === "cloud";
  let ok = true;
  if (!isReady(compState)) { completionSelector.retriggerAttention(); ok = false; }
  if (!isReady(embState)) { embeddingSelector.retriggerAttention(); ok = false; }
  return ok;
}

function graphCard(plugin: WritingAssistantChat, refs: GraphPageRefs): SettingsSection {
  return {
    name: "Graph",
    desc: "Manage the extracted knowledge graph.",
    icon: "database",
    rows: [graphStatusBlock(plugin, refs)],
  };
}

/** The elements {@link paintGraphStatus} writes into. */
interface GraphStatusEls {
  statusTextEl: HTMLElement;
  staleNoticeEl: HTMLElement;
  progressRow: HTMLElement;
  progressFillEl: HTMLElement;
  progressTextEl: HTMLElement;
  folderSectionEl: HTMLElement;
  buildBtn: Button;
  rebuildBtn: Button;
  stopBtn: Button;
}

/**
 * Live build state: status text, staleness notice, progress bar, the three action buttons, and the
 * per-folder coverage list.
 */
function graphStatusBlock(
  plugin: WritingAssistantChat,
  refs: GraphPageRefs,
): SettingDefinitionRender {
  return blockRow("Graph status", "", "lmsa-settings-section-block", (el) => {
    const statusBlock = el.createDiv({ cls: "lmsa-index-status" });

    const headerRow = statusBlock.createDiv({ cls: "lmsa-index-status-header" });
    const infoEl = headerRow.createDiv({ cls: "lmsa-index-status-info" });
    const statusTextEl = infoEl.createEl("p", { cls: "lmsa-index-status-text" });
    const staleNoticeEl = infoEl.createEl("p", { cls: "lmsa-index-drift-notice" });

    const actionsEl = headerRow.createDiv({ cls: "lmsa-index-actions" });
    const buildBtn = new Button(actionsEl).setButtonText("Build graph").setCta().onClick(async () => {
      if (!await validateModelsReady(plugin, refs)) return;
      await plugin.services.graphService.startBuild(
        plugin.settings.knowledgeGraph,
        getSelectableCompletionModels(plugin.settings),
        getSelectableEmbeddingModels(plugin.settings),
        plugin.settings.providerSettings,
      );
    });
    const rebuildBtn = new Button(actionsEl).setButtonText("Rebuild graph").onClick(async () => {
      if (!await validateModelsReady(plugin, refs)) return;
      await plugin.services.graphService.rebuild(
        plugin.settings.knowledgeGraph,
        getSelectableCompletionModels(plugin.settings),
        getSelectableEmbeddingModels(plugin.settings),
        plugin.settings.providerSettings,
      );
    });
    const stopBtn = new Button(actionsEl).setButtonText("Stop").onClick(async () => {
      await plugin.services.graphService.stopBuild();
    });

    const progressRow = statusBlock.createDiv({ cls: "lmsa-index-progress" });
    const progressBarEl = progressRow.createDiv({ cls: "lmsa-index-progress-bar" });
    const progressFillEl = progressBarEl.createDiv({ cls: "lmsa-index-progress-fill" });
    const progressTextEl = progressRow.createSpan({ cls: "lmsa-index-progress-text" });

    const folderSectionEl = statusBlock.createDiv({ cls: "lmsa-kg-folder-section" });

    const els: GraphStatusEls = {
      statusTextEl,
      staleNoticeEl,
      progressRow,
      progressFillEl,
      progressTextEl,
      folderSectionEl,
      buildBtn,
      rebuildBtn,
      stopBtn,
    };

    const repaint = () =>
      paintGraphStatus(plugin, refs, els, plugin.services.graphService.getBuildState());

    repaint();
    refs.refreshStatus = repaint;
    plugin.services.graphService.onBuildStateChange((state) =>
      paintGraphStatus(plugin, refs, els, state),
    );

    return () => {
      refs.refreshStatus = null;
      plugin.services.graphService.onBuildStateChange(null);
    };
  });
}

function paintGraphStatus(
  plugin: WritingAssistantChat,
  refs: GraphPageRefs,
  els: GraphStatusEls,
  state: GraphBuildState,
): void {
  const kg = plugin.settings.knowledgeGraph;
  const entityCount = plugin.services.graphService.getEntityCount();
  const relationCount = plugin.services.graphService.getRelationCount();
  const fileCount = plugin.services.graphService.getFileCount();
  const hasGraph = entityCount > 0;
  const isExtracting = state.status === "extracting";
  const isError = state.status === "error";
  const activeFolder = isExtracting ? state.targetFolder : undefined;

  // Status text
  if (!kg.activeCompletionModelId || !kg.activeEmbeddingModelId) {
    const missing = !kg.activeCompletionModelId && !kg.activeEmbeddingModelId
      ? "No completion or embedding model selected."
      : !kg.activeCompletionModelId
        ? "No completion model selected."
        : "No embedding model selected.";
    els.statusTextEl.textContent = missing;
  } else if (isError) {
    els.statusTextEl.textContent = `Error: ${state.message}`;
    els.statusTextEl.addClass("mod-error");
  } else if (isExtracting) {
    els.statusTextEl.textContent = "Extracting entities...";
    els.statusTextEl.removeClass("mod-error");
  } else if (hasGraph) {
    els.statusTextEl.textContent = `${fileCount} files processed. ${entityCount} entities, ${relationCount} relationships.`;
    els.statusTextEl.removeClass("mod-error");
  } else {
    els.statusTextEl.textContent = "Graph not built. Click build graph to start.";
    els.statusTextEl.removeClass("mod-error");
  }

  // Staleness notice: tracked files edited since the last build. A rename or
  // delete is re-keyed live, but an edit only refreshes on a (re)build, so
  // surface the drift instead of silently serving stale entity descriptions.
  const staleCount = hasGraph && !isExtracting
    ? plugin.services.graphService.getStaleFileCount(kg.excludePatterns)
    : 0;
  els.staleNoticeEl.textContent = staleCount > 0
    ? `${staleCount} file${staleCount === 1 ? "" : "s"} changed since the graph was built. Rebuild to refresh.`
    : "";
  els.staleNoticeEl.toggleClass("is-visible", staleCount > 0);

  // Overall extraction progress bar (shown during any active build)
  if (isExtracting) {
    const pct = state.filesTotal > 0
      ? Math.round((state.filesProcessed / state.filesTotal) * 100)
      : 0;
    els.progressFillEl.setCssStyles({ width: `${pct}%` });
    els.progressTextEl.textContent = `${state.filesProcessed} / ${state.filesTotal} files (${pct}%)`;
  } else {
    els.progressFillEl.setCssStyles({ width: "0%" });
    els.progressTextEl.textContent = "";
  }
  els.progressRow.toggleClass("is-visible", isExtracting);

  // Button visibility, Stop only shown for full-vault builds, not folder builds
  const canAct = !!kg.activeCompletionModelId && !!kg.activeEmbeddingModelId;
  els.buildBtn.buttonEl.toggleClass("is-visible", canAct && !hasGraph && !isExtracting);
  els.rebuildBtn.buttonEl.toggleClass("is-visible", canAct && hasGraph && !isExtracting);
  els.stopBtn.buttonEl.toggleClass("is-visible", isExtracting && activeFolder === undefined);

  paintFolderCoverage(plugin, refs, els.folderSectionEl, state, canAct, activeFolder);
}

/** Per-folder progress, rebuilt on every repaint because a build changes every row's counts. */
function paintFolderCoverage(
  plugin: WritingAssistantChat,
  refs: GraphPageRefs,
  folderSectionEl: HTMLElement,
  state: GraphBuildState,
  canAct: boolean,
  activeFolder: string | undefined,
): void {
  const kg = plugin.settings.knowledgeGraph;
  const isExtracting = state.status === "extracting";

  folderSectionEl.empty();
  if (!canAct) return;

  const folderStats = plugin.services.graphService.getFolderStats(kg.excludePatterns);
  if (folderStats.size === 0) return;

  const folders = [...folderStats.keys()].sort((a, b) => {
    if (a === "(root)") return 1;
    if (b === "(root)") return -1;
    return a.localeCompare(b);
  });

  for (const folder of folders) {
    const entry = folderStats.get(folder);
    if (!entry) continue;
    const { processed, total } = entry;
    const isComplete = processed === total && total > 0;
    const isBuildingThisFolder = isExtracting && activeFolder === folder;

    // Use live extraction progress for the active folder's bar; persisted stats otherwise.
    const pct = isBuildingThisFolder && state.status === "extracting"
      ? (state.filesTotal > 0 ? Math.round((state.filesProcessed / state.filesTotal) * 100) : 0)
      : (total > 0 ? Math.round((processed / total) * 100) : 0);

    const row = folderSectionEl.createDiv({ cls: "lmsa-kg-folder-row" });

    row.createSpan({
      cls: `lmsa-kg-folder-name${folder === "(root)" ? " is-root" : ""}`,
      text: folder,
    });

    const barWrap = row.createDiv({ cls: "lmsa-kg-folder-bar" });
    const barFill = barWrap.createDiv({ cls: "lmsa-kg-folder-bar-fill" });
    barFill.setCssStyles({ width: `${pct}%` });
    if (isComplete) barFill.addClass("is-complete");
    if (isBuildingThisFolder) barFill.addClass("is-active");

    row.createSpan({ cls: "lmsa-kg-folder-count", text: `${processed} / ${total}` });

    const actionEl = row.createDiv({ cls: "lmsa-kg-folder-action" });

    if (isBuildingThisFolder) {
      const stopFolderBtn = actionEl.createEl("button", {
        cls: "lmsa-ui-btn lmsa-kg-folder-btn lmsa-kg-folder-stop-btn",
        text: "Stop",
      });
      stopFolderBtn.addEventListener("click", voidAsync(async () => {
        await plugin.services.graphService.stopBuild();
      }, "Failed to stop the knowledge graph build."));
    } else if (!isComplete && canAct && !isExtracting) {
      const btn = actionEl.createEl("button", {
        cls: "lmsa-ui-btn lmsa-ui-btn-secondary lmsa-kg-folder-btn",
        text: processed > 0 ? "Resume" : "Build",
      });
      btn.addEventListener("click", voidAsync(async () => {
        if (!await validateModelsReady(plugin, refs)) return;
        await plugin.services.graphService.startBuildFolder(
          folder,
          plugin.settings.knowledgeGraph,
          getSelectableCompletionModels(plugin.settings),
          getSelectableEmbeddingModels(plugin.settings),
          plugin.settings.providerSettings,
        );
      }, "Failed to build the knowledge graph folder."));
    }
    // isComplete → no button needed
    // isExtracting + not this folder → no button (prevents concurrent builds)
  }
}

function filteringCard(plugin: WritingAssistantChat): SettingsSection {
  return {
    name: "Filtering",
    desc: "Control which files are included in graph extraction.",
    icon: "filter",
    rows: [
      settingRow(
        "Exclude patterns",
        "Glob patterns for files to exclude from extraction (one per line).",
        (item) => {
          item.addTextArea((textarea) => {
            textarea.setValue(formatLineList(plugin.settings.knowledgeGraph.excludePatterns));
            textarea.setPlaceholder("e.g. templates/**");
            textarea.onChange(async (value) => {
              plugin.settings.knowledgeGraph.excludePatterns = parseLineList(value);
              await plugin.saveSettings();
            });
          });
        },
      ),
    ],
  };
}
