import type { App } from "obsidian";
import { Notice } from "obsidian";
import { LMStudioModelsService } from "../api";
import type { LMStudioModelCandidateResult } from "../api/LMStudioModelsService";
import type LMStudioWritingAssistant from "../main";
import type { LMStudioModelDigest } from "../api/types";
import { createSettingsSection } from "./ui";

type BaseModel = { id: string; name: string; modelId: string };

export type ModelProfileTabConfig<T extends BaseModel> = {
  kind: string;
  profileNoun: string;
  sectionDescription: string;
  discoverySectionDescription: string;
  emptyProfilesText: string;
  emptyDiscoveryText: string;
  noModelsFoundText: string;
  getModels: () => T[];
  setModels: (models: T[]) => void;
  renderItemMeta?: (model: T) => string | null;
  formatDiscoveryMeta: (model: LMStudioModelDigest) => string;
  openModal: (
    app: App,
    plugin: LMStudioWritingAssistant,
    source: T | null,
    onSave: (model: T) => void,
    prefill?: Partial<T>
  ) => void;
  getCandidates: (
    service: LMStudioModelsService,
    options: { forceRefresh: boolean }
  ) => Promise<LMStudioModelCandidateResult>;
};

export function renderModelProfileTab<T extends BaseModel>(
  container: HTMLElement,
  plugin: LMStudioWritingAssistant,
  refresh: () => void,
  config: ModelProfileTabConfig<T>
): void {
  const { settings } = plugin;
  const modelsService = new LMStudioModelsService(settings.lmStudioUrl, settings.bypassCors);

  // ── Saved Profiles section ──────────────────────────────────────────

  const library = createSettingsSection(
    container,
    "Saved Profiles",
    config.sectionDescription
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

  library.footerEl
    .createEl("button", {
      cls: "lmsa-btn-add lmsa-ui-btn lmsa-ui-btn-primary",
      text: "Add profile",
    })
    .addEventListener("click", () => {
      config.openModal(plugin.app, plugin, null, async (model) => {
        const currentModels = config.getModels();
        currentModels.push(model);
        config.setModels(currentModels);
        await plugin.saveSettings();
        refresh();
      });
    });

  // ── Discover from LM Studio section ─────────────────────────────────

  const discovery = createSettingsSection(
    container,
    "Discover from LM Studio",
    config.discoverySectionDescription
  );

  const refetchButton = discovery.headerActionsEl.createEl("button", {
    cls: "lmsa-ui-btn lmsa-ui-btn-primary",
    text: "Refresh models",
  });

  const statusCard = discovery.bodyEl.createDiv({
    cls: "lmsa-connection-status lmsa-settings-discovery-status is-idle",
  });
  const statusSummary = statusCard.createDiv({ cls: "lmsa-connection-status-summary" });
  const statusBadge = statusSummary.createSpan({
    cls: "lmsa-connection-status-badge",
    text: "Idle",
  });
  const statusText = statusSummary.createSpan({
    cls: "lmsa-connection-status-text",
    text: `Load ${config.kind} models from LM Studio when you need them.`,
  });
  const statusMeta = statusCard.createDiv({
    cls: "lmsa-connection-status-meta",
    text: "Saved profiles keep working even when LM Studio is offline.",
  });

  const liveModelsListEl = discovery.bodyEl.createDiv({ cls: "lmsa-item-list" });
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

  const renderLiveModels = (models: LMStudioModelDigest[]) => {
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
      header.createSpan({
        cls: `lmsa-model-state-badge ${model.isLoaded ? "is-loaded" : "is-unloaded"}`,
        text: model.isLoaded ? "Loaded" : "Not loaded",
      });

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
            } as Partial<T>
          );
        });
      }
    }
  };

  const loadLiveModels = async () => {
    refetchButton.disabled = true;
    setStatus(
      "loading",
      "Loading...",
      `Fetching ${config.kind} models from LM Studio...`,
      "This only refreshes live discovery suggestions. Your saved profiles are unchanged."
    );
    liveModelsListEl.empty();
    liveModelsListEl.createEl("p", {
      cls: "lmsa-empty-state",
      text: "Fetching live model suggestions...",
    });

    try {
      const result = await config.getCandidates(modelsService, { forceRefresh: true });
      const reachableAt = new Date(result.discoveredAt).toLocaleTimeString();
      const transport =
        result.source === "native"
          ? "the native LM Studio API"
          : "the OpenAI-compatible LM Studio API";

      setStatus(
        "connected",
        "Connected",
        `${result.candidates.length} ${config.kind} model${result.candidates.length === 1 ? "" : "s"} found`,
        `Last checked at ${reachableAt} through ${transport}. Loaded models appear first.`
      );
      renderLiveModels(result.candidates);
    } catch {
      setStatus(
        "error",
        "Unavailable",
        "Could not load models from LM Studio",
        "Check the LM Studio URL in General settings, make sure the local server is running, and try again."
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
}
