import type { CompletionModel, EmbeddingModel } from "./types";

export function normalizeCompletionModel(
  model: Partial<CompletionModel> | null | undefined,
  index: number
): CompletionModel {
  return {
    id: model?.id || `model-${index + 1}`,
    name: model?.name || `Model ${index + 1}`,
    modelId: model?.modelId ?? "",
    provider: model?.provider ?? "lmstudio",
    ...(model?.contextWindowSize && { contextWindowSize: model.contextWindowSize }),
  };
}

export function normalizeEmbeddingModel(
  model: Partial<EmbeddingModel> | null | undefined,
  index: number
): EmbeddingModel {
  return {
    id: model?.id || `embedding-${index + 1}`,
    name: model?.name || `Embedding ${index + 1}`,
    modelId: model?.modelId ?? "",
    provider: model?.provider ?? "lmstudio",
  };
}
