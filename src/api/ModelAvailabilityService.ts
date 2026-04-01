import type { ModelAvailabilityState, ProviderSettingsMap } from "../shared/types";
import type { ModelCandidateResult } from "./types";
import { LMStudioModelsService } from "./LMStudioModelsService";
import { AnthropicModelsService } from "./AnthropicModelsService";
import { getProviderDescriptor } from "../providers/registry";
import type { ProviderOption } from "../shared/types";

const AVAILABILITY_CACHE_TTL_MS = 30_000;

export interface ModelAvailabilityInfo {
  state: ModelAvailabilityState;
  activeContextLength?: number;
}

export class ModelAvailabilityService {
  private availabilityMap = new Map<string, ModelAvailabilityInfo>();
  private lmService: LMStudioModelsService | null = null;
  private anthropicService: AnthropicModelsService | null = null;
  private lastFetchedAt = 0;
  private lastLmBaseUrl = "";
  private lastLmBypassCors = true;
  private lastAnthropicApiKey = "";

  constructor(private readonly getProviderSettings: () => ProviderSettingsMap) {}

  getAvailability(modelId: string, provider: ProviderOption): ModelAvailabilityInfo {
    const descriptor = getProviderDescriptor(provider);
    if (descriptor.kind === "cloud") {
      return { state: "cloud" };
    }

    return this.availabilityMap.get(modelId) ?? { state: "unknown" };
  }

  async refreshLocalModels(
    options: { forceRefresh?: boolean; signal?: AbortSignal } = {},
  ): Promise<void> {
    const forceRefresh = options.forceRefresh ?? false;

    if (!forceRefresh && Date.now() - this.lastFetchedAt < AVAILABILITY_CACHE_TTL_MS) {
      return;
    }

    const service = this.getLMStudioService();
    const result = await service.getCompletionCandidates({
      forceRefresh,
      signal: options.signal,
    });

    this.availabilityMap.clear();
    for (const candidate of result.candidates) {
      this.availabilityMap.set(candidate.targetModelId, {
        state: candidate.isLoaded ? "loaded" : "unloaded",
        activeContextLength: candidate.activeContextLength,
      });
    }

    this.lastFetchedAt = Date.now();
  }

  getActiveContextLength(modelId: string): number | undefined {
    return this.availabilityMap.get(modelId)?.activeContextLength;
  }

  getLMStudioService(): LMStudioModelsService {
    const lm = this.getProviderSettings().lmstudio;
    if (
      !this.lmService ||
      this.lastLmBaseUrl !== lm.baseUrl ||
      this.lastLmBypassCors !== lm.bypassCors
    ) {
      this.lmService = new LMStudioModelsService(lm.baseUrl, lm.bypassCors);
      this.lastLmBaseUrl = lm.baseUrl;
      this.lastLmBypassCors = lm.bypassCors;
    }
    return this.lmService;
  }

  getAnthropicService(): AnthropicModelsService {
    const apiKey = this.getProviderSettings().anthropic.apiKey;
    if (!this.anthropicService || this.lastAnthropicApiKey !== apiKey) {
      this.anthropicService = new AnthropicModelsService(apiKey);
      this.lastAnthropicApiKey = apiKey;
    }
    return this.anthropicService;
  }

  async discoverCompletionCandidates(
    provider: ProviderOption,
    options: { forceRefresh?: boolean; signal?: AbortSignal } = {},
  ): Promise<ModelCandidateResult> {
    if (provider === "anthropic") {
      return this.getAnthropicService().getCompletionCandidates(options);
    }
    return this.getLMStudioService().getCompletionCandidates(options);
  }

  async discoverEmbeddingCandidates(
    options: { forceRefresh?: boolean; signal?: AbortSignal } = {},
  ): Promise<ModelCandidateResult> {
    return this.getLMStudioService().getEmbeddingCandidates(options);
  }

  invalidate(): void {
    this.lmService = null;
    this.anthropicService = null;
    this.availabilityMap.clear();
    this.lastFetchedAt = 0;
  }

  destroy(): void {
    this.invalidate();
  }
}
