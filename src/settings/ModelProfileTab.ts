import type { App } from "obsidian";
import { Notice, Setting } from "obsidian";
import { normalizeLMStudioBaseUrl } from "../api";
import type { ModelCandidateResult, ModelDigest } from "../api/types";
import type LMStudioWritingAssistant from "../main";
import type { ProviderOption } from "../shared/types";
import { createSettingsSection } from "./ui";

type BaseModel = { id: string; name: string; modelId: string; provider: ProviderOption };

export type { ProviderOption };

export type ModelProfileTabConfig<T extends BaseModel> = {
  kind: "completion" | "embedding";
  profileNoun: string;
  sectionDescription: string;
  sectionIcon?: string;
  addSectionDescription: string;
  addSectionIcon?: string;
  emptyProfilesText: string;
  emptyDiscoveryText: string;
  noModelsFoundText: string;
  getModels: () => T[];
  setModels: (models: T[]) => void;
  renderItemMeta?: (model: T) => string | null;
  formatDiscoveryMeta: (model: ModelDigest) => string;
  openModal: (
    app: App,
    plugin: LMStudioWritingAssistant,
    source: T | null,
    onSave: (model: T) => void,
    prefill?: Partial<T>
  ) => void;
  /** Per-provider model fetchers. Only providers with an entry here show the discovery UI. */
  fetchCandidates: Partial<
    Record<ProviderOption, (options: { forceRefresh: boolean }) => Promise<ModelCandidateResult>>
  >;
};

const PROVIDER_LABELS: Record<ProviderOption, string> = {
  lmstudio: "LM Studio",
  openai: "OpenAI",
  anthropic: "Anthropic",
};

export function renderModelProfileTab<T extends BaseModel>(
  container: HTMLElement,
  plugin: LMStudioWritingAssistant,
  refresh: () => void,
  config: ModelProfileTabConfig<T>
): void {
  const { settings } = plugin;

  // ── Profiles section ─────────────────────────────────────────────────

  const library = createSettingsSection(
    container,
    "Profiles",
    config.sectionDescription,
    config.sectionIcon ? { icon: config.sectionIcon } : undefined
  );

  const listEl = library.bodyEl.createDiv({ cls: "lmsa-item-list" });

  const renderList = () => {
    listEl.empty();
    const models = config.getModels();

    if (models.length === 0) {
      listEl.createEl("p", {
        cls: "lmsa-empty-state",
        text: config.emptyProfilesText,
      });
      return;
    }

    for (const model of models) {
      const row = listEl.createDiv({ cls: "lmsa-item-row" });
      const info = row.createDiv({ cls: "lmsa-item-info" });
      info.createDiv({ cls: "lmsa-item-name", text: model.name });
      info.createDiv({ cls: "lmsa-item-sub", text: model.modelId });

      if (config.renderItemMeta) {
        const meta = config.renderItemMeta(model);
        if (meta) {
          info.createDiv({ cls: "lmsa-item-meta", text: meta });
        }
      }

      const actions = row.createDiv({ cls: "lmsa-item-actions" });
      actions
        .createEl("button", {
          cls: "lmsa-btn-secondary lmsa-ui-btn lmsa-ui-btn-secondary",
          text: "Edit",
        })
        .addEventListener("click", () => {
          config.openModal(plugin.app, plugin, model, async (updated) => {
            const currentModels = config.getModels();
            const index = currentModels.findIndex((item) => item.id === updated.id);
            if (index >= 0) currentModels[index] = updated;
            config.setModels(currentModels);
            await plugin.saveSettings();
            renderList();
          });
        });

      actions
        .createEl("button", {
          cls: "lmsa-btn-danger lmsa-ui-btn",
          text: "Delete",
        })
        .addEventListener("click", async () => {
          config.setModels(config.getModels().filter((item) => item.id !== model.id));
          await plugin.saveSettings();
          refresh();
        });
    }
  };

  renderList();

  // ── Add Profile section ──────────────────────────────────────────────

  const addSection = createSettingsSection(
    container,
    "Add Profile",
    config.addSectionDescription,
    config.addSectionIcon ? { icon: config.addSectionIcon } : undefined
  );

  // Provider selector row
  const providerRow = addSection.bodyEl.createDiv({ cls: "lmsa-provider-selector-row" });
  providerRow.createEl("label", {
    cls: "lmsa-provider-selector-label",
    text: "Provider",
  });

  const providerSelect = providerRow.createEl("select", {
    cls: "lmsa-provider-selector-select",
  }) as HTMLSelectElement;

  for (const [value, label] of Object.entries(PROVIDER_LABELS)) {
    providerSelect.createEl("option", { text: label, attr: { value } });
  }

  // Provider content area — changes based on selected provider
  const providerContentEl = addSection.bodyEl.createDiv({ cls: "lmsa-provider-content" });

  // Add manually button (always visible in footer, hidden for unsupported provider+kind combos)
  const addManuallyBtn = addSection.footerEl.createEl("button", {
    cls: "lmsa-btn-add lmsa-ui-btn lmsa-ui-btn-primary",
    text: "Add manually",
  });
  addManuallyBtn.addEventListener("click", () => {
    config.openModal(plugin.app, plugin, null, async (model) => {
      const currentModels = config.getModels();
      currentModels.push(model);
      config.setModels(currentModels);
      await plugin.saveSettings();
      refresh();
    }, { provider: providerSelect.value as ProviderOption } as Partial<T>);
  });

  // ── Per-provider connection settings ──────────────────────────────────

  // LM Studio: URL + Bypass CORS
  const lmConnectionEl = providerContentEl.createDiv({ cls: "lmsa-provider-connection" });
  const lmSettings = settings.providerSettings.lmstudio;

  new Setting(lmConnectionEl)
    .setName("LM Studio URL")
    .setDesc(
      "Base URL for the LM Studio server. The plugin resolves the right endpoint automatically."
    )
    .addText((text) =>
      text
        .setPlaceholder("http://localhost:1234")
        .setValue(lmSettings.baseUrl)
        .onChange(async (value) => {
          const normalized = normalizeLMStudioBaseUrl(value);
          lmSettings.baseUrl = normalized;
          settings.lmStudioUrl = normalized;
          await plugin.saveSettings();
        })
    );

  new Setting(lmConnectionEl)
    .setName("Bypass CORS via Node.js")
    .setDesc(
      "Use Electron's Node.js HTTP stack instead of the browser fetch API. Avoids needing CORS enabled in LM Studio."
    )
    .addToggle((toggle) =>
      toggle.setValue(lmSettings.bypassCors).onChange(async (value) => {
        lmSettings.bypassCors = value;
        settings.bypassCors = value;
        await plugin.saveSettings();
      })
    );

  // Anthropic: info notice (API key is managed in General → Provider API Keys)
  const anthropicConnectionEl = providerContentEl.createDiv({ cls: "lmsa-provider-connection" });
  anthropicConnectionEl.createEl("p", {
    cls: "lmsa-settings-section-desc",
    text: "API key is managed in Settings → General → Provider API Keys.",
  });

  // Anthropic embedding: not-available message (shown instead of discovery)
  const anthropicNoEmbeddingEl = providerContentEl.createDiv({ cls: "lmsa-provider-anthropic-no-embed" });
  anthropicNoEmbeddingEl.createEl("p", {
    cls: "lmsa-empty-state",
    text: "Anthropic does not offer embedding models. Select a different provider, or use LM Studio with a local embedding model.",
  });

  // OpenAI: placeholder
  const openaiPlaceholderEl = providerContentEl.createDiv({ cls: "lmsa-provider-placeholder" });
  openaiPlaceholderEl.createEl("p", {
    cls: "lmsa-empty-state",
    text: "Support for this provider is coming soon.",
  });

  // ── Shared discovery UI ───────────────────────────────────────────────

  const discoveryEl = providerContentEl.createDiv({ cls: "lmsa-discovery-container" });

  const discoveryHeaderEl = discoveryEl.createDiv({ cls: "lmsa-discovery-header" });
  const refetchButton = discoveryHeaderEl.createEl("button", {
    cls: "lmsa-ui-btn lmsa-ui-btn-primary",
    text: "Refresh models",
  });

  const statusCard = discoveryEl.createDiv({
    cls: "lmsa-connection-status lmsa-settings-discovery-status is-idle",
  });
  const statusSummary = statusCard.createDiv({ cls: "lmsa-connection-status-summary" });
  const statusBadge = statusSummary.createSpan({
    cls: "lmsa-connection-status-badge",
    text: "Idle",
  });
  const statusText = statusSummary.createSpan({
    cls: "lmsa-connection-status-text",
    text: `Refresh to discover available ${config.kind} models.`,
  });
  const statusMeta = statusCard.createDiv({
    cls: "lmsa-connection-status-meta",
    text: "Saved profiles keep working regardless of provider availability.",
  });

  const liveModelsListEl = discoveryEl.createDiv({ cls: "lmsa-item-list" });
  liveModelsListEl.createEl("p", {
    cls: "lmsa-empty-state",
    text: config.emptyDiscoveryText,
  });

  const setStatus = (
    variant: "idle" | "loading" | "connected" | "error",
    badgeText: string,
    text: string,
    meta: string
  ) => {
    statusCard.removeClass("is-idle", "is-loading", "is-connected", "is-error");
    statusCard.addClass(`is-${variant}`);
    statusBadge.setText(badgeText);
    statusText.setText(text);
    statusMeta.setText(meta);
  };

  const renderLiveModels = (models: ModelDigest[]) => {
    liveModelsListEl.empty();

    if (models.length === 0) {
      liveModelsListEl.createEl("p", {
        cls: "lmsa-empty-state",
        text: config.noModelsFoundText,
      });
      return;
    }

    for (const model of models) {
      const row = liveModelsListEl.createDiv({ cls: "lmsa-item-row lmsa-live-model-row" });
      const info = row.createDiv({ cls: "lmsa-item-info" });
      const header = info.createDiv({ cls: "lmsa-live-model-header" });
      header.createDiv({ cls: "lmsa-item-name", text: model.displayName });

      if (model.isLoaded !== undefined) {
        header.createSpan({
          cls: `lmsa-model-state-badge ${model.isLoaded ? "is-loaded" : "is-unloaded"}`,
          text: model.isLoaded ? "Loaded" : "Not loaded",
        });
      }

      info.createDiv({
        cls: "lmsa-item-sub",
        text: model.targetModelId,
      });
      info.createDiv({
        cls: "lmsa-item-meta",
        text: config.formatDiscoveryMeta(model),
      });

      const alreadyConfigured = config.getModels().some(
        (item) => item.modelId === model.targetModelId
      );

      const actions = row.createDiv({ cls: "lmsa-item-actions" });
      const configureButton = actions.createEl("button", {
        cls: `lmsa-ui-btn ${alreadyConfigured ? "lmsa-btn-secondary" : "lmsa-ui-btn-primary"}`,
        text: alreadyConfigured ? "Added" : "Add as profile",
      });

      if (alreadyConfigured) {
        configureButton.disabled = true;
      } else {
        configureButton.addEventListener("click", () => {
          config.openModal(
            plugin.app,
            plugin,
            null,
            async (configuredModel) => {
              const currentModels = config.getModels();
              currentModels.push(configuredModel);
              config.setModels(currentModels);
              await plugin.saveSettings();
              new Notice(`Added ${config.profileNoun} for ${configuredModel.modelId}.`);
              refresh();
            },
            {
              name: model.displayName,
              modelId: model.targetModelId,
              provider: providerSelect.value as ProviderOption,
            } as Partial<T>
          );
        });
      }
    }
  };

  const loadLiveModels = async () => {
    const selected = providerSelect.value as ProviderOption;
    const fetcher = config.fetchCandidates[selected];
    if (!fetcher) return;

    const providerLabel = PROVIDER_LABELS[selected];

    refetchButton.disabled = true;
    setStatus(
      "loading",
      "Loading...",
      `Fetching ${config.kind} models from ${providerLabel}...`,
      "This only refreshes live discovery suggestions. Your saved profiles are unchanged."
    );
    liveModelsListEl.empty();
    liveModelsListEl.createEl("p", {
      cls: "lmsa-empty-state",
      text: "Fetching live model suggestions...",
    });

    try {
      const result = await fetcher({ forceRefresh: true });
      const reachableAt = new Date(result.discoveredAt).toLocaleTimeString();

      setStatus(
        "connected",
        "Connected",
        `${result.candidates.length} ${config.kind} model${result.candidates.length === 1 ? "" : "s"} found`,
        `Last checked at ${reachableAt} via ${providerLabel}.`
      );
      renderLiveModels(result.candidates);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const isAuthError = message.includes("401") || message.includes("key");
      const hint = isAuthError
        ? "Check your API key in Settings → General → Provider API Keys."
        : `Could not reach ${providerLabel}. Check your connection settings and try again.`;

      setStatus(
        "error",
        "Unavailable",
        `Could not load models from ${providerLabel}`,
        hint
      );
      liveModelsListEl.empty();
      liveModelsListEl.createEl("p", {
        cls: "lmsa-empty-state",
        text: "No live model data available right now.",
      });
    } finally {
      refetchButton.disabled = false;
    }
  };

  refetchButton.addEventListener("click", () => {
    void loadLiveModels();
  });

  // ── Provider switching ───────────────────────────────────────────────

  const syncProviderContent = () => {
    const selected = providerSelect.value as ProviderOption;
    const hasFetcher = selected in config.fetchCandidates;

    // Connection settings visibility
    lmConnectionEl.style.display = selected === "lmstudio" ? "" : "none";
    anthropicConnectionEl.style.display =
      selected === "anthropic" && config.kind !== "embedding" ? "" : "none";
    anthropicNoEmbeddingEl.style.display =
      selected === "anthropic" && config.kind === "embedding" ? "" : "none";
    openaiPlaceholderEl.style.display = selected === "openai" ? "" : "none";

    // Shared discovery block — visible when provider has a fetcher
    discoveryEl.style.display = hasFetcher ? "" : "none";

    // Add manually button — hidden for unsupported combos
    addManuallyBtn.style.display = hasFetcher ? "" : "none";
  };

  providerSelect.addEventListener("change", syncProviderContent);
  syncProviderContent();
}
