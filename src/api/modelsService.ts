import type { ModelCandidateResult } from "./types";

export interface ModelsQueryOptions {
  forceRefresh?: boolean;
  signal?: AbortSignal;
}

/** Shared interface for provider-specific model discovery services. */
export interface ModelsService {
  getCompletionCandidates(options?: ModelsQueryOptions): Promise<ModelCandidateResult>;
  getEmbeddingCandidates(options?: ModelsQueryOptions): Promise<ModelCandidateResult>;
}
