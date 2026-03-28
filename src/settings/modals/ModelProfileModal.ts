import type { App } from "obsidian";
import { Modal, Notice, Setting } from "obsidian";
import type LMStudioWritingAssistant from "../../main";
import { LMStudioModelsService } from "../../api";
import type { LMStudioModelCandidateResult } from "../../api/LMStudioModelsService";

type BaseModel = { id: string; name: string; modelId: string };

export abstract class ModelProfileModal<T extends BaseModel> extends Modal {
  protected model: T;

  constructor(
    app: App,
    protected plugin: LMStudioWritingAssistant,
    source: T | null,
    private onSave: (model: T) => void,
    prefill?: Partial<T>
  ) {
    super(app);
    this.model = source
      ? { ...source, ...prefill }
      : this.createDefaultModel(prefill);
  }

  protected abstract createDefaultModel(prefill?: Partial<T>): T;
  protected abstract getDatalistId(): string;
  protected abstract getCandidates(
    service: LMStudioModelsService
  ): Promise<LMStudioModelCandidateResult>;
  protected abstract renderExtraFields(contentEl: HTMLElement): void;

  async onOpen(): Promise<void> {
    const { contentEl } = this;
    contentEl.addClass("lmsa-modal");
    contentEl.createEl("h2", {
      text: this.model.name ? `Edit: ${this.model.name}` : "Add Model",
    });

    const datalistId = this.getDatalistId();
    const datalist = document.createElement("datalist");
    datalist.id = datalistId;
    contentEl.appendChild(datalist);

    new Setting(contentEl)
      .setName("Display name")
      .setDesc("A label for this reusable model profile.")
      .addText((text) =>
        text
          .setPlaceholder("e.g. My Profile")
          .setValue(this.model.name)
          .onChange((value) => (this.model.name = value))
      );

    new Setting(contentEl)
      .setName("Model ID")
      .setDesc("The selected LM Studio model or variant this profile should target.")
      .addText((text) => {
        text.inputEl.setAttribute("list", datalistId);
        text.inputEl.style.width = "100%";
        text
          .setPlaceholder("e.g. model-id")
          .setValue(this.model.modelId)
          .onChange((value) => (this.model.modelId = value));
      });

    void (async () => {
      try {
        const modelsService = new LMStudioModelsService(
          this.plugin.settings.lmStudioUrl,
          this.plugin.settings.bypassCors
        );
        const result = await this.getCandidates(modelsService);

        for (const model of result.candidates) {
          const option = document.createElement("option");
          option.value = model.targetModelId;
          option.label = `${model.displayName || model.targetModelId} (${model.targetModelId})`;
          datalist.appendChild(option);
        }
      } catch {
        /* LM Studio may be offline while editing settings. */
      }
    })();

    this.renderExtraFields(contentEl);

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
