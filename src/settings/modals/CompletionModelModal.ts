import { SettingItem } from "../ui";
import type { LMStudioModelsService } from "../../api";
import type { AnthropicModelsService } from "../../api/AnthropicModelsService";
import type { ModelCandidateResult, ModelDigest } from "../../api/types";
import type { CompletionModel } from "../../shared/types";
import { generateId } from "../../utils";
import { getProviderDescriptor } from "../../providers/registry";
import { ModelProfileModal } from "./ModelProfileModal";

export class CompletionModelModal extends ModelProfileModal<CompletionModel> {
  protected createDefaultModel(prefill?: Partial<CompletionModel>): CompletionModel {
    return {
      id: generateId(),
      name: prefill?.name ?? "",
      modelId: prefill?.modelId ?? "",
      provider: prefill?.provider ?? "lmstudio",
      ...(prefill?.contextWindowSize && { contextWindowSize: prefill.contextWindowSize }),
      ...(prefill?.trainedForToolUse !== undefined && { trainedForToolUse: prefill.trainedForToolUse }),
      ...(prefill?.vision !== undefined && { vision: prefill.vision }),
    };
  }

  protected onCandidateMatched(candidate: ModelDigest): void {
    if (candidate.trainedForToolUse !== undefined) {
      this.model.trainedForToolUse = candidate.trainedForToolUse;
    }
    if (candidate.vision !== undefined) {
      this.model.vision = candidate.vision;
    }
    const contextLength = candidate.activeContextLength ?? candidate.maxContextLength;
    if (contextLength) {
      this.model.contextWindowSize = contextLength;
    }
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
    const descriptor = getProviderDescriptor(this.model.provider);

    if (descriptor.kind === "cloud") {
      new SettingItem(contentEl)
        .setName("Context window (tokens)")
        .setDesc("Maximum context length for this model. Auto-filled from discovery, or set manually.")
        .addText((text) => {
          text.inputEl.type = "number";
          text.inputEl.addClass("lmsa-input-full");
          text
            .setPlaceholder("128000")
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
}
