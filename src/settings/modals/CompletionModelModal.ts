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

  protected renderExtraFields(_contentEl: HTMLElement): void {
    // No extra fields — temperature, max tokens, and system prompt use defaults
  }
}
