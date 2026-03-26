import { Setting } from "obsidian";
import type LMStudioWritingAssistant from "../main";
import { CompletionModelModal } from "./modals";

export function renderCompletionModelsTab(
  container: HTMLElement,
  plugin: LMStudioWritingAssistant,
  refresh: () => void
): void {
  const { settings } = plugin;

  container.createEl("p", {
    cls: "lmsa-tab-desc",
    text: "Create reusable model profiles with their own prompt, temperature, and token limits.",
  });

  new Setting(container)
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

  container.createEl("hr", { cls: "lmsa-divider" });
  const listEl = container.createDiv({ cls: "lmsa-item-list" });

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
        .createEl("button", { cls: "lmsa-btn-secondary", text: "Edit" })
        .addEventListener("click", () => {
          new CompletionModelModal(plugin.app, plugin, model, async (updated) => {
            const index = settings.completionModels.findIndex((item) => item.id === updated.id);
            if (index >= 0) settings.completionModels[index] = updated;
            await plugin.saveSettings();
            renderList();
          }).open();
        });

      const deleteButton = actions.createEl("button", {
        cls: "lmsa-btn-danger",
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

  container
    .createEl("button", { cls: "lmsa-btn-add", text: "+ Add model" })
    .addEventListener("click", () => {
      new CompletionModelModal(plugin.app, plugin, null, async (model) => {
        settings.completionModels.push(model);
        await plugin.saveSettings();
        refresh();
      }).open();
    });
}
