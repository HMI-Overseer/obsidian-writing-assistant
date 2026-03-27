import type { App } from "obsidian";
import { Modal, Notice, Setting } from "obsidian";
import type LMStudioWritingAssistant from "../../main";
import { LMStudioClient } from "../../api";
import type { EmbeddingModel } from "../../shared/types";
import { generateId } from "../../utils";

export class EmbeddingModelModal extends Modal {
  private model: EmbeddingModel;

  constructor(
    app: App,
    private plugin: LMStudioWritingAssistant,
    source: EmbeddingModel | null,
    private onSave: (model: EmbeddingModel) => void
  ) {
    super(app);
    this.model = source ? { ...source } : { id: generateId(), name: "", modelId: "" };
  }

  async onOpen(): Promise<void> {
    const { contentEl } = this;
    contentEl.addClass("lmsa-modal");
    contentEl.createEl("h2", {
      text: this.model.name ? `Edit: ${this.model.name}` : "Add Embedding Model",
    });

    const datalistId = "lmsa-embedding-models-list";
    const datalist = document.createElement("datalist");
    datalist.id = datalistId;
    contentEl.appendChild(datalist);

    new Setting(contentEl).setName("Display name").addText((text) =>
      text
        .setPlaceholder("e.g. Nomic Embed")
        .setValue(this.model.name)
        .onChange((value) => (this.model.name = value))
    );

    new Setting(contentEl)
      .setName("Model ID")
      .setDesc("The embedding model ID as shown in LM Studio.")
      .addText((text) => {
        text.inputEl.setAttribute("list", datalistId);
        text.inputEl.style.width = "100%";
        text
          .setPlaceholder("e.g. text-embedding-nomic-embed-text-v1.5@f32")
          .setValue(this.model.modelId)
          .onChange((value) => (this.model.modelId = value));
      });

    void (async () => {
      try {
        const client = new LMStudioClient(
          this.plugin.settings.lmStudioUrl,
          this.plugin.settings.bypassCors
        );
        const allModels = await client.listModels();
        const embeddings = allModels.filter(
          (model) =>
            model.type === "embedding" ||
            model.type === "embeddings" ||
            model.id.includes("embed") ||
            model.id.includes("embedding") ||
            model.id.includes("e5") ||
            model.id.includes("bge")
        );

        for (const model of embeddings.length > 0 ? embeddings : allModels) {
          const option = document.createElement("option");
          option.value = model.id;
          option.label = model.displayName ? `${model.displayName} (${model.id})` : model.id;
          datalist.appendChild(option);
        }
      } catch {
        /* LM Studio may be offline while editing settings. */
      }
    })();

    new Setting(contentEl)
      .addButton((button) => button.setButtonText("Cancel").onClick(() => this.close()))
      .addButton((button) =>
        button
          .setButtonText("Save")
          .setCta()
          .onClick(() => {
            if (!this.model.name.trim()) {
              new Notice("Please enter a display name.");
              return;
            }
            if (!this.model.modelId.trim()) {
              new Notice("Please enter a model ID.");
              return;
            }
            this.onSave(this.model);
            this.close();
          })
      );
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
