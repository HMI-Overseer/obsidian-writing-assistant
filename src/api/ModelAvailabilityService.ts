import type {
  CompletionModel,
  EmbeddingModel,
  ModelAvailabilityState,
  ProviderSettingsMap,
} from "../shared/types";
import type { ModelCandidateResult } from "./types";
import { LMStudioModelsService } from "./LMStudioModelsService";
import { getProviderDescriptor } from "../providers/registry";
import { modelKey } from "../shared/modelKeys";
import type { ProviderOption } from "../shared/types";

const AVAILABILITY_CACHE_TTL_MS = 30_000;

export interface ModelAvailabilityInfo {
  state: ModelAvailabilityState;
  activeContextLength?: number;
  trainedForToolUse?: boolean;
  vision?: boolean;
}

export class ModelAvailabilityService {
  private availabilityMap = new Map<string, ModelAvailabilityInfo>();
  /**
   * Context windows reported by a provider's own responses (Claude Code's
   * `modelUsage.contextWindow`), keyed by model id. Kept apart from
   * `availabilityMap`, which is rebuilt from LM Studio discovery on every
   * refresh and would silently drop provider-reported entries.
   */
  private reportedContextWindows = new Map<string, number>();
  private lmService: LMStudioModelsService | null = null;
  private lastFetchedAt = 0;
  private lastLmBaseUrl = "";
  private lastLmBypassCors = true;

  constructor(
    private readonly getProviderSettings: () => ProviderSettingsMap,
    /**
     * Persists the last-seen LM Studio discovery snapshot into settings so the
     * Providers card and the active-model label keep rendering while the
     * server is unreachable. Best-effort: a persistence failure never breaks a
     * refresh.
     */
    private readonly persistLastSeen?: (
      completion: CompletionModel[],
      embedding: EmbeddingModel[],
    ) => Promise<void>,
  ) {}

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
    const fetchOpts = { forceRefresh, signal: options.signal };
    const [completionResult, embeddingResult] = await Promise.all([
      service.getCompletionCandidates(fetchOpts),
      service.getEmbeddingCandidates(fetchOpts),
    ]);

    this.availabilityMap.clear();
    for (const candidate of [...completionResult.candidates, ...embeddingResult.candidates]) {
      this.availabilityMap.set(candidate.targetModelId, {
        state: candidate.isLoaded ? "loaded" : "unloaded",
        activeContextLength: candidate.activeContextLength,
        trainedForToolUse: candidate.trainedForToolUse,
        vision: candidate.vision,
      });
    }

    this.lastFetchedAt = Date.now();

    if (this.persistLastSeen) {
      // Cache rows are identity + name only; capabilities stay in the live
      // availability map so a snapshot can never shadow fresh discovery.
      const completion = completionResult.candidates.map<CompletionModel>((candidate) => ({
        id: modelKey("lmstudio", candidate.targetModelId),
        name: candidate.displayName,
        modelId: candidate.targetModelId,
        provider: "lmstudio",
      }));
      const embedding = embeddingResult.candidates.map<EmbeddingModel>((candidate) => ({
        id: modelKey("lmstudio", candidate.targetModelId),
        name: candidate.displayName,
        modelId: candidate.targetModelId,
        provider: "lmstudio",
      }));
      try {
        await this.persistLastSeen(completion, embedding);
      } catch (error) {
        console.error("[models] Failed to persist LM Studio discovery snapshot", error);
      }
    }
  }

  getActiveContextLength(modelId: string): number | undefined {
    return (
      this.availabilityMap.get(modelId)?.activeContextLength ??
      this.reportedContextWindows.get(modelId)
    );
  }

  /**
   * Records a context window the provider itself reported for a model (Claude
   * Code turns carry it in their result). Fills the same lookup the capacity
   * ring and the pre-send capacity notice already fall back to for models whose
   * catalog entry carries no static window.
   */
  reportContextWindow(modelId: string, contextWindow: number): void {
    this.reportedContextWindows.set(modelId, contextWindow);
  }

  getTrainedForToolUse(modelId: string): boolean | undefined {
    return this.availabilityMap.get(modelId)?.trainedForToolUse;
  }

  getVision(modelId: string): boolean | undefined {
    return this.availabilityMap.get(modelId)?.vision;
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

  // Cloud discovery retired with the Providers-tab rework: cloud model lists
  // are the shipped curated catalogs (providers/catalog); only LM Studio keeps
  // live discovery, which refreshLocalModels drives.
  async discoverCompletionCandidates(
    _provider: ProviderOption,
    options: { forceRefresh?: boolean; signal?: AbortSignal } = {},
  ): Promise<ModelCandidateResult> {
    return this.getLMStudioService().getCompletionCandidates(options);
  }

  async discoverEmbeddingCandidates(
    options: { forceRefresh?: boolean; signal?: AbortSignal } = {},
  ): Promise<ModelCandidateResult> {
    return this.getLMStudioService().getEmbeddingCandidates(options);
  }

  invalidate(): void {
    this.lmService = null;
    this.availabilityMap.clear();
    this.lastFetchedAt = 0;
  }

  destroy(): void {
    this.invalidate();
  }
}
