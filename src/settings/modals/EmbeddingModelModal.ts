import type { ModelCandidateResult } from "../../api/types";
import type { EmbeddingModel, ProviderOption } from "../../shared/types";
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

  protected discoverCandidates(
    _provider: ProviderOption,
    options: { forceRefresh: boolean }
  ): Promise<ModelCandidateResult> {
    return this.plugin.services.modelAvailability.discoverEmbeddingCandidates(options);
  }

  protected renderExtraFields(): void {
    /* No extra fields for embedding models. */
  }
}
