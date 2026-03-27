import { Notice } from "obsidian";
import { LMStudioModelsService } from "../api";
import type LMStudioWritingAssistant from "../main";
import type { LMStudioModelDigest } from "../shared/types";
import { CompletionModelModal } from "./modals";
import { createSettingsSection } from "./ui";

function formatContextLength(value?: number): string {
  if (!value || value <= 0) return "Context window unavailable";
  return `${value.toLocaleString()} max context tokens`;
}

function formatDiscoveryContext(model: LMStudioModelDigest): string {
  if (model.activeContextLength && model.activeContextLength > 0) {
    return `${model.activeContextLength.toLocaleString()} tokens active`;
  }

  return formatContextLength(model.maxContextLength);
}

export function renderCompletionModelsTab(
  container: HTMLElement,
  plugin: LMStudioWritingAssistant,
  refresh: () => void
): void {
  const { settings } = plugin;
  const modelsService = new LMStudioModelsService(settings.lmStudioUrl, settings.bypassCors);

  const library = createSettingsSection(
    container,
    "Saved Profiles",
    "Reusable chat profiles with their own target model, system prompt, temperature, and token limit."
  );

  const listEl = library.bodyEl.createDiv({ cls: "lmsa-item-list" });

  const renderList = () => {
    listEl.empty();
    if (settings.completionModels.length === 0) {
      listEl.createEl("p", {
        cls: "lmsa-empty-state",
        text: "No completion profiles configured yet.",
      });
      return;
    }

    for (const model of settings.completionModels) {
      const row = listEl.createDiv({ cls: "lmsa-item-row" });
      const info = row.createDiv({ cls: "lmsa-item-info" });
      info.createDiv({ cls: "lmsa-item-name", text: model.name });
      info.createDiv({ cls: "lmsa-item-sub", text: model.modelId });
      info.createDiv({
        cls: "lmsa-item-meta",
        text: `Temperature ${model.temperature.toFixed(2)} | Max tokens ${model.maxTokens}`,
      });

      const actions = row.createDiv({ cls: "lmsa-item-actions" });
      actions
        .createEl("button", {
          cls: "lmsa-btn-secondary lmsa-ui-btn lmsa-ui-btn-secondary",
          text: "Edit",
        })
        .addEventListener("click", () => {
          new CompletionModelModal(plugin.app, plugin, model, async (updated) => {
            const index = settings.completionModels.findIndex((item) => item.id === updated.id);
            if (index >= 0) settings.completionModels[index] = updated;
            await plugin.saveSettings();
            renderList();
          }).open();
        });

      actions
        .createEl("button", {
          cls: "lmsa-btn-danger lmsa-ui-btn",
          text: "Delete",
        })
        .addEventListener("click", async () => {
          settings.completionModels = settings.completionModels.filter((item) => item.id !== model.id);
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
      new CompletionModelModal(plugin.app, plugin, null, async (model) => {
        settings.completionModels.push(model);
        await plugin.saveSettings();
        refresh();
      }).open();
    });

  const discovery = createSettingsSection(
    container,
    "Discover from LM Studio",
    "Load live model suggestions from LM Studio when you want to create or update a completion profile."
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
    text: "Load completion models from LM Studio when you need them.",
  });
  const statusMeta = statusCard.createDiv({
    cls: "lmsa-connection-status-meta",
    text: "Saved profiles keep working even when LM Studio is offline.",
  });

  const liveModelsListEl = discovery.bodyEl.createDiv({ cls: "lmsa-item-list" });
  liveModelsListEl.createEl("p", {
    cls: "lmsa-empty-state",
    text: "No live model data loaded yet. Use Refresh models to fetch suggestions from LM Studio.",
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
        text: "LM Studio responded, but no completion-ready models were reported.",
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
        text: formatDiscoveryContext(model),
      });

      const alreadyConfigured = settings.completionModels.some(
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
          new CompletionModelModal(
            plugin.app,
            plugin,
            null,
            async (configuredModel) => {
              settings.completionModels.push(configuredModel);
              await plugin.saveSettings();
              new Notice(`Added completion profile for ${configuredModel.modelId}.`);
              refresh();
            },
            {
              name: model.displayName,
              modelId: model.targetModelId,
            }
          ).open();
        });
      }
    }
  };

  const loadLiveModels = async () => {
    refetchButton.disabled = true;
    setStatus(
      "loading",
      "Loading...",
      "Fetching completion models from LM Studio...",
      "This only refreshes live discovery suggestions. Your saved profiles are unchanged."
    );
    liveModelsListEl.empty();
    liveModelsListEl.createEl("p", {
      cls: "lmsa-empty-state",
      text: "Fetching live model suggestions...",
    });

    try {
      const result = await modelsService.getCompletionCandidates({ forceRefresh: true });
      const reachableAt = new Date(result.discoveredAt).toLocaleTimeString();
      const transport =
        result.source === "native" ? "the native LM Studio API" : "the OpenAI-compatible LM Studio API";

      setStatus(
        "connected",
        "Connected",
        `${result.candidates.length} completion model${result.candidates.length === 1 ? "" : "s"} found`,
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
