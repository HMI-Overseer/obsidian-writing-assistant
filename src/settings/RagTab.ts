import type { SettingDefinitionRender } from "obsidian";
import type WritingAssistantChat from "../main";
import type { IndexingState } from "../rag/types";
import type { ModelAvailabilityState } from "../shared/types";
import { getSelectableEmbeddingModels } from "../providers/selectableModels";
import { createModelSelector, pluginModelDropdownDeps, Button } from "./ui";
import type { ModelSelectorItem, ModelSelectorRefs } from "./ui";
import { voidAsync } from "../asyncCallbacks";
import { DEFAULT_RAG_SETTINGS } from "../constants";
import type { SettingsSection } from "./definitions/sections";
import { blockRow, settingRow } from "./definitions/sections";
import { formatLineList, parseLineList } from "./definitions/lineList";

/**
 * What two rows publish for rows in other cards that act on them: the model selector, which the
 * index status block's buttons validate against, and the status repaint, which a model change and
 * the metadata-enrichment toggle both trigger.
 *
 * Each is set by the row that owns the thing and nulled by that row's cleanup, so a card Obsidian
 * re-renders on its own never leaves another card holding a handle into DOM that is gone.
 */
interface RagPageRefs {
  selector: ModelSelectorRefs | null;
  refreshStatus: (() => void) | null;
}

/**
 * Renders the Retrieval (RAG) settings tab.
 *
 * `refreshDomState` is the setting tab's own, and the enable toggle calls it: everything below that
 * toggle is a card carrying `visible`, and Obsidian re-evaluates those predicates in place.
 */
export function ragTabSections(
  plugin: WritingAssistantChat,
  refreshDomState: () => void,
): SettingsSection[] {
  const refs: RagPageRefs = { selector: null, refreshStatus: null };

  /** Everything below the enable toggle. */
  const dependent = (section: SettingsSection): SettingsSection => ({
    ...section,
    visible: () => plugin.settings.rag.enabled,
  });

  return [
    vaultRetrievalCard(plugin, refs, refreshDomState),
    dependent(indexCard(plugin, refs)),
    dependent(automaticReindexingCard(plugin)),
    dependent(retrievalCard(plugin, refs)),
    dependent(chunkingCard(plugin)),
  ];
}

/**
 * Hands the current retrieval settings to the service. Every row that changes what the indexer
 * does calls it after saving.
 */
function reconfigureRag(plugin: WritingAssistantChat): Promise<void> {
  return plugin.services.ragService.configure(
    plugin.settings.rag,
    getSelectableEmbeddingModels(plugin.settings),
    plugin.settings.providerSettings,
  );
}

function vaultRetrievalCard(
  plugin: WritingAssistantChat,
  refs: RagPageRefs,
  refreshDomState: () => void,
): SettingsSection {
  return {
    name: "Vault retrieval",
    desc: "Automatically find and inject relevant vault content into each chat request using embedding-based search.",
    icon: "search",
    rows: [
      settingRow(
        "Enable vault retrieval",
        "When enabled, the plugin can index your vault and retrieve relevant notes for each chat message.",
        (item) => {
          item.addToggle((toggle) =>
            toggle.setValue(plugin.settings.rag.enabled).onChange(async (value) => {
              plugin.settings.rag.enabled = value;
              await plugin.saveSettings();
              await reconfigureRag(plugin);
              refreshDomState();
            }),
          );
        },
      ),
      embeddingModelRow(plugin, refs),
    ],
  };
}

/**
 * The embedding model picker. `createModelSelector` mounts on the row element rather than the
 * control slot, so the selector spans the row's full width under the name and description.
 */
function embeddingModelRow(
  plugin: WritingAssistantChat,
  refs: RagPageRefs,
): SettingDefinitionRender {
  return settingRow(
    "Embedding model",
    "Encodes vault content as vectors for similarity search.",
    (item) => {
      const models = getSelectableEmbeddingModels(plugin.settings);
      const current =
        models.find((m) => m.id === plugin.settings.rag.activeEmbeddingModelId) ?? null;

      const selector = createModelSelector(
        item.settingEl,
        models,
        pluginModelDropdownDeps(plugin),
        {
          initial: current,
          placeholder: "None selected",
          onSelect: voidAsync(async (model: ModelSelectorItem | null) => {
            plugin.settings.rag.activeEmbeddingModelId = model?.id ?? null;
            await plugin.saveSettings();
            await reconfigureRag(plugin);
            refs.refreshStatus?.();
          }, "Failed to update the embedding model."),
        },
      );

      refs.selector = selector;
      return () => {
        refs.selector = null;
        selector.destroy();
      };
    },
  );
}

/**
 * Checks that the embedding model is selected and available (loaded or cloud).
 * Triggers the attention effect on the selector if validation fails.
 */
async function validateModelReady(
  plugin: WritingAssistantChat,
  refs: RagPageRefs,
): Promise<boolean> {
  const selector = refs.selector;
  // The picker's card renders before this one, so a click can only arrive while it is mounted.
  if (!selector) return false;

  if (!plugin.settings.rag.activeEmbeddingModelId) {
    selector.retriggerAttention();
    return false;
  }

  const state = await selector.refreshAvailability();
  const isReady = (s: ModelAvailabilityState) => s === "loaded" || s === "cloud";
  if (!isReady(state)) {
    selector.retriggerAttention();
    return false;
  }
  return true;
}

function indexCard(plugin: WritingAssistantChat, refs: RagPageRefs): SettingsSection {
  return {
    name: "Index",
    desc: "Manage the vector index used for retrieval.",
    icon: "database",
    rows: [indexStatusBlock(plugin, refs)],
  };
}

/** The elements {@link paintIndexStatus} writes into. */
interface IndexStatusEls {
  statusTextEl: HTMLElement;
  driftNoticeEl: HTMLElement;
  progressRow: HTMLElement;
  progressFillEl: HTMLElement;
  progressTextEl: HTMLElement;
  buildBtn: Button;
  rebuildBtn: Button;
  stopBtn: Button;
}

/** Live index state: status text, drift notice, progress bar, and the three action buttons. */
function indexStatusBlock(
  plugin: WritingAssistantChat,
  refs: RagPageRefs,
): SettingDefinitionRender {
  return blockRow("Index status", "", "lmsa-settings-section-block", (el) => {
    const statusBlock = el.createDiv({ cls: "lmsa-index-status" });

    const headerRow = statusBlock.createDiv({ cls: "lmsa-index-status-header" });
    const infoEl = headerRow.createDiv({ cls: "lmsa-index-status-info" });
    const statusTextEl = infoEl.createEl("p", { cls: "lmsa-index-status-text" });
    const driftNoticeEl = infoEl.createEl("p", { cls: "lmsa-index-drift-notice" });

    const actionsEl = headerRow.createDiv({ cls: "lmsa-index-actions" });
    const buildBtn = new Button(actionsEl).setButtonText("Build index").setCta().onClick(async () => {
      if (!await validateModelReady(plugin, refs)) return;
      await plugin.services.ragService.startIndexing(
        plugin.settings.rag,
        getSelectableEmbeddingModels(plugin.settings),
        plugin.settings.providerSettings,
      );
    });
    const rebuildBtn = new Button(actionsEl).setButtonText("Rebuild index").onClick(async () => {
      if (!await validateModelReady(plugin, refs)) return;
      await plugin.services.ragService.rebuild(
        plugin.settings.rag,
        getSelectableEmbeddingModels(plugin.settings),
        plugin.settings.providerSettings,
      );
    });
    const stopBtn = new Button(actionsEl).setButtonText("Stop").onClick(() => {
      plugin.services.ragService.stopIndexing();
    });

    const progressRow = statusBlock.createDiv({ cls: "lmsa-index-progress" });
    const progressBarEl = progressRow.createDiv({ cls: "lmsa-index-progress-bar" });
    const progressFillEl = progressBarEl.createDiv({ cls: "lmsa-index-progress-fill" });
    const progressTextEl = progressRow.createSpan({ cls: "lmsa-index-progress-text" });

    const els: IndexStatusEls = {
      statusTextEl,
      driftNoticeEl,
      progressRow,
      progressFillEl,
      progressTextEl,
      buildBtn,
      rebuildBtn,
      stopBtn,
    };

    const repaint = () =>
      paintIndexStatus(plugin, els, plugin.services.ragService.getIndexingState());

    repaint();
    refs.refreshStatus = repaint;
    plugin.services.ragService.onIndexingStateChange((state) =>
      paintIndexStatus(plugin, els, state),
    );

    return () => {
      refs.refreshStatus = null;
      plugin.services.ragService.onIndexingStateChange(null);
    };
  });
}

function paintIndexStatus(
  plugin: WritingAssistantChat,
  els: IndexStatusEls,
  state: IndexingState,
): void {
  const { rag } = plugin.settings;
  const fileCount = plugin.services.ragService.getFileCount();
  const chunkCount = plugin.services.ragService.getChunkCount();
  const hasIndex = chunkCount > 0;
  const isIndexing = state.status === "indexing";
  const isError = state.status === "error";

  // Status text
  if (!rag.activeEmbeddingModelId) {
    els.statusTextEl.textContent = "No embedding model selected.";
  } else if (isError) {
    els.statusTextEl.textContent = `Error: ${state.message}`;
    els.statusTextEl.addClass("mod-error");
  } else if (isIndexing) {
    els.statusTextEl.textContent = "Indexing in progress...";
    els.statusTextEl.removeClass("mod-error");
  } else if (hasIndex) {
    els.statusTextEl.textContent = `${fileCount} files, ${chunkCount} chunks indexed.`;
    els.statusTextEl.removeClass("mod-error");
  } else {
    els.statusTextEl.textContent = "Index not built. Click build index to start.";
    els.statusTextEl.removeClass("mod-error");
  }

  // Settings drift notice
  const showDrift = hasIndex && rag.enabled && plugin.services.ragService.needsReindex(rag);
  els.driftNoticeEl.textContent = showDrift
    ? "Settings changed since last build. Rebuild recommended."
    : "";
  els.driftNoticeEl.toggleClass("is-visible", showDrift);

  // Progress
  if (isIndexing) {
    const pct = state.filesTotal > 0
      ? Math.round((state.filesProcessed / state.filesTotal) * 100)
      : 0;
    els.progressFillEl.setCssStyles({ width: `${pct}%` });
    els.progressTextEl.textContent = `${state.filesProcessed} / ${state.filesTotal} files (${pct}%)`;
  } else {
    els.progressFillEl.setCssStyles({ width: "0%" });
    els.progressTextEl.textContent = "";
  }
  els.progressRow.toggleClass("is-visible", isIndexing);

  // Button visibility
  const canAct = !!rag.activeEmbeddingModelId;
  els.buildBtn.buttonEl.toggleClass("is-visible", canAct && !hasIndex && !isIndexing);
  els.rebuildBtn.buttonEl.toggleClass("is-visible", canAct && hasIndex && !isIndexing);
  els.stopBtn.buttonEl.toggleClass("is-visible", isIndexing);
}

function automaticReindexingCard(plugin: WritingAssistantChat): SettingsSection {
  return {
    name: "Automatic reindexing",
    desc: "Keep the index current as your vault changes. Automatic runs never load a local embedding model that is not already running, they wait until it is.",
    icon: "refresh-cw",
    rows: [
      settingRow(
        "Reindex on startup",
        "When the plugin loads, scan for notes changed while it was off and index them.",
        (item) => {
          item.addToggle((toggle) =>
            toggle.setValue(plugin.settings.rag.reindexOnStartup).onChange(async (value) => {
              plugin.settings.rag.reindexOnStartup = value;
              await plugin.saveSettings();
              await reconfigureRag(plugin);
            }),
          );
        },
      ),
      settingRow(
        "Watch for changes",
        "Reindex each note as it is created, edited, renamed, or deleted.",
        (item) => {
          item.addToggle((toggle) =>
            toggle.setValue(plugin.settings.rag.watchForChanges).onChange(async (value) => {
              plugin.settings.rag.watchForChanges = value;
              await plugin.saveSettings();
              await reconfigureRag(plugin);
            }),
          );
        },
      ),
      settingRow(
        "Auto-reindex on cloud models",
        "Allow automatic runs to embed through a metered cloud model. Off keeps automatic reindexing local-only, so cloud embedding stays manual and avoids unexpected API cost.",
        (item) => {
          item.addToggle((toggle) =>
            toggle.setValue(plugin.settings.rag.autoReindexOnCloud).onChange(async (value) => {
              plugin.settings.rag.autoReindexOnCloud = value;
              await plugin.saveSettings();
            }),
          );
        },
      ),
    ],
  };
}

function retrievalCard(plugin: WritingAssistantChat, refs: RagPageRefs): SettingsSection {
  return {
    name: "Retrieval",
    desc: "Control how many and which results are injected as context.",
    icon: "filter",
    rows: [
      settingRow(
        "Metadata enrichment",
        "Prepend tags, folder path, and wikilink targets to each chunk before embedding. Improves entity disambiguation in creative writing vaults.",
        (item) => {
          item.addToggle((toggle) =>
            toggle.setValue(plugin.settings.rag.metadataEnrichment).onChange(async (value) => {
              plugin.settings.rag.metadataEnrichment = value;
              await plugin.saveSettings();
              refs.refreshStatus?.();
            }),
          );
        },
      ),
      settingRow(
        "Results per query",
        `Number of relevant chunks to inject, 1–20 (default: ${DEFAULT_RAG_SETTINGS.topK}).`,
        (item) => {
          item.addText((text) => {
            text.setValue(String(plugin.settings.rag.topK));
            text.onChange(async (value) => {
              const num = parseInt(value, 10);
              if (!Number.isNaN(num) && num >= 1 && num <= 20) {
                plugin.settings.rag.topK = num;
                await plugin.saveSettings();
              }
            });
          });
        },
      ),
      settingRow(
        "Max chunks per file",
        `Limit how many chunks a single file can contribute, 1–20 (default: ${DEFAULT_RAG_SETTINGS.maxChunksPerFile}).`,
        (item) => {
          item.addText((text) => {
            text.setValue(String(plugin.settings.rag.maxChunksPerFile));
            text.onChange(async (value) => {
              const num = parseInt(value, 10);
              if (!Number.isNaN(num) && num >= 1 && num <= 20) {
                plugin.settings.rag.maxChunksPerFile = num;
                await plugin.saveSettings();
              }
            });
          });
        },
      ),
      settingRow(
        "Minimum similarity",
        `Only include results above this score, 0–0.8 (default: ${DEFAULT_RAG_SETTINGS.minScore}).`,
        (item) => {
          item.addText((text) => {
            text.setValue(String(plugin.settings.rag.minScore));
            text.onChange(async (value) => {
              const num = parseFloat(value);
              if (!Number.isNaN(num) && num >= 0 && num <= 0.8) {
                plugin.settings.rag.minScore = num;
                await plugin.saveSettings();
              }
            });
          });
        },
      ),
    ],
  };
}

function chunkingCard(plugin: WritingAssistantChat): SettingsSection {
  return {
    name: "Chunking",
    desc: "Configure how vault notes are split into retrieval-friendly pieces.",
    icon: "scissors",
    rows: [
      settingRow(
        "Chunk size",
        `Target characters per chunk, 500–3000 (default: ${DEFAULT_RAG_SETTINGS.chunkSize}).`,
        (item) => {
          item.addText((text) => {
            text.setValue(String(plugin.settings.rag.chunkSize));
            text.onChange(async (value) => {
              const num = parseInt(value, 10);
              if (!Number.isNaN(num) && num >= 500 && num <= 3000) {
                plugin.settings.rag.chunkSize = num;
                await plugin.saveSettings();
              }
            });
          });
        },
      ),
      settingRow(
        "Chunk overlap",
        `Characters of overlap between adjacent chunks, 0–500 (default: ${DEFAULT_RAG_SETTINGS.chunkOverlap}).`,
        (item) => {
          item.addText((text) => {
            text.setValue(String(plugin.settings.rag.chunkOverlap));
            text.onChange(async (value) => {
              const num = parseInt(value, 10);
              if (!Number.isNaN(num) && num >= 0 && num <= 500) {
                plugin.settings.rag.chunkOverlap = num;
                await plugin.saveSettings();
              }
            });
          });
        },
      ),
      settingRow(
        "Exclude patterns",
        "Glob patterns for files to exclude from indexing (one per line).",
        (item) => {
          item.addTextArea((textarea) => {
            textarea.setValue(formatLineList(plugin.settings.rag.excludePatterns));
            textarea.setPlaceholder("e.g. templates/**");
            textarea.onChange(async (value) => {
              plugin.settings.rag.excludePatterns = parseLineList(value);
              await plugin.saveSettings();
            });
          });
        },
      ),
    ],
  };
}
