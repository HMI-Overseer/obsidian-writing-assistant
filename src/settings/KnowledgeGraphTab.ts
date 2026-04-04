import { Notice } from "obsidian";
import type LMStudioWritingAssistant from "../main";
import type { GraphBuildState } from "../rag/graph";
import { createSettingsSection, Button, SettingItem } from "./ui";

/**
 * Renders the Knowledge Graph settings tab.
 * Returns a cleanup function to unregister the build state listener.
 */
export function renderKnowledgeGraphTab(
  container: HTMLElement,
  plugin: LMStudioWritingAssistant,
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
        await plugin.graphService.configure(
          kg,
          plugin.settings.completionModels,
          plugin.settings.providerSettings,
        );
        renderConditionalSections();
      }),
    );

  // ── Completion Model ──────────────────────────────────────────────
  const models = plugin.settings.completionModels;

  new SettingItem(general.bodyEl)
    .setName("Extraction model")
    .setDesc("Select which completion model to use for entity extraction. Local models (LM Studio) are free to run.")
    .addDropdown((dropdown) => {
      dropdown.addOption("", "None selected");
      for (const model of models) {
        dropdown.addOption(model.id, model.name);
      }
      dropdown.setValue(kg.activeCompletionModelId ?? "");
      dropdown.onChange(async (value) => {
        kg.activeCompletionModelId = value || null;
        await plugin.saveSettings();
        await plugin.graphService.configure(
          kg,
          plugin.settings.completionModels,
          plugin.settings.providerSettings,
        );
      });
    });

  // Move the conditional wrapper after the general section in the DOM.
  container.appendChild(conditionalWrapper);

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
      if (!kg.enabled || !kg.activeCompletionModelId) {
        new Notice("Enable knowledge graph and select a completion model first.");
        return;
      }
      await plugin.graphService.startBuild(
        kg,
        plugin.settings.completionModels,
        plugin.settings.providerSettings,
      );
    });
    const rebuildBtn = new Button(actionsEl).setButtonText("Rebuild graph").onClick(async () => {
      if (!kg.enabled || !kg.activeCompletionModelId) {
        new Notice("Enable knowledge graph and select a completion model first.");
        return;
      }
      await plugin.graphService.rebuild(
        kg,
        plugin.settings.completionModels,
        plugin.settings.providerSettings,
      );
    });
    const stopBtn = new Button(actionsEl).setButtonText("Stop").onClick(() => {
      plugin.graphService.stopBuild();
    });

    const progressRow = statusBlock.createDiv({ cls: "lmsa-index-progress" });
    const progressBarEl = progressRow.createDiv({ cls: "lmsa-index-progress-bar" });
    const progressFillEl = progressBarEl.createDiv({ cls: "lmsa-index-progress-fill" });
    const progressTextEl = progressRow.createEl("span", { cls: "lmsa-index-progress-text" });

    // ── State rendering function ──
    function updateDisplay(state: GraphBuildState): void {
      const entityCount = plugin.graphService.getEntityCount();
      const relationCount = plugin.graphService.getRelationCount();
      const fileCount = plugin.graphService.getFileCount();
      const hasGraph = entityCount > 0;
      const isExtracting = state.status === "extracting";
      const isError = state.status === "error";

      // Status text
      if (!kg.activeCompletionModelId) {
        statusTextEl.textContent = "No completion model selected.";
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

      // Progress
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

      // Button visibility
      const canAct = !!kg.activeCompletionModelId;
      buildBtn.buttonEl.toggleClass("is-visible", canAct && !hasGraph && !isExtracting);
      rebuildBtn.buttonEl.toggleClass("is-visible", canAct && hasGraph && !isExtracting);
      stopBtn.buttonEl.toggleClass("is-visible", isExtracting);
    }

    // Initial render.
    updateDisplay(plugin.graphService.getBuildState());

    // Subscribe to live state updates.
    plugin.graphService.onBuildStateChange((state) => updateDisplay(state));

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
    plugin.graphService.onBuildStateChange(null);
  };
}
