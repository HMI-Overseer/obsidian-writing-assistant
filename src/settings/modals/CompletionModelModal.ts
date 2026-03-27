import type { App } from "obsidian";
import { Modal, Notice, Setting } from "obsidian";
import type LMStudioWritingAssistant from "../../main";
import { LMStudioModelsService } from "../../api";
import type { CompletionModel, LMStudioModelDigest } from "../../shared/types";
import { DEFAULT_SYSTEM_PROMPT } from "../../constants";
import { generateId } from "../../utils";

type CompletionModelPrefill = Partial<
  Pick<CompletionModel, "name" | "modelId" | "maxTokens" | "systemPrompt" | "temperature">
>;

function getDisplayName(model: LMStudioModelDigest): string {
  return model.displayName || model.targetModelId;
}

export class CompletionModelModal extends Modal {
  private model: CompletionModel;

  constructor(
    app: App,
    private plugin: LMStudioWritingAssistant,
    source: CompletionModel | null,
    private onSave: (model: CompletionModel) => void,
    prefill?: CompletionModelPrefill
  ) {
    super(app);
    this.model = source
      ? { ...source, ...prefill }
      : {
          id: generateId(),
          name: prefill?.name ?? "",
          modelId: prefill?.modelId ?? "",
          systemPrompt: prefill?.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
          temperature: prefill?.temperature ?? 0.7,
          maxTokens: prefill?.maxTokens ?? 2000,
        };
  }

  async onOpen(): Promise<void> {
    const { contentEl } = this;
    contentEl.addClass("lmsa-modal");
    contentEl.createEl("h2", {
      text: this.model.name ? `Edit: ${this.model.name}` : "Add Completion Model",
    });

    const datalistId = "lmsa-completion-models-list";
    const datalist = document.createElement("datalist");
    datalist.id = datalistId;
    contentEl.appendChild(datalist);

    new Setting(contentEl)
      .setName("Display name")
      .setDesc("A label for this reusable model profile.")
      .addText((text) =>
        text
          .setPlaceholder("e.g. Creative Writer")
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
          .setPlaceholder("e.g. mistralai/magistral-small-2509@q4_k_m")
          .setValue(this.model.modelId)
          .onChange((value) => (this.model.modelId = value));
      });

    void (async () => {
      try {
        const modelsService = new LMStudioModelsService(
          this.plugin.settings.lmStudioUrl,
          this.plugin.settings.bypassCors
        );
        const result = await modelsService.getCompletionCandidates();

        for (const model of result.candidates) {
          const option = document.createElement("option");
          option.value = model.targetModelId;
          option.label = `${getDisplayName(model)} (${model.targetModelId})`;
          datalist.appendChild(option);
        }
      } catch {
        /* LM Studio may be offline while editing settings. */
      }
    })();

    new Setting(contentEl)
      .setName("Temperature")
      .setDesc("0 = focused and deterministic, 1 = more exploratory.")
      .addSlider((slider) =>
        slider
          .setLimits(0, 1, 0.05)
          .setValue(this.model.temperature)
          .setDynamicTooltip()
          .onChange((value) => (this.model.temperature = value))
      );

    new Setting(contentEl)
      .setName("Max tokens")
      .setDesc("Maximum number of tokens the model can return.")
      .addText((text) =>
        text
          .setPlaceholder("2000")
          .setValue(String(this.model.maxTokens))
          .onChange((value) => {
            const parsed = parseInt(value, 10);
            if (!Number.isNaN(parsed) && parsed > 0) {
              this.model.maxTokens = parsed;
            }
          })
      );

    new Setting(contentEl)
      .setName("System prompt")
      .setDesc("Instructions sent to the model before each conversation turn.")
      .addTextArea((text) => {
        text
          .setValue(this.model.systemPrompt)
          .onChange((value) => (this.model.systemPrompt = value));
        text.inputEl.rows = 6;
        text.inputEl.style.width = "100%";
      });

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
