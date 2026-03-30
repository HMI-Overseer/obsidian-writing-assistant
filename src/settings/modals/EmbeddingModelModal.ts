import type { LMStudioModelsService } from "../../api";
import type { AnthropicModelsService } from "../../api/AnthropicModelsService";
import type { ModelCandidateResult } from "../../api/types";
import type { EmbeddingModel } from "../../shared/types";
import { generateId } from "../../utils";
import { ModelProfileModal } from "./ModelProfileModal";

export class EmbeddingModelModal extends ModelProfileModal<EmbeddingModel> {
  protected createDefaultModel(prefill?: Partial<EmbeddingModel>): EmbeddingModel {
    return {
      id: generateId(),
      name: prefill?.name ?? "",
      modelId: prefill?.modelId ?? "",
      provider: prefill?.provider ?? "lmstudio",
    };
  }

  protected getDatalistId(): string {
    return "lmsa-embedding-models-list";
  }

  protected getLMStudioCandidates(
    service: LMStudioModelsService
  ): Promise<ModelCandidateResult> {
    return service.getEmbeddingCandidates();
  }

  protected getAnthropicCandidates(
    service: AnthropicModelsService
  ): Promise<ModelCandidateResult> {
    return service.getEmbeddingCandidates();
  }

  protected renderExtraFields(): void {
    /* No extra fields for embedding models. */
  }
}
