import type { LMStudioModelsService } from "../../api";
import type { LMStudioModelCandidateResult } from "../../api/LMStudioModelsService";
import type { EmbeddingModel } from "../../shared/types";
import { generateId } from "../../utils";
import { ModelProfileModal } from "./ModelProfileModal";

export class EmbeddingModelModal extends ModelProfileModal<EmbeddingModel> {
  protected createDefaultModel(prefill?: Partial<EmbeddingModel>): EmbeddingModel {
    return {
      id: generateId(),
      name: prefill?.name ?? "",
      modelId: prefill?.modelId ?? "",
    };
  }

  protected getDatalistId(): string {
    return "lmsa-embedding-models-list";
  }

  protected getCandidates(
    service: LMStudioModelsService
  ): Promise<LMStudioModelCandidateResult> {
    return service.getEmbeddingCandidates();
  }

  protected renderExtraFields(): void {
    /* No extra fields for embedding models. */
  }
}
