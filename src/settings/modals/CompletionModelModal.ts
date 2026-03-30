import { Setting } from "obsidian";
import type { LMStudioModelsService } from "../../api";
import type { AnthropicModelsService } from "../../api/AnthropicModelsService";
import type { ModelCandidateResult } from "../../api/types";
import type { CompletionModel } from "../../shared/types";
import { generateId } from "../../utils";
import { ModelProfileModal } from "./ModelProfileModal";

export class CompletionModelModal extends ModelProfileModal<CompletionModel> {
  protected createDefaultModel(prefill?: Partial<CompletionModel>): CompletionModel {
    return {
      id: generateId(),
      name: prefill?.name ?? "",
      modelId: prefill?.modelId ?? "",
      provider: prefill?.provider ?? "lmstudio",
      ...(prefill?.contextWindowSize && { contextWindowSize: prefill.contextWindowSize }),
    };
  }

  protected getDatalistId(): string {
    return "lmsa-completion-models-list";
  }

  protected getLMStudioCandidates(
    service: LMStudioModelsService
  ): Promise<ModelCandidateResult> {
    return service.getCompletionCandidates();
  }

  protected getAnthropicCandidates(
    service: AnthropicModelsService
  ): Promise<ModelCandidateResult> {
    return service.getCompletionCandidates();
  }

  protected renderExtraFields(contentEl: HTMLElement): void {
    new Setting(contentEl)
      .setName("Context window (tokens)")
      .setDesc("Maximum context length for this model. Auto-filled from discovery, or set manually.")
      .addText((text) => {
        text.inputEl.type = "number";
        text.inputEl.style.width = "100%";
        text
          .setPlaceholder("e.g. 128000")
          .setValue(this.model.contextWindowSize ? String(this.model.contextWindowSize) : "")
          .onChange((value) => {
            const parsed = parseInt(value, 10);
            if (parsed > 0) {
              this.model.contextWindowSize = parsed;
            } else {
              delete this.model.contextWindowSize;
            }
          });
      });
  }
}
