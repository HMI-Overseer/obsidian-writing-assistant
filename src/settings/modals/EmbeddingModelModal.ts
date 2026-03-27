import type { App } from "obsidian";
import { Modal, Notice, Setting } from "obsidian";
import type LMStudioWritingAssistant from "../../main";
import { LMStudioModelsService } from "../../api";
import type { EmbeddingModel } from "../../shared/types";
import { generateId } from "../../utils";

type EmbeddingModelPrefill = Partial<Pick<EmbeddingModel, "name" | "modelId">>;

export class EmbeddingModelModal extends Modal {
  private model: EmbeddingModel;

  constructor(
    app: App,
    private plugin: LMStudioWritingAssistant,
    source: EmbeddingModel | null,
    private onSave: (model: EmbeddingModel) => void,
    prefill?: EmbeddingModelPrefill
  ) {
    super(app);
    this.model = source
      ? { ...source, ...prefill }
      : {
          id: generateId(),
          name: prefill?.name ?? "",
          modelId: prefill?.modelId ?? "",
        };
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
      .setDesc("The embedding model ID or selected variant reported by LM Studio.")
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
        const modelsService = new LMStudioModelsService(
          this.plugin.settings.lmStudioUrl,
          this.plugin.settings.bypassCors
        );
        const result = await modelsService.getEmbeddingCandidates();

        for (const model of result.candidates) {
          const option = document.createElement("option");
          option.value = model.targetModelId;
          option.label = `${model.displayName} (${model.targetModelId})`;
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
