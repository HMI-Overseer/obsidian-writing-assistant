import type WritingAssistantChat from "../../main";
import type { CompletionModel, ModelAvailabilityState, ProviderOption } from "../../shared/types";
import type { ChatLayoutRefs } from "../types";
import { setIcon } from "obsidian";
import { PROVIDER_OPTIONS } from "../../shared/modelKeys";
import { PROVIDER_DESCRIPTORS, PROVIDER_ICONS } from "../../providers/descriptors";
import {
  filterModelsByQuery,
  isFavoriteModel,
  modelsForCategory,
  resolveLandingCategory,
  type ModelSelectorCategory,
} from "./modelSelectorLogic";

const MODEL_SELECTOR_ATTENTION_DURATION_MS = 700;

type ChatModelSelectorOptions = {
  getActiveModel: () => CompletionModel | null;
  getActiveProfileId: () => string;
  /** Composed selectable list (enabled providers' catalogs + live discovery). */
  getModels: () => CompletionModel[];
  onSelectModel: (model: CompletionModel) => Promise<void>;
};

export class ChatModelSelector {
  private modelDropdownOpen = false;
  private modelSelectorAttentionTimer: number | null = null;
  private isCheckingModelStatus = false;

  /** Interior state while the dropdown is open. */
  private activeCategory: ModelSelectorCategory = "favorites";
  private searchQuery = "";
  private openModels: CompletionModel[] = [];
  private railEl: HTMLElement | null = null;
  private listEl: HTMLElement | null = null;

  constructor(
    private readonly plugin: WritingAssistantChat,
    private readonly refs: Pick<
      ChatLayoutRefs,
      | "modelSelectorBtn"
      | "modelSelectorLabelEl"
      | "modelSelectorStatusEl"
      | "modelSelectorChevronEl"
      | "modelDropdownEl"
    >,
    private readonly options: ChatModelSelectorOptions
  ) {
    this.refs.modelSelectorBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      this.toggle();
    });
    // Interior clicks (search field, rail, star toggles) mutate selector state
    // without selecting; none of them may trip ChatView's document click-away.
    this.refs.modelDropdownEl.addEventListener("click", (event) => {
      event.stopPropagation();
    });
  }

  syncActiveModel(): void {
    const activeModel = this.options.getActiveModel();

    if (!activeModel?.modelId) {
      this.setModelAvailabilityState("unknown");
      return;
    }

    const { state } = this.plugin.services.modelAvailability.getAvailability(
      activeModel.modelId,
      activeModel.provider,
    );
    this.setModelAvailabilityState(state);
  }

  isCheckingStatus(): boolean {
    return this.isCheckingModelStatus;
  }

  isOpen(): boolean {
    return this.modelDropdownOpen;
  }

  close(): void {
    this.refs.modelDropdownEl.addClass("lmsa-hidden");
    this.modelDropdownOpen = false;
    this.railEl = null;
    this.listEl = null;
    this.openModels = [];
    this.refs.modelSelectorBtn.removeClass("is-active");
    setIcon(this.refs.modelSelectorChevronEl, "chevron-down");
  }

  clearAttention(): void {
    if (this.modelSelectorAttentionTimer !== null) {
      window.clearTimeout(this.modelSelectorAttentionTimer);
      this.modelSelectorAttentionTimer = null;
    }

    this.refs.modelSelectorBtn.removeClass("is-attention");
  }

  retriggerAttention(): void {
    this.clearAttention();
    this.refs.modelSelectorBtn.removeClass("is-attention");
    void this.refs.modelSelectorBtn.offsetWidth;
    this.refs.modelSelectorBtn.addClass("is-attention");
    this.modelSelectorAttentionTimer = window.setTimeout(() => {
      this.modelSelectorAttentionTimer = null;
      this.refs.modelSelectorBtn.removeClass("is-attention");
    }, MODEL_SELECTOR_ATTENTION_DURATION_MS);
  }

  async refreshAvailability(
    forceRefresh = true
  ): Promise<ModelAvailabilityState> {
    const activeModel = this.options.getActiveModel();
    if (!activeModel?.modelId) {
      this.setModelAvailabilityState("unknown");
      return "unknown";
    }

    const availability = this.plugin.services.modelAvailability;
    const info = availability.getAvailability(activeModel.modelId, activeModel.provider);

    if (info.state === "cloud") {
      this.setModelAvailabilityState("cloud");
      return "cloud";
    }

    this.isCheckingModelStatus = true;

    try {
      await availability.refreshLocalModels({ forceRefresh });
      const refreshed = availability.getAvailability(activeModel.modelId, activeModel.provider);
      this.setModelAvailabilityState(refreshed.state);
      return refreshed.state;
    } catch {
      this.setModelAvailabilityState("unknown");
      return "unknown";
    } finally {
      this.isCheckingModelStatus = false;
    }
  }

  destroy(): void {
    this.clearAttention();
  }

  private toggle(): void {
    if (this.modelDropdownOpen) {
      this.close();
      return;
    }

    this.open();
  }

  private open(): void {
    this.searchQuery = "";
    this.refs.modelDropdownEl.empty();
    this.refs.modelDropdownEl.removeClass("lmsa-hidden");
    this.modelDropdownOpen = true;
    this.refs.modelSelectorBtn.addClass("is-active");
    setIcon(this.refs.modelSelectorChevronEl, "chevron-up");

    const loadingList = this.refs.modelDropdownEl.createDiv({
      cls: "lmsa-model-dropdown-list",
    });
    loadingList.createDiv({
      cls: "lmsa-model-dropdown-empty",
      text: "Loading models...",
    });

    void this.renderDropdownContents();
  }

  private setModelAvailabilityState(state: ModelAvailabilityState): void {
    this.refs.modelSelectorStatusEl.removeClass(
      "is-loaded",
      "is-unloaded",
      "is-unknown",
      "is-cloud",
      "is-hidden"
    );

    const activeModel = this.options.getActiveModel();
    if (!activeModel?.modelId) {
      this.refs.modelSelectorStatusEl.addClass("is-hidden");
      return;
    }

    this.refs.modelSelectorStatusEl.addClass(`is-${state}`);
  }

  private enabledProviders(): ProviderOption[] {
    return PROVIDER_OPTIONS.filter(
      (provider) => this.plugin.settings.providerSettings[provider].enabled
    );
  }

  private async renderDropdownContents(): Promise<void> {
    await this.refreshAvailability();
    if (!this.modelDropdownOpen) return;

    this.openModels = this.options.getModels();
    this.refs.modelDropdownEl.empty();

    if (this.openModels.length === 0) {
      const listEl = this.refs.modelDropdownEl.createDiv({
        cls: "lmsa-model-dropdown-list",
      });
      listEl.createDiv({
        cls: "lmsa-model-dropdown-empty",
        text: "No models available. Enable a provider in settings.",
      });
      return;
    }

    this.activeCategory = resolveLandingCategory(
      this.openModels,
      this.plugin.settings.favoriteModelKeys,
      this.options.getActiveModel(),
      this.enabledProviders()
    );

    const searchWrap = this.refs.modelDropdownEl.createDiv({
      cls: "lmsa-model-dropdown-search",
    });
    const searchIcon = searchWrap.createSpan({ cls: "lmsa-model-dropdown-search-icon" });
    setIcon(searchIcon, "search");
    const searchInput = searchWrap.createEl("input", {
      cls: "lmsa-model-dropdown-search-input",
      attr: { type: "text", placeholder: "Search models..." },
    });
    searchInput.addEventListener("input", () => {
      this.searchQuery = searchInput.value;
      this.renderList();
    });

    const refreshBtn = searchWrap.createEl("button", {
      cls: "lmsa-model-dropdown-refresh",
      attr: { "aria-label": "Refresh models" },
    });
    setIcon(refreshBtn, "refresh-cw");
    refreshBtn.addEventListener("click", () => {
      void this.handleRefreshClick(refreshBtn);
    });

    const body = this.refs.modelDropdownEl.createDiv({ cls: "lmsa-model-dropdown-body" });
    this.railEl = body.createDiv({ cls: "lmsa-model-dropdown-rail" });
    this.listEl = body.createDiv({ cls: "lmsa-model-dropdown-list" });

    this.renderRail();
    this.renderList();
    searchInput.focus();
  }

  /**
   * Force a local-discovery refresh and re-render in place. Goes straight to
   * refreshLocalModels rather than refreshAvailability(), which short-circuits
   * for cloud active models and would leave the LM Studio rows stale.
   */
  private async handleRefreshClick(refreshBtn: HTMLElement): Promise<void> {
    if (refreshBtn.hasClass("is-refreshing")) return;
    refreshBtn.addClass("is-refreshing");
    try {
      await this.plugin.services.modelAvailability.refreshLocalModels({ forceRefresh: true });
    } catch {
      // Discovery failure keeps the last-seen snapshot; dots render unknown.
    } finally {
      refreshBtn.removeClass("is-refreshing");
    }
    if (!this.modelDropdownOpen) return;
    this.syncActiveModel();
    this.openModels = this.options.getModels();
    this.renderList();
  }

  /**
   * The rail has a fixed shape: favorites on top, then every provider in
   * PROVIDER_OPTIONS order. Disabled providers render grayed out and
   * non-interactive, a hint that more providers exist.
   */
  private renderRail(): void {
    const railEl = this.railEl;
    if (!railEl) return;
    railEl.empty();

    const addEntry = (
      category: ModelSelectorCategory,
      icon: string,
      label: string,
      enabled: boolean
    ): void => {
      const entry = railEl.createDiv({ cls: "lmsa-model-dropdown-rail-item" });
      setIcon(entry, icon);
      entry.setAttr("title", label);
      if (!enabled) {
        entry.addClass("is-disabled");
        return;
      }
      if (category === this.activeCategory) entry.addClass("is-active");
      entry.addEventListener("click", () => {
        if (this.activeCategory === category) return;
        this.activeCategory = category;
        this.renderRail();
        this.renderList();
      });
    };

    addEntry("favorites", "star", "Favorites", true);
    for (const provider of PROVIDER_OPTIONS) {
      addEntry(
        provider,
        PROVIDER_ICONS[provider],
        PROVIDER_DESCRIPTORS[provider].label,
        this.plugin.settings.providerSettings[provider].enabled
      );
    }
  }

  private renderList(): void {
    const listEl = this.listEl;
    if (!listEl) return;
    listEl.empty();

    const favoriteKeys = this.plugin.settings.favoriteModelKeys;
    const inCategory = modelsForCategory(this.openModels, this.activeCategory, favoriteKeys);
    const models = filterModelsByQuery(inCategory, this.searchQuery);

    if (models.length === 0) {
      const text =
        this.activeCategory === "favorites" && inCategory.length === 0
          ? "Star models to pin them here"
          : inCategory.length === 0
            ? "No models available"
            : "No models match your search";
      listEl.createDiv({ cls: "lmsa-model-dropdown-empty", text });
      return;
    }

    const activeProfileId = this.options.getActiveProfileId();
    for (const model of models) {
      this.renderModelRow(listEl, model, activeProfileId, favoriteKeys);
    }
  }

  private renderModelRow(
    listEl: HTMLElement,
    model: CompletionModel,
    activeProfileId: string,
    favoriteKeys: readonly string[]
  ): void {
    const item = listEl.createDiv({ cls: "lmsa-model-dropdown-item" });
    const checkSpan = item.createEl("span", { cls: "lmsa-model-dropdown-check" });
    if (model.id === activeProfileId) {
      item.addClass("is-active");
      setIcon(checkSpan, "check");
    }

    const copy = item.createDiv({ cls: "lmsa-model-dropdown-copy" });
    copy.createEl("span", {
      cls: "lmsa-model-dropdown-name",
      text: model.name,
    });
    copy.createEl("span", {
      cls: "lmsa-model-dropdown-provider",
      text: PROVIDER_DESCRIPTORS[model.provider].label,
    });

    const { state: itemState } = this.plugin.services.modelAvailability.getAvailability(
      model.modelId,
      model.provider,
    );
    item.createEl("span", {
      cls: `lmsa-model-dropdown-state is-${itemState}`,
    });

    const starEl = item.createEl("span", { cls: "lmsa-model-dropdown-star" });
    setIcon(starEl, "star");
    if (isFavoriteModel(model, favoriteKeys)) starEl.addClass("is-faved");
    starEl.addEventListener("click", (event) => {
      // Starring never selects, and must not close the popover.
      event.stopPropagation();
      void this.toggleFavorite(model);
    });

    item.addEventListener("click", async (event) => {
      event.stopPropagation();
      await this.options.onSelectModel(model);
      this.close();
    });
  }

  private async toggleFavorite(model: CompletionModel): Promise<void> {
    const favorites = this.plugin.settings.favoriteModelKeys;
    const index = favorites.indexOf(model.id);
    if (index === -1) {
      favorites.push(model.id);
    } else {
      favorites.splice(index, 1);
    }
    await this.plugin.saveSettings();
    this.renderList();
  }
}
