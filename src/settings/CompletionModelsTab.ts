import { Notice, Setting } from "obsidian";
import { LMStudioClient } from "../api";
import type LMStudioWritingAssistant from "../main";
import type { LMStudioModel, LMStudioQuantization } from "../shared/types";
import { CompletionModelModal } from "./modals";
import { createSettingsSection } from "./ui";

function formatContextLength(value?: number): string {
  if (!value || value <= 0) return "Context window unavailable";
  return `${value.toLocaleString()} tokens context`;
}

function formatQuantization(quantization?: LMStudioQuantization): string | null {
  if (!quantization) return null;
  if (quantization.bitsPerWeight && quantization.name) {
    return `${quantization.name} (${quantization.bitsPerWeight}-bit)`;
  }
  return quantization.name ?? null;
}

function prettifyModelState(state: LMStudioModel["state"]): string {
  return state === "loaded" ? "Loaded" : "Available";
}

function deriveDisplayName(modelId: string): string {
  const tail = modelId.split("/").pop() ?? modelId;
  return tail
    .split(/[-_@.]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function getDisplayName(model: LMStudioModel): string {
  return model.displayName || deriveDisplayName(model.id);
}

function getCapabilitySummary(model: LMStudioModel): string | null {
  const capabilities: string[] = [];

  if (model.capabilities?.vision) {
    capabilities.push("Vision");
  }
  if (model.capabilities?.trainedForToolUse) {
    capabilities.push("Tool use");
  }

  return capabilities.length > 0 ? capabilities.join(" | ") : null;
}

function getLoadedSummary(model: LMStudioModel): string | null {
  if (model.loadedInstances.length === 0) return null;

  const contextLengths = model.loadedInstances
    .map((instance) => instance.config?.contextLength)
    .filter((value): value is number => typeof value === "number" && value > 0);

  if (contextLengths.length === 0) {
    return `${model.loadedInstances.length} loaded instance${model.loadedInstances.length === 1 ? "" : "s"}`;
  }

  return `${contextLengths[0].toLocaleString()} tokens active`;
}

export function renderCompletionModelsTab(
  container: HTMLElement,
  plugin: LMStudioWritingAssistant,
  refresh: () => void
): void {
  const { settings } = plugin;
  const client = new LMStudioClient(settings.lmStudioUrl, settings.bypassCors);
  const nativeModelsUrl = `${client.getResolvedNativeApiBaseUrl()}/models`;
  const openAIModelsUrl = `${client.getResolvedBaseUrl()}/models`;

  const status = createSettingsSection(
    container,
    "LM Studio Status",
    "Check whether LM Studio is reachable, inspect live model metadata, and re-fetch the available model list on demand."
  );

  const statusCard = status.bodyEl.createDiv({
    cls: "lmsa-connection-status is-loading",
  });
  const statusSummary = statusCard.createDiv({ cls: "lmsa-connection-status-summary" });
  const statusBadge = statusSummary.createSpan({
    cls: "lmsa-connection-status-badge",
    text: "Checking...",
  });
  const statusText = statusSummary.createSpan({
    cls: "lmsa-connection-status-text",
    text: "Contacting the LM Studio API...",
  });
  const statusMeta = statusCard.createDiv({
    cls: "lmsa-connection-status-meta",
    text: "This verifies that LM Studio is running and the configured API URL is reachable.",
  });

  const liveModelsSection = createSettingsSection(
    container,
    "Available Models",
    "Live models reported by LM Studio. Use these to generate reusable completion profiles without relying on hard-coded defaults."
  );
  const liveModelsListEl = liveModelsSection.bodyEl.createDiv({ cls: "lmsa-item-list" });

  const refetchButton = status.footerEl.createEl("button", {
    cls: "lmsa-ui-btn lmsa-ui-btn-primary",
    text: "Re-fetch",
  });

  const setStatus = (
    variant: "loading" | "connected" | "error",
    badgeText: string,
    text: string,
    meta: string
  ) => {
    statusCard.removeClass("is-loading", "is-connected", "is-error");
    statusCard.addClass(`is-${variant}`);
    statusBadge.setText(badgeText);
    statusText.setText(text);
    statusMeta.setText(meta);
  };

  const renderLiveModels = (models: LMStudioModel[]) => {
    liveModelsListEl.empty();

    const completionCandidates = models
      .filter((model) => !model.type || model.type === "llm")
      .sort((left, right) => {
        if (left.isLoaded !== right.isLoaded) {
          return left.isLoaded ? -1 : 1;
        }
        return getDisplayName(left).localeCompare(getDisplayName(right));
      });

    if (completionCandidates.length === 0) {
      liveModelsListEl.createEl("p", {
        cls: "lmsa-empty-state",
        text: "LM Studio responded, but no completion-capable models were reported.",
      });
      return;
    }

    for (const model of completionCandidates) {
      const row = liveModelsListEl.createDiv({ cls: "lmsa-item-row lmsa-live-model-row" });
      const info = row.createDiv({ cls: "lmsa-item-info" });
      const header = info.createDiv({ cls: "lmsa-live-model-header" });
      header.createDiv({ cls: "lmsa-item-name", text: getDisplayName(model) });
      header.createSpan({
        cls: `lmsa-model-state-badge ${model.isLoaded ? "is-loaded" : "is-unloaded"}`,
        text: prettifyModelState(model.state),
      });

      info.createDiv({
        cls: "lmsa-item-sub",
        text: model.id,
      });

      const details = [
        model.publisher ?? model.ownedBy,
        model.architecture,
        formatQuantization(model.quantization),
        model.paramsString ?? undefined,
        model.format,
      ]
        .filter(Boolean)
        .join(" | ");

      info.createDiv({
        cls: "lmsa-item-meta",
        text: details || "LM Studio did not provide extra model metadata.",
      });

      const secondaryMeta = [
        formatContextLength(model.maxContextLength),
        model.selectedVariant && model.selectedVariant !== model.id
          ? `Selected variant: ${model.selectedVariant}`
          : null,
        getLoadedSummary(model),
        getCapabilitySummary(model),
      ]
        .filter(Boolean)
        .join(" | ");

      if (secondaryMeta) {
        info.createDiv({
          cls: "lmsa-item-meta",
          text: secondaryMeta,
        });
      }

      const alreadyConfigured = settings.completionModels.some(
        (item) => item.modelId === model.id
      );

      const actions = row.createDiv({ cls: "lmsa-item-actions" });
      const configureButton = actions.createEl("button", {
        cls: `lmsa-ui-btn ${alreadyConfigured ? "lmsa-btn-secondary" : "lmsa-ui-btn-primary"}`,
        text: alreadyConfigured ? "Configured" : "Add as profile",
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
              name: getDisplayName(model),
              modelId: model.id,
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
      "Checking...",
      "Contacting the LM Studio API...",
      "This verifies that LM Studio is running and the configured API URL is reachable."
    );
    liveModelsListEl.empty();
    liveModelsListEl.createEl("p", {
      cls: "lmsa-empty-state",
      text: "Fetching available models from LM Studio...",
    });

    try {
      const result = await client.listModelsWithSource();
      const reachableAt = new Date().toLocaleTimeString();
      const completionCount = result.models.filter(
        (model) => !model.type || model.type === "llm"
      ).length;
      const endpointDescription =
        result.source === "native"
          ? result.endpoint
          : `${result.endpoint} after native discovery fell back`;

      setStatus(
        "connected",
        "Connected",
        `${completionCount} completion model${completionCount === 1 ? "" : "s"} available`,
        `Last checked at ${reachableAt}. LM Studio responded successfully via ${endpointDescription}.`
      );
      renderLiveModels(result.models);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStatus(
        "error",
        "Unreachable",
        "Could not reach the LM Studio API",
        `${message} (Native: ${nativeModelsUrl}; OpenAI fallback: ${openAIModelsUrl})`
      );
      liveModelsListEl.empty();
      liveModelsListEl.createEl("p", {
        cls: "lmsa-empty-state",
        text: "No live model data available. Check the LM Studio URL, verify the local server is enabled, and try re-fetching.",
      });
    } finally {
      refetchButton.disabled = false;
    }
  };

  refetchButton.addEventListener("click", () => {
    void loadLiveModels();
  });

  const activeProfile = createSettingsSection(
    container,
    "Default Chat Profile",
    "Choose which completion profile the chat view should reach for first when you start a conversation."
  );

  new Setting(activeProfile.bodyEl)
    .setName("Active model")
    .setDesc("This profile is used by default when you send a chat message.")
    .addDropdown((dropdown) => {
      for (const model of settings.completionModels) {
        dropdown.addOption(model.id, model.name);
      }
      dropdown.setValue(settings.activeCompletionModelId);
      dropdown.onChange(async (value) => {
        settings.activeCompletionModelId = value;
        await plugin.saveSettings();
      });
    });

  const library = createSettingsSection(
    container,
    "Profile Library",
    "Reusable profiles with their own system prompt, model target, temperature, and token limit."
  );

  const listEl = library.bodyEl.createDiv({ cls: "lmsa-item-list" });

  const renderList = () => {
    listEl.empty();
    if (settings.completionModels.length === 0) {
      listEl.createEl("p", {
        cls: "lmsa-empty-state",
        text: "No completion models configured.",
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
        text: `Temp ${model.temperature.toFixed(2)} | Max tokens ${model.maxTokens}`,
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

      const deleteButton = actions.createEl("button", {
        cls: "lmsa-btn-danger lmsa-ui-btn",
        text: "Delete",
      });
      deleteButton.disabled = settings.completionModels.length <= 1;
      deleteButton.addEventListener("click", async () => {
        settings.completionModels = settings.completionModels.filter(
          (item) => item.id !== model.id
        );
        if (settings.activeCompletionModelId === model.id) {
          settings.activeCompletionModelId = settings.completionModels[0].id;
        }
        await plugin.saveSettings();
        refresh();
      });
    }
  };

  renderList();

  library.footerEl
    .createEl("button", {
      cls: "lmsa-btn-add lmsa-ui-btn lmsa-ui-btn-primary",
      text: "Add model",
    })
    .addEventListener("click", () => {
      new CompletionModelModal(plugin.app, plugin, null, async (model) => {
        settings.completionModels.push(model);
        await plugin.saveSettings();
        refresh();
      }).open();
    });

  void loadLiveModels();
}
