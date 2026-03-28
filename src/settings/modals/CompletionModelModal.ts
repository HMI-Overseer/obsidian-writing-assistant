import { Setting } from "obsidian";
import type { LMStudioModelsService } from "../../api";
import type { LMStudioModelCandidateResult } from "../../api/LMStudioModelsService";
import type { CompletionModel } from "../../shared/types";
import { DEFAULT_SYSTEM_PROMPT } from "../../constants";
import { generateId } from "../../utils";
import { ModelProfileModal } from "./ModelProfileModal";

export class CompletionModelModal extends ModelProfileModal<CompletionModel> {
  protected createDefaultModel(prefill?: Partial<CompletionModel>): CompletionModel {
    return {
      id: generateId(),
      name: prefill?.name ?? "",
      modelId: prefill?.modelId ?? "",
      systemPrompt: prefill?.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
      temperature: prefill?.temperature ?? 0.7,
      maxTokens: prefill?.maxTokens ?? 2000,
    };
  }

  protected getDatalistId(): string {
    return "lmsa-completion-models-list";
  }

  protected getCandidates(
    service: LMStudioModelsService
  ): Promise<LMStudioModelCandidateResult> {
    return service.getCompletionCandidates();
  }

  protected renderExtraFields(contentEl: HTMLElement): void {
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
  }
}
