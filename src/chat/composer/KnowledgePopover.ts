import { setIcon } from "obsidian";
import type { IndexingState } from "../../rag/types";
import type { GraphBuildState } from "../../rag/graph/types";
import type { EmbeddingModel, ModelAvailabilityState, ProviderOption } from "../../shared/types";
import { Toggle, createModelSelector } from "../../settings/ui";
import type { ModelSelectorRefs } from "../../settings/ui";
import type { ChatLayoutRefs } from "../types";

export type RagSnapshot = {
  enabled: boolean;
  hasModel: boolean;
  ready: boolean;
  fileCount: number;
  chunkCount: number;
  indexingState: IndexingState;
};

export type GraphSnapshot = {
  enabled: boolean;
  ready: boolean;
  entityCount: number;
  relationCount: number;
  buildState: GraphBuildState;
};

export type KnowledgePopoverCallbacks = {
  getRagSnapshot: () => RagSnapshot;
  getGraphSnapshot: () => GraphSnapshot;
  getEmbeddingModels: () => EmbeddingModel[];
  getActiveEmbeddingModelId: () => string | null;
  getAvailability: (modelId: string, provider: ProviderOption) => ModelAvailabilityState;
  refreshLocalModels: () => Promise<void>;
  onRagToggle: (enabled: boolean) => Promise<void>;
  onGraphToggle: (enabled: boolean) => Promise<void>;
  onEmbeddingModelSelect: (modelId: string | null) => Promise<void>;
  onRagBuild: () => Promise<void>;
  onRagRebuild: () => Promise<void>;
  onRagStop: () => void;
  onSubscribe: (onUpdate: () => void) => void;
  onUnsubscribe: () => void;
  onBeforeOpen?: () => void;
};

interface RagSectionRefs {
  toggle: Toggle;
  statusEl: HTMLElement;
  actionBtn: HTMLButtonElement;
  modelSelector: ModelSelectorRefs;
  statusRowEl: HTMLElement;
}

interface GraphSectionRefs {
  toggle: Toggle;
  statusEl: HTMLElement;
}

export class KnowledgePopover {
  private popoverOpen = false;
  private ragRefs: RagSectionRefs | null = null;
  private graphRefs: GraphSectionRefs | null = null;
  private readonly onIndicatorClick: (event: MouseEvent) => void;
  private readonly onPopoverClick: (event: MouseEvent) => void;

  constructor(
    private readonly refs: Pick<
      ChatLayoutRefs,
      "knowledgeIndicatorEl" | "knowledgePopoverEl"
    >,
    private readonly callbacks: KnowledgePopoverCallbacks
  ) {
    this.onIndicatorClick = (event: MouseEvent) => {
      event.stopPropagation();
      if (this.popoverOpen) {
        this.close();
      } else {
        this.open();
      }
    };

    this.onPopoverClick = (event: MouseEvent) => {
      event.stopPropagation();
    };

    this.refs.knowledgeIndicatorEl.addEventListener("click", this.onIndicatorClick);
    this.refs.knowledgePopoverEl.addEventListener("click", this.onPopoverClick);
  }

  open(): void {
    this.callbacks.onBeforeOpen?.();
    this.popoverOpen = true;
    this.refs.knowledgePopoverEl.removeClass("lmsa-hidden");
    this.renderContent();
    this.callbacks.onSubscribe(() => this.refresh());
  }

  close(): void {
    this.popoverOpen = false;
    this.ragRefs?.modelSelector.destroy();
    this.refs.knowledgePopoverEl.addClass("lmsa-hidden");
    this.callbacks.onUnsubscribe();
    this.ragRefs = null;
    this.graphRefs = null;
  }

  isOpen(): boolean {
    return this.popoverOpen;
  }

  destroy(): void {
    this.close();
    this.refs.knowledgeIndicatorEl.removeEventListener("click", this.onIndicatorClick);
    this.refs.knowledgePopoverEl.removeEventListener("click", this.onPopoverClick);
  }

  // ---------------------------------------------------------------------------
  // Content rendering
  // ---------------------------------------------------------------------------

  private renderContent(): void {
    const el = this.refs.knowledgePopoverEl;
    el.empty();

    el.createDiv({ cls: "lmsa-knowledge-popover-title", text: "Knowledge" });
    const body = el.createDiv({ cls: "lmsa-knowledge-popover-body" });

    this.ragRefs = this.renderRagSection(body);
    this.graphRefs = this.renderGraphSection(body);
    this.refresh();
  }

  private renderRagSection(container: HTMLElement): RagSectionRefs {
    const section = container.createDiv({ cls: "lmsa-knowledge-popover-section" });

    // Toggle row
    const headerRow = section.createDiv({ cls: "lmsa-knowledge-popover-row" });
    headerRow.createEl("span", { cls: "lmsa-knowledge-popover-label", text: "Vault retrieval" });
    const toggleWrap = headerRow.createDiv({ cls: "lmsa-knowledge-popover-control" });
    const toggle = new Toggle(toggleWrap);
    toggle.onChange((value) => void this.callbacks.onRagToggle(value));

    // Model selector — reuses the shared settings model selector component
    const selectorContainer = section.createDiv({ cls: "lmsa-knowledge-popover-model-wrap" });
    const models = this.callbacks.getEmbeddingModels();
    const activeId = this.callbacks.getActiveEmbeddingModelId();
    const activeModel = models.find((m) => m.id === activeId) ?? null;

    const modelSelector = createModelSelector(selectorContainer, models, {
      getAvailability: (modelId, provider) =>
        this.callbacks.getAvailability(modelId, provider),
      refreshLocalModels: () => this.callbacks.refreshLocalModels(),
    }, {
      initial: activeModel,
      placeholder: "Select model...",
      onSelect: (model) => {
        void this.callbacks.onEmbeddingModelSelect(model?.id ?? null);
        this.refresh();
      },
    });

    // Status + action row
    const statusRowEl = section.createDiv({ cls: "lmsa-knowledge-popover-status-row" });
    const statusEl = statusRowEl.createEl("span", { cls: "lmsa-knowledge-popover-status" });
    const actionBtn = statusRowEl.createEl("button", {
      cls: "lmsa-knowledge-popover-action-btn",
    }) as HTMLButtonElement;

    actionBtn.addEventListener("click", async () => {
      const snap = this.callbacks.getRagSnapshot();
      if (snap.indexingState.status === "indexing") {
        this.callbacks.onRagStop();
      } else {
        if (!await this.validateModelReady()) return;
        if (snap.ready) {
          await this.callbacks.onRagRebuild();
        } else {
          await this.callbacks.onRagBuild();
        }
      }
    });

    return { toggle, statusEl, actionBtn, modelSelector, statusRowEl };
  }

  private renderGraphSection(container: HTMLElement): GraphSectionRefs {
    const section = container.createDiv({ cls: "lmsa-knowledge-popover-section" });

    // Toggle row
    const headerRow = section.createDiv({ cls: "lmsa-knowledge-popover-row" });
    headerRow.createEl("span", { cls: "lmsa-knowledge-popover-label", text: "Knowledge graph" });
    const toggleWrap = headerRow.createDiv({ cls: "lmsa-knowledge-popover-control" });
    const toggle = new Toggle(toggleWrap);
    toggle.onChange((value) => void this.callbacks.onGraphToggle(value));

    // Status
    const statusEl = section.createEl("span", { cls: "lmsa-knowledge-popover-status" });

    // Hint
    section.createEl("span", {
      cls: "lmsa-knowledge-popover-hint",
      text: "Configure graph extraction in plugin settings.",
    });

    return { toggle, statusEl };
  }

  // ---------------------------------------------------------------------------
  // Model availability validation
  // ---------------------------------------------------------------------------

  /**
   * Checks that the embedding model is selected and available (loaded or cloud).
   * Flashes the selector red if validation fails.
   */
  private async validateModelReady(): Promise<boolean> {
    if (!this.ragRefs) return false;

    const state = await this.ragRefs.modelSelector.refreshAvailability();
    if (state !== "loaded" && state !== "cloud") {
      this.ragRefs.modelSelector.retriggerAttention();
      return false;
    }
    return true;
  }

  // ---------------------------------------------------------------------------
  // Refresh
  // ---------------------------------------------------------------------------

  private refresh(): void {
    if (!this.popoverOpen) return;

    const ragSnap = this.callbacks.getRagSnapshot();
    const graphSnap = this.callbacks.getGraphSnapshot();

    if (this.ragRefs) this.syncRagSection(this.ragRefs, ragSnap);
    if (this.graphRefs) this.syncGraphSection(this.graphRefs, graphSnap);
  }

  private syncRagSection(refs: RagSectionRefs, snap: RagSnapshot): void {
    refs.toggle.setValue(snap.enabled);

    // Conditional visibility — hide selector and action row when disabled
    refs.modelSelector.wrapEl.toggleClass("lmsa-hidden", !snap.enabled);
    refs.statusRowEl.toggleClass("lmsa-hidden", !snap.enabled);

    // Status text
    const isBuilding = snap.indexingState.status === "indexing";
    const isError = snap.indexingState.status === "error";

    if (isBuilding) {
      const { filesProcessed, filesTotal } = snap.indexingState as { filesProcessed: number; filesTotal: number };
      refs.statusEl.textContent = `Indexing ${filesProcessed}/${filesTotal} files...`;
    } else if (isError) {
      refs.statusEl.textContent = "Error";
    } else if (snap.ready) {
      refs.statusEl.textContent = `${snap.fileCount} files, ${snap.chunkCount} chunks`;
    } else if (!snap.hasModel) {
      refs.statusEl.textContent = "No embedding model selected";
    } else {
      refs.statusEl.textContent = "No index built";
    }

    // Action button
    this.syncActionButton(refs.actionBtn, snap, isBuilding);
  }

  private syncGraphSection(refs: GraphSectionRefs, snap: GraphSnapshot): void {
    refs.toggle.setValue(snap.enabled);

    const isBuilding = snap.buildState.status === "extracting";
    const isError = snap.buildState.status === "error";

    if (!snap.enabled) {
      refs.statusEl.textContent = "";
    } else if (isBuilding) {
      const { filesProcessed, filesTotal } = snap.buildState as { filesProcessed: number; filesTotal: number };
      refs.statusEl.textContent = `Extracting ${filesProcessed}/${filesTotal} files...`;
    } else if (isError) {
      refs.statusEl.textContent = "Error";
    } else if (snap.ready) {
      refs.statusEl.textContent = `${snap.entityCount} entities, ${snap.relationCount} relations`;
    } else {
      refs.statusEl.textContent = "No graph built";
    }
  }

  private syncActionButton(
    btn: HTMLButtonElement,
    snap: RagSnapshot,
    isBuilding: boolean
  ): void {
    btn.empty();

    if (!snap.enabled || (!snap.hasModel && !isBuilding)) {
      btn.addClass("lmsa-hidden");
      return;
    }

    btn.removeClass("lmsa-hidden");

    if (isBuilding) {
      setIcon(btn, "square");
      btn.setAttribute("aria-label", "Stop");
      btn.addClass("is-stop");
    } else if (snap.ready) {
      btn.removeClass("is-stop");
      setIcon(btn, "refresh-cw");
      btn.setAttribute("aria-label", "Rebuild");
    } else {
      btn.removeClass("is-stop");
      setIcon(btn, "play");
      btn.setAttribute("aria-label", "Build");
    }
  }
}
