import type { LMStudioModelsService } from "../../api";
import type { LMStudioModelCandidateResult } from "../../api/LMStudioModelsService";
import type { CompletionModel } from "../../shared/types";
import { generateId } from "../../utils";
import { ModelProfileModal } from "./ModelProfileModal";

export class CompletionModelModal extends ModelProfileModal<CompletionModel> {
  protected createDefaultModel(prefill?: Partial<CompletionModel>): CompletionModel {
    return {
      id: generateId(),
      name: prefill?.name ?? "",
      modelId: prefill?.modelId ?? "",
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

  protected renderExtraFields(_contentEl: HTMLElement): void {
    // No extra fields — temperature, max tokens, and system prompt use defaults
  }
}
