import { LMStudioClient } from "./LMStudioClient";
import type { LMStudioModelListSource } from "./LMStudioClient";
import type {
  LMStudioModel,
  LMStudioModelDigest,
  LMStudioModelKind,
  LMStudioQuantization,
} from "../shared/types";

export interface LMStudioDiscoveredModels {
  models: LMStudioModel[];
  source: LMStudioModelListSource;
  endpoint: string;
  discoveredAt: number;
}

export interface LMStudioModelCandidateResult {
  candidates: LMStudioModelDigest[];
  source: LMStudioModelListSource;
  endpoint: string;
  discoveredAt: number;
}

export interface LMStudioModelsQueryOptions {
  forceRefresh?: boolean;
  signal?: AbortSignal;
}

function formatQuantization(quantization?: LMStudioQuantization): string | null {
  if (!quantization) return null;
  if (quantization.name && quantization.bitsPerWeight) {
    return `${quantization.name} (${quantization.bitsPerWeight}-bit)`;
  }

  return quantization.name ?? null;
}

function isEmbeddingModel(model: LMStudioModel): boolean {
  const type = model.type?.toLowerCase();
  if (type === "embedding" || type === "embeddings") {
    return true;
  }

  const target = (model.selectedVariant ?? model.id).toLowerCase();
  return (
    target.includes("embed") ||
    target.includes("embedding") ||
    target.includes("bge") ||
    target.includes("e5")
  );
}

function isCompletionModel(model: LMStudioModel): boolean {
  return !isEmbeddingModel(model) && (!model.type || model.type === "llm");
}

function getActiveContextLength(model: LMStudioModel): number | undefined {
  const contextLengths = model.loadedInstances
    .map((instance) => instance.config?.contextLength)
    .filter((value): value is number => typeof value === "number" && value > 0);

  if (contextLengths.length === 0) return undefined;
  return Math.max(...contextLengths);
}

function sortModels(left: LMStudioModel, right: LMStudioModel): number {
  if (left.isLoaded !== right.isLoaded) {
    return left.isLoaded ? -1 : 1;
  }

  return left.displayName.localeCompare(right.displayName);
}

function buildSummary(model: LMStudioModel, kind: LMStudioModelKind): string | undefined {
  const pieces =
    kind === "completion"
      ? []
      : [model.publisher ?? model.ownedBy, formatQuantization(model.quantization), model.architecture];

  const summary = pieces.filter(Boolean).join(" | ");
  return summary || undefined;
}

function toDigest(model: LMStudioModel, kind: LMStudioModelKind): LMStudioModelDigest {
  const targetModelId = model.selectedVariant ?? model.id;

  return {
    id: `${kind}:${targetModelId}`,
    kind,
    displayName: model.displayName || model.id,
    targetModelId,
    isLoaded: model.isLoaded,
    activeContextLength: getActiveContextLength(model),
    maxContextLength: model.maxContextLength,
    summary: buildSummary(model, kind),
  };
}

export class LMStudioModelsService {
  private static readonly cache = new Map<string, LMStudioDiscoveredModels>();
  private readonly client: LMStudioClient;
  private readonly cacheKey: string;

  constructor(baseUrl: string, bypassCors: boolean = true) {
    this.client = new LMStudioClient(baseUrl, bypassCors);
    this.cacheKey = `${this.client.getResolvedBaseUrl()}::${String(bypassCors)}`;
  }

  clearCache(): void {
    LMStudioModelsService.cache.delete(this.cacheKey);
  }

  async discoverModels(options: LMStudioModelsQueryOptions = {}): Promise<LMStudioDiscoveredModels> {
    if (!options.forceRefresh) {
      const cached = LMStudioModelsService.cache.get(this.cacheKey);
      if (cached) return cached;
    }

    const result = await this.client.listModelsWithSource(options.signal);
    const discovered: LMStudioDiscoveredModels = {
      ...result,
      discoveredAt: Date.now(),
    };
    LMStudioModelsService.cache.set(this.cacheKey, discovered);
    return discovered;
  }

  async getCompletionCandidates(
    options: LMStudioModelsQueryOptions = {}
  ): Promise<LMStudioModelCandidateResult> {
    const discovery = await this.discoverModels(options);
    const candidates = discovery.models
      .filter(isCompletionModel)
      .sort(sortModels)
      .map((model) => toDigest(model, "completion"));

    return {
      candidates,
      source: discovery.source,
      endpoint: discovery.endpoint,
      discoveredAt: discovery.discoveredAt,
    };
  }

  async getEmbeddingCandidates(
    options: LMStudioModelsQueryOptions = {}
  ): Promise<LMStudioModelCandidateResult> {
    const discovery = await this.discoverModels(options);
    const candidates = discovery.models
      .filter(isEmbeddingModel)
      .sort(sortModels)
      .map((model) => toDigest(model, "embedding"));

    return {
      candidates,
      source: discovery.source,
      endpoint: discovery.endpoint,
      discoveredAt: discovery.discoveredAt,
    };
  }
}

