import type WritingAssistantChat from "../main";
import type { GraphBuildState } from "../rag/graph";
import type { ModelAvailabilityState } from "../shared/types";
import { getProviderDescriptor } from "../providers/registry";
import { createSettingsSection, createModelSelector, Button, SettingItem } from "./ui";

/**
 * Renders the Knowledge Graph settings tab.
 * Returns a cleanup function to unregister the build state listener.
 */
export function renderKnowledgeGraphTab(
  container: HTMLElement,
  plugin: WritingAssistantChat,
): () => void {
  const { knowledgeGraph: kg } = plugin.settings;

  const conditionalWrapper = container.createDiv({ cls: "lmsa-kg-conditional" });

  // ── Enable / Disable ──────────────────────────────────────────────
  const general = createSettingsSection(
    container,
    "Knowledge graph",
    "Use an LLM to extract entities and relationships from your vault, building a semantic knowledge graph that discovers connections across notes.",
    { icon: "git-fork" },
  );

  new SettingItem(general.bodyEl)
    .setName("Enable knowledge graph")
    .setDesc("When enabled, the plugin can extract entities and relationships from your vault using a completion model.")
    .addToggle((toggle) =>
      toggle.setValue(kg.enabled).onChange(async (value) => {
        kg.enabled = value;
        await plugin.saveSettings();
        await plugin.services.graphService.configure(
          kg,
          plugin.settings.completionModels,
          plugin.settings.embeddingModels,
          plugin.settings.providerSettings,
        );
        renderConditionalSections();
      }),
    );

  // ── Completion model ──────────────────────────────────────────────
  const completionItem = new SettingItem(general.bodyEl)
    .setName("Completion model")
    .setDesc("Generates structured entity and relationship data from your notes.");

  const models = plugin.settings.completionModels;
  const currentModel = models.find((m) => m.id === kg.activeCompletionModelId) ?? null;

  const modelSelector = createModelSelector(completionItem.settingEl, models, {
    getAvailability: (modelId, provider) =>
      plugin.services.modelAvailability.getAvailability(modelId, provider).state,
    refreshLocalModels: async () => {
      if (currentModel) {
        const desc = getProviderDescriptor(currentModel.provider);
        if (desc.kind !== "cloud") {
          await plugin.services.modelAvailability.refreshLocalModels({ forceRefresh: true });
        }
      }
    },
  }, {
    initial: currentModel,
    placeholder: "None selected",
    onSelect: async (model) => {
      kg.activeCompletionModelId = model?.id ?? null;
      await plugin.saveSettings();
      await plugin.services.graphService.configure(
        kg,
        plugin.settings.completionModels,
        plugin.settings.embeddingModels,
        plugin.settings.providerSettings,
      );
    },
  });

  // ── Embedding model ───────────────────────────────────────────────
  const embeddingItem = new SettingItem(general.bodyEl)
    .setName("Embedding model")
    .setDesc("Encodes extracted entities as vectors for similarity search.");

  const embModels = plugin.settings.embeddingModels;
  const currentEmbModel = embModels.find((m) => m.id === kg.activeEmbeddingModelId) ?? null;

  const embModelSelector = createModelSelector(embeddingItem.settingEl, embModels, {
    getAvailability: (modelId, provider) =>
      plugin.services.modelAvailability.getAvailability(modelId, provider).state,
    refreshLocalModels: async () => {
      if (currentEmbModel) {
        const desc = getProviderDescriptor(currentEmbModel.provider);
        if (desc.kind !== "cloud") {
          await plugin.services.modelAvailability.refreshLocalModels({ forceRefresh: true });
        }
      }
    },
  }, {
    initial: currentEmbModel,
    placeholder: "None selected",
    onSelect: async (model) => {
      kg.activeEmbeddingModelId = model?.id ?? null;
      await plugin.saveSettings();
      await plugin.services.graphService.configure(
        kg,
        plugin.settings.completionModels,
        plugin.settings.embeddingModels,
        plugin.settings.providerSettings,
      );
    },
  });

  // Move the conditional wrapper after the general section in the DOM.
  container.appendChild(conditionalWrapper);

  /**
   * Checks that both models are selected and available (loaded or cloud).
   * Triggers the attention effect on any selector that fails validation.
   */
  async function validateModelsReady(): Promise<boolean> {
    if (!kg.activeCompletionModelId || !kg.activeEmbeddingModelId) {
      if (!kg.activeCompletionModelId) modelSelector.retriggerAttention();
      if (!kg.activeEmbeddingModelId) embModelSelector.retriggerAttention();
      return false;
    }

    const [compState, embState] = await Promise.all([
      modelSelector.refreshAvailability(),
      embModelSelector.refreshAvailability(),
    ]);

    const isReady = (s: ModelAvailabilityState) => s === "loaded" || s === "cloud";
    let ok = true;
    if (!isReady(compState))  { modelSelector.retriggerAttention(); ok = false; }
    if (!isReady(embState))   { embModelSelector.retriggerAttention(); ok = false; }
    return ok;
  }

  /** Renders or clears the conditional sections based on kg.enabled. */
  function renderConditionalSections(): void {
    conditionalWrapper.empty();

    if (!kg.enabled) return;

    // ── Graph Status (live-updating) ──────────────────────────────────
    const status = createSettingsSection(
      conditionalWrapper,
      "Graph",
      "Manage the extracted knowledge graph.",
      { icon: "database" },
    );

    // ── Graph status block ──
    const statusBlock = status.bodyEl.createDiv({ cls: "lmsa-index-status" });

    const headerRow = statusBlock.createDiv({ cls: "lmsa-index-status-header" });
    const infoEl = headerRow.createDiv({ cls: "lmsa-index-status-info" });
    const statusTextEl = infoEl.createEl("p", { cls: "lmsa-index-status-text" });

    const actionsEl = headerRow.createDiv({ cls: "lmsa-index-actions" });
    const buildBtn = new Button(actionsEl).setButtonText("Build graph").setCta().onClick(async () => {
      if (!await validateModelsReady()) return;
      await plugin.services.graphService.startBuild(
        kg,
        plugin.settings.completionModels,
        plugin.settings.embeddingModels,
        plugin.settings.providerSettings,
      );
    });
    const rebuildBtn = new Button(actionsEl).setButtonText("Rebuild graph").onClick(async () => {
      if (!await validateModelsReady()) return;
      await plugin.services.graphService.rebuild(
        kg,
        plugin.settings.completionModels,
        plugin.settings.embeddingModels,
        plugin.settings.providerSettings,
      );
    });
    const stopBtn = new Button(actionsEl).setButtonText("Stop").onClick(async () => {
      await plugin.services.graphService.stopBuild();
    });

    const progressRow = statusBlock.createDiv({ cls: "lmsa-index-progress" });
    const progressBarEl = progressRow.createDiv({ cls: "lmsa-index-progress-bar" });
    const progressFillEl = progressBarEl.createDiv({ cls: "lmsa-index-progress-fill" });
    const progressTextEl = progressRow.createEl("span", { cls: "lmsa-index-progress-text" });

    const folderSectionEl = statusBlock.createDiv({ cls: "lmsa-kg-folder-section" });

    // ── State rendering function ──
    function updateDisplay(state: GraphBuildState): void {
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
        statusTextEl.textContent = missing;
      } else if (isError) {
        statusTextEl.textContent = `Error: ${state.message}`;
        statusTextEl.addClass("mod-error");
      } else if (isExtracting) {
        statusTextEl.textContent = "Extracting entities...";
        statusTextEl.removeClass("mod-error");
      } else if (hasGraph) {
        statusTextEl.textContent = `${fileCount} files processed. ${entityCount} entities, ${relationCount} relationships.`;
        statusTextEl.removeClass("mod-error");
      } else {
        statusTextEl.textContent = "Graph not built. Click build graph to start.";
        statusTextEl.removeClass("mod-error");
      }

      // Overall extraction progress bar (shown during any active build)
      if (isExtracting) {
        const pct = state.filesTotal > 0
          ? Math.round((state.filesProcessed / state.filesTotal) * 100)
          : 0;
        progressFillEl.setCssStyles({ width: `${pct}%` });
        progressTextEl.textContent = `${state.filesProcessed} / ${state.filesTotal} files (${pct}%)`;
      } else {
        progressFillEl.setCssStyles({ width: "0%" });
        progressTextEl.textContent = "";
      }
      progressRow.toggleClass("is-visible", isExtracting);

      // Button visibility — Stop only shown for full-vault builds, not folder builds
      const canAct = !!kg.activeCompletionModelId && !!kg.activeEmbeddingModelId;
      buildBtn.buttonEl.toggleClass("is-visible", canAct && !hasGraph && !isExtracting);
      rebuildBtn.buttonEl.toggleClass("is-visible", canAct && hasGraph && !isExtracting);
      stopBtn.buttonEl.toggleClass("is-visible", isExtracting && activeFolder === undefined);

      // ── Folder coverage section ──
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

        row.createEl("span", {
          cls: `lmsa-kg-folder-name${folder === "(root)" ? " is-root" : ""}`,
          text: folder,
        });

        const barWrap = row.createDiv({ cls: "lmsa-kg-folder-bar" });
        const barFill = barWrap.createDiv({ cls: "lmsa-kg-folder-bar-fill" });
        barFill.setCssStyles({ width: `${pct}%` });
        if (isComplete) barFill.addClass("is-complete");
        if (isBuildingThisFolder) barFill.addClass("is-active");

        row.createEl("span", { cls: "lmsa-kg-folder-count", text: `${processed} / ${total}` });

        const actionEl = row.createDiv({ cls: "lmsa-kg-folder-action" });

        if (isBuildingThisFolder) {
          const stopFolderBtn = actionEl.createEl("button", {
            cls: "lmsa-ui-btn lmsa-kg-folder-btn lmsa-kg-folder-stop-btn",
            text: "Stop",
          });
          stopFolderBtn.addEventListener("click", async () => {
            await plugin.services.graphService.stopBuild();
          });
        } else if (!isComplete && canAct && !isExtracting) {
          const btn = actionEl.createEl("button", {
            cls: "lmsa-ui-btn lmsa-ui-btn-secondary lmsa-kg-folder-btn",
            text: processed > 0 ? "Resume" : "Build",
          });
          btn.addEventListener("click", async () => {
            if (!await validateModelsReady()) return;
            await plugin.services.graphService.startBuildFolder(
              folder,
              kg,
              plugin.settings.completionModels,
              plugin.settings.embeddingModels,
              plugin.settings.providerSettings,
            );
          });
        }
        // isComplete → no button needed
        // isExtracting + not this folder → no button (prevents concurrent builds)
      }
    }

    // Initial render.
    updateDisplay(plugin.services.graphService.getBuildState());

    // Subscribe to live state updates.
    plugin.services.graphService.onBuildStateChange((state) => updateDisplay(state));

    // ── Exclude Patterns ─────────────────────────────────────────────
    const filtering = createSettingsSection(
      conditionalWrapper,
      "Filtering",
      "Control which files are included in graph extraction.",
      { icon: "filter" },
    );

    new SettingItem(filtering.bodyEl)
      .setName("Exclude patterns")
      .setDesc("Glob patterns for files to exclude from extraction (one per line).")
      .addTextArea((textarea) => {
        textarea.setValue(kg.excludePatterns.join("\n"));
        textarea.setPlaceholder("e.g. templates/**");
        textarea.onChange(async (value) => {
          kg.excludePatterns = value
            .split("\n")
            .map((line) => line.trim())
            .filter((line) => line.length > 0);
          await plugin.saveSettings();
        });
      });
  }

  // Initial render of conditional sections.
  renderConditionalSections();

  // Return cleanup function.
  return () => {
    modelSelector.destroy();
    embModelSelector.destroy();
    plugin.services.graphService.onBuildStateChange(null);
  };
}
