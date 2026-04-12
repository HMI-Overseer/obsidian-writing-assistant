import type WritingAssistantChat from "../main";
import type { IndexingState } from "../rag/types";
import type { ModelAvailabilityState } from "../shared/types";
import { getProviderDescriptor } from "../providers/registry";
import { createSettingsSection, createModelSelector, Button, SettingItem } from "./ui";
import { DEFAULT_RAG_SETTINGS } from "../constants";

/**
 * Renders the Retrieval (RAG) settings tab.
 * Returns a cleanup function to unregister the indexing state listener.
 */
export function renderRagTab(
  container: HTMLElement,
  plugin: WritingAssistantChat,
): () => void {
  const { rag } = plugin.settings;

  // Wrapper for conditional sections so we can show/hide them.
  const conditionalWrapper = container.createDiv({ cls: "lmsa-rag-conditional" });

  // ── Enable / Disable ──────────────────────────────────────────────
  const general = createSettingsSection(
    container,
    "Vault retrieval",
    "Automatically find and inject relevant vault content into each chat request using embedding-based search.",
    { icon: "search" },
  );

  new SettingItem(general.bodyEl)
    .setName("Enable vault retrieval")
    .setDesc("When enabled, the plugin can index your vault and retrieve relevant notes for each chat message.")
    .addToggle((toggle) =>
      toggle.setValue(rag.enabled).onChange(async (value) => {
        rag.enabled = value;
        await plugin.saveSettings();
        await plugin.services.ragService.configure(
          rag,
          plugin.settings.embeddingModels,
          plugin.settings.providerSettings,
        );
        renderConditionalSections();
      }),
    );

  // ── Embedding Model ───────────────────────────────────────────────
  const embeddingItem = new SettingItem(general.bodyEl)
    .setName("Embedding model")
    .setDesc("Encodes vault content as vectors for similarity search.");

  const models = plugin.settings.embeddingModels;
  const currentModel = models.find((m) => m.id === rag.activeEmbeddingModelId) ?? null;

  const modelSelector = createModelSelector(embeddingItem.settingEl, models, {
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
      rag.activeEmbeddingModelId = model?.id ?? null;
      await plugin.saveSettings();
      await plugin.services.ragService.configure(
        rag,
        plugin.settings.embeddingModels,
        plugin.settings.providerSettings,
      );
    },
  });

  // Move the conditional wrapper after the general section in the DOM.
  container.appendChild(conditionalWrapper);

  /**
   * Checks that the embedding model is selected and available (loaded or cloud).
   * Triggers the attention effect on the selector if validation fails.
   */
  async function validateModelReady(): Promise<boolean> {
    if (!rag.activeEmbeddingModelId) {
      modelSelector.retriggerAttention();
      return false;
    }

    const state = await modelSelector.refreshAvailability();
    const isReady = (s: ModelAvailabilityState) => s === "loaded" || s === "cloud";
    if (!isReady(state)) {
      modelSelector.retriggerAttention();
      return false;
    }
    return true;
  }

  /** Renders or clears the conditional sections based on rag.enabled. */
  function renderConditionalSections(): void {
    conditionalWrapper.empty();

    if (!rag.enabled) return;

    // ── Index Status (live-updating) ──────────────────────────────────
    const status = createSettingsSection(
      conditionalWrapper,
      "Index",
      "Manage the vector index used for retrieval.",
      { icon: "database" },
    );

    // ── Index status block ──
    const statusBlock = status.bodyEl.createDiv({ cls: "lmsa-index-status" });

    const headerRow = statusBlock.createDiv({ cls: "lmsa-index-status-header" });
    const infoEl = headerRow.createDiv({ cls: "lmsa-index-status-info" });
    const statusTextEl = infoEl.createEl("p", { cls: "lmsa-index-status-text" });
    const driftNoticeEl = infoEl.createEl("p", { cls: "lmsa-index-drift-notice" });

    const actionsEl = headerRow.createDiv({ cls: "lmsa-index-actions" });
    const buildBtn = new Button(actionsEl).setButtonText("Build index").setCta().onClick(async () => {
      if (!await validateModelReady()) return;
      await plugin.services.ragService.startIndexing(
        rag,
        plugin.settings.embeddingModels,
        plugin.settings.providerSettings,
      );
    });
    const rebuildBtn = new Button(actionsEl).setButtonText("Rebuild index").onClick(async () => {
      if (!await validateModelReady()) return;
      await plugin.services.ragService.rebuild(
        rag,
        plugin.settings.embeddingModels,
        plugin.settings.providerSettings,
      );
    });
    const stopBtn = new Button(actionsEl).setButtonText("Stop").onClick(() => {
      plugin.services.ragService.stopIndexing();
    });

    const progressRow = statusBlock.createDiv({ cls: "lmsa-index-progress" });
    const progressBarEl = progressRow.createDiv({ cls: "lmsa-index-progress-bar" });
    const progressFillEl = progressBarEl.createDiv({ cls: "lmsa-index-progress-fill" });
    const progressTextEl = progressRow.createEl("span", { cls: "lmsa-index-progress-text" });

    // ── State rendering function ──
    function updateDisplay(state: IndexingState): void {
      const fileCount = plugin.services.ragService.getFileCount();
      const chunkCount = plugin.services.ragService.getChunkCount();
      const hasIndex = chunkCount > 0;
      const isIndexing = state.status === "indexing";
      const isError = state.status === "error";

      // Status text
      if (!rag.activeEmbeddingModelId) {
        statusTextEl.textContent = "No embedding model selected.";
      } else if (isError) {
        statusTextEl.textContent = `Error: ${state.message}`;
        statusTextEl.addClass("mod-error");
      } else if (isIndexing) {
        statusTextEl.textContent = "Indexing in progress...";
        statusTextEl.removeClass("mod-error");
      } else if (hasIndex) {
        statusTextEl.textContent = `${fileCount} files, ${chunkCount} chunks indexed.`;
        statusTextEl.removeClass("mod-error");
      } else {
        statusTextEl.textContent = "Index not built. Click build index to start.";
        statusTextEl.removeClass("mod-error");
      }

      // Settings drift notice
      const showDrift = hasIndex && rag.enabled && plugin.services.ragService.needsReindex(rag);
      driftNoticeEl.textContent = showDrift
        ? "Settings changed since last build. Rebuild recommended."
        : "";
      driftNoticeEl.toggleClass("is-visible", showDrift);

      // Progress
      if (isIndexing) {
        const pct = state.filesTotal > 0
          ? Math.round((state.filesProcessed / state.filesTotal) * 100)
          : 0;
        progressFillEl.setCssStyles({ width: `${pct}%` });
        progressTextEl.textContent = `${state.filesProcessed} / ${state.filesTotal} files (${pct}%)`;
      } else {
        progressFillEl.setCssStyles({ width: "0%" });
        progressTextEl.textContent = "";
      }
      progressRow.toggleClass("is-visible", isIndexing);

      // Button visibility
      const canAct = !!rag.activeEmbeddingModelId;
      buildBtn.buttonEl.toggleClass("is-visible", canAct && !hasIndex && !isIndexing);
      rebuildBtn.buttonEl.toggleClass("is-visible", canAct && hasIndex && !isIndexing);
      stopBtn.buttonEl.toggleClass("is-visible", isIndexing);
    }

    // Initial render.
    updateDisplay(plugin.services.ragService.getIndexingState());

    // Subscribe to live state updates.
    plugin.services.ragService.onIndexingStateChange((state) => updateDisplay(state));

    // ── Retrieval ─────────────────────────────────────────────────────
    const retrieval = createSettingsSection(
      conditionalWrapper,
      "Retrieval",
      "Control how many and which results are injected as context.",
      { icon: "filter" },
    );

    new SettingItem(retrieval.bodyEl)
      .setName("Metadata enrichment")
      .setDesc("Prepend tags, folder path, and wikilink targets to each chunk before embedding. Improves entity disambiguation in creative writing vaults.")
      .addToggle((toggle) =>
        toggle.setValue(rag.metadataEnrichment).onChange(async (value) => {
          rag.metadataEnrichment = value;
          await plugin.saveSettings();
          updateDisplay(plugin.services.ragService.getIndexingState());
        }),
      );

    new SettingItem(retrieval.bodyEl)
      .setName("Results per query")
      .setDesc(`Number of relevant chunks to inject, 1–20 (default: ${DEFAULT_RAG_SETTINGS.topK}).`)
      .addText((text) => {
        text.setValue(String(rag.topK));
        text.onChange(async (value) => {
          const num = parseInt(value, 10);
          if (!isNaN(num) && num >= 1 && num <= 20) {
            rag.topK = num;
            await plugin.saveSettings();
          }
        });
      });

    new SettingItem(retrieval.bodyEl)
      .setName("Max chunks per file")
      .setDesc(`Limit how many chunks a single file can contribute, 1–20 (default: ${DEFAULT_RAG_SETTINGS.maxChunksPerFile}).`)
      .addText((text) => {
        text.setValue(String(rag.maxChunksPerFile));
        text.onChange(async (value) => {
          const num = parseInt(value, 10);
          if (!isNaN(num) && num >= 1 && num <= 20) {
            rag.maxChunksPerFile = num;
            await plugin.saveSettings();
          }
        });
      });

    new SettingItem(retrieval.bodyEl)
      .setName("Minimum similarity")
      .setDesc(`Only include results above this score, 0–0.8 (default: ${DEFAULT_RAG_SETTINGS.minScore}).`)
      .addText((text) => {
        text.setValue(String(rag.minScore));
        text.onChange(async (value) => {
          const num = parseFloat(value);
          if (!isNaN(num) && num >= 0 && num <= 0.8) {
            rag.minScore = num;
            await plugin.saveSettings();
          }
        });
      });

    // ── Chunking ──────────────────────────────────────────────────────
    const chunking = createSettingsSection(
      conditionalWrapper,
      "Chunking",
      "Configure how vault notes are split into retrieval-friendly pieces.",
      { icon: "scissors" },
    );

    new SettingItem(chunking.bodyEl)
      .setName("Chunk size")
      .setDesc(`Target characters per chunk, 500–3000 (default: ${DEFAULT_RAG_SETTINGS.chunkSize}).`)
      .addText((text) => {
        text.setValue(String(rag.chunkSize));
        text.onChange(async (value) => {
          const num = parseInt(value, 10);
          if (!isNaN(num) && num >= 500 && num <= 3000) {
            rag.chunkSize = num;
            await plugin.saveSettings();
          }
        });
      });

    new SettingItem(chunking.bodyEl)
      .setName("Chunk overlap")
      .setDesc(`Characters of overlap between adjacent chunks, 0–500 (default: ${DEFAULT_RAG_SETTINGS.chunkOverlap}).`)
      .addText((text) => {
        text.setValue(String(rag.chunkOverlap));
        text.onChange(async (value) => {
          const num = parseInt(value, 10);
          if (!isNaN(num) && num >= 0 && num <= 500) {
            rag.chunkOverlap = num;
            await plugin.saveSettings();
          }
        });
      });

    new SettingItem(chunking.bodyEl)
      .setName("Exclude patterns")
      .setDesc("Glob patterns for files to exclude from indexing (one per line).")
      .addTextArea((textarea) => {
        textarea.setValue(rag.excludePatterns.join("\n"));
        textarea.setPlaceholder("e.g. templates/**");
        textarea.onChange(async (value) => {
          rag.excludePatterns = value
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
    plugin.services.ragService.onIndexingStateChange(null);
  };
}
