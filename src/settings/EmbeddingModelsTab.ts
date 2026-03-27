import type LMStudioWritingAssistant from "../main";
import { EmbeddingModelModal } from "./modals";
import { createSettingsSection } from "./ui";

export function renderEmbeddingModelsTab(
  container: HTMLElement,
  plugin: LMStudioWritingAssistant,
  refresh: () => void
): void {
  const { settings } = plugin;

  const library = createSettingsSection(
    container,
    "Embedding Profiles",
    "Reserve these profiles for semantic search, retrieval, and future note-aware features."
  );

  const listEl = library.bodyEl.createDiv({ cls: "lmsa-item-list" });

  const renderList = () => {
    listEl.empty();
    if (settings.embeddingModels.length === 0) {
      listEl.createEl("p", {
        cls: "lmsa-empty-state",
        text: "No embedding models configured.",
      });
      return;
    }

    for (const model of settings.embeddingModels) {
      const row = listEl.createDiv({ cls: "lmsa-item-row" });
      const info = row.createDiv({ cls: "lmsa-item-info" });
      info.createDiv({ cls: "lmsa-item-name", text: model.name });
      info.createDiv({ cls: "lmsa-item-sub", text: model.modelId });

      const actions = row.createDiv({ cls: "lmsa-item-actions" });
      actions
        .createEl("button", {
          cls: "lmsa-btn-secondary lmsa-ui-btn lmsa-ui-btn-secondary",
          text: "Edit",
        })
        .addEventListener("click", () => {
          new EmbeddingModelModal(plugin.app, plugin, model, async (updated) => {
            const index = settings.embeddingModels.findIndex((item) => item.id === updated.id);
            if (index >= 0) settings.embeddingModels[index] = updated;
            await plugin.saveSettings();
            renderList();
          }).open();
        });

      actions
        .createEl("button", { cls: "lmsa-btn-danger lmsa-ui-btn", text: "Delete" })
        .addEventListener("click", async () => {
          settings.embeddingModels = settings.embeddingModels.filter(
            (item) => item.id !== model.id
          );
          await plugin.saveSettings();
          refresh();
        });
    }
  };

  renderList();

  library.footerEl
    .createEl("button", {
      cls: "lmsa-btn-add lmsa-ui-btn lmsa-ui-btn-primary",
      text: "Add embedding model",
    })
    .addEventListener("click", () => {
      new EmbeddingModelModal(plugin.app, plugin, null, async (model) => {
        settings.embeddingModels.push(model);
        await plugin.saveSettings();
        refresh();
      }).open();
    });
}
