import { setIcon } from "obsidian";
import type WritingAssistantChat from "../../main";
import type { ModelAvailabilityState, ProviderOption } from "../../shared/types";
import { PROVIDER_OPTIONS } from "../../shared/modelKeys";
import { PROVIDER_DESCRIPTORS, PROVIDER_ICONS } from "../../providers/descriptors";
import {
  filterModelsByQuery,
  isFavoriteModel,
  modelsForCategory,
  resolveLandingCategory,
} from "./modelSelectorLogic";
import type { ModelSelectorCategory, SelectableModelLike } from "./modelSelectorLogic";

/**
 * The shared dropdown interior every model picker renders: a search field
 * with a refresh button on top, a provider icon rail on the left (favorites
 * entry first, disabled providers grayed out), and model rows with a provider
 * sub-label, availability dot, and favorite-star toggle.
 *
 * The trigger button, popover shell, and open/close plumbing stay with each
 * surface ({@link ChatModelSelector} for the chat header, `createModelSelector`
 * in settings/ui.ts for settings tabs and the knowledge popover); this class
 * only owns the content inside an already-open dropdown element. Callers must
 * keep interior clicks from reaching their document click-away handler (a
 * stopPropagation listener on the dropdown element).
 */

export interface ModelDropdownDeps {
  isProviderEnabled: (provider: ProviderOption) => boolean;
  getAvailability: (modelId: string, provider: ProviderOption) => ModelAvailabilityState;
  getFavoriteKeys: () => readonly string[];
  /** Persist a favorite toggle for a composed `provider:modelId` key. */
  toggleFavorite: (modelKey: string) => Promise<void>;
  /** Unconditional force-refresh of local discovery, for the refresh button. */
  refreshLocalModels: () => Promise<void>;
}

/** The standard deps wiring; every surface with a plugin in hand uses this. */
export function pluginModelDropdownDeps(plugin: WritingAssistantChat): ModelDropdownDeps {
  return {
    isProviderEnabled: (provider) => plugin.settings.providerSettings[provider].enabled,
    getAvailability: (modelId, provider) =>
      plugin.services.modelAvailability.getAvailability(modelId, provider).state,
    getFavoriteKeys: () => plugin.settings.favoriteModelKeys,
    toggleFavorite: async (modelKey) => {
      const favorites = plugin.settings.favoriteModelKeys;
      const index = favorites.indexOf(modelKey);
      if (index === -1) {
        favorites.push(modelKey);
      } else {
        favorites.splice(index, 1);
      }
      await plugin.saveSettings();
    },
    refreshLocalModels: async () => {
      await plugin.services.modelAvailability.refreshLocalModels({ forceRefresh: true });
    },
  };
}

export interface ModelDropdownViewOptions<T extends SelectableModelLike> {
  /** Re-read on render and after a refresh, so discovery changes show up. */
  getModels: () => T[];
  /** Composed id of the currently selected model, "" when none. */
  getSelectedId: () => string;
  /** Row click. Closing the dropdown is the caller's job. */
  onSelect: (model: T) => void;
  /** Runs after a refresh-button discovery pass (e.g. re-sync a trigger dot). */
  onAfterRefresh?: () => void;
}

export class ModelDropdownView<T extends SelectableModelLike> {
  private activeCategory: ModelSelectorCategory = "favorites";
  private searchQuery = "";
  private models: T[] = [];
  private railEl: HTMLElement | null = null;
  private listEl: HTMLElement | null = null;

  constructor(
    private readonly deps: ModelDropdownDeps,
    private readonly containerEl: HTMLElement,
    private readonly options: ModelDropdownViewOptions<T>
  ) {}

  render(): void {
    this.containerEl.empty();
    this.models = this.options.getModels();

    if (this.models.length === 0) {
      const listEl = this.containerEl.createDiv({ cls: "lmsa-model-dropdown-list" });
      listEl.createDiv({
        cls: "lmsa-model-dropdown-empty",
        text: "No models available. Enable a provider in settings.",
      });
      return;
    }

    const selectedId = this.options.getSelectedId();
    const selected = this.models.find((model) => model.id === selectedId) ?? null;
    this.activeCategory = resolveLandingCategory(
      this.models,
      this.deps.getFavoriteKeys(),
      selected,
      this.enabledProviders()
    );

    const searchWrap = this.containerEl.createDiv({ cls: "lmsa-model-dropdown-search" });
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

    const body = this.containerEl.createDiv({ cls: "lmsa-model-dropdown-body" });
    this.railEl = body.createDiv({ cls: "lmsa-model-dropdown-rail" });
    this.listEl = body.createDiv({ cls: "lmsa-model-dropdown-list" });

    this.renderRail();
    this.renderList();
    searchInput.focus();
  }

  private enabledProviders(): ProviderOption[] {
    return PROVIDER_OPTIONS.filter((provider) => this.deps.isProviderEnabled(provider));
  }

  private async handleRefreshClick(refreshBtn: HTMLElement): Promise<void> {
    if (refreshBtn.hasClass("is-refreshing")) return;
    refreshBtn.addClass("is-refreshing");
    try {
      await this.deps.refreshLocalModels();
    } catch {
      // Discovery failure keeps the last-seen snapshot; dots render unknown.
    } finally {
      refreshBtn.removeClass("is-refreshing");
    }
    if (!refreshBtn.isConnected) return;
    this.options.onAfterRefresh?.();
    this.models = this.options.getModels();
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
      // Favorites keeps the muted default; only providers get a brand tint.
      if (category !== "favorites") entry.addClass(`lmsa-brand-tint-${category}`);
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
        this.deps.isProviderEnabled(provider)
      );
    }
  }

  private renderList(): void {
    const listEl = this.listEl;
    if (!listEl) return;
    listEl.empty();

    const favoriteKeys = this.deps.getFavoriteKeys();
    const inCategory = modelsForCategory(this.models, this.activeCategory, favoriteKeys);
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

    const selectedId = this.options.getSelectedId();
    for (const model of models) {
      this.renderModelRow(listEl, model, selectedId, favoriteKeys);
    }
  }

  private renderModelRow(
    listEl: HTMLElement,
    model: T,
    selectedId: string,
    favoriteKeys: readonly string[]
  ): void {
    const item = listEl.createDiv({ cls: "lmsa-model-dropdown-item" });
    const checkSpan = item.createEl("span", { cls: "lmsa-model-dropdown-check" });
    if (model.id === selectedId) {
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

    const itemState = this.deps.getAvailability(model.modelId, model.provider);
    item.createEl("span", {
      cls: `lmsa-model-dropdown-state is-${itemState}`,
    });

    const starEl = item.createEl("span", { cls: "lmsa-model-dropdown-star" });
    setIcon(starEl, "star");
    if (isFavoriteModel(model, favoriteKeys)) starEl.addClass("is-faved");
    starEl.addEventListener("click", (event) => {
      // Starring never selects, and must not close the popover.
      event.stopPropagation();
      void this.deps.toggleFavorite(model.id).then(() => this.renderList());
    });

    item.addEventListener("click", (event) => {
      event.stopPropagation();
      this.options.onSelect(model);
    });
  }
}
