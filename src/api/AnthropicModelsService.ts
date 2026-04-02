import { nodeRequest } from "./httpTransport";
import type { ModelCandidateResult, ModelDigest } from "./types";
import type { ModelsService, ModelsQueryOptions } from "./modelsService";
import { ANTHROPIC_BASE_URL, ANTHROPIC_VERSION } from "./anthropicConstants";
const PAGE_LIMIT = 1000;

export type AnthropicModelsQueryOptions = ModelsQueryOptions;

interface AnthropicRawModel {
  id: string;
  type: string;
  display_name: string;
  created_at: string;
  max_input_tokens?: number;
  max_tokens?: number;
  capabilities?: Record<string, { supported?: boolean }>;
}

interface AnthropicModelsResponse {
  data: AnthropicRawModel[];
  has_more: boolean;
  first_id: string;
  last_id: string;
}

interface AnthropicDiscoveredModels {
  models: AnthropicRawModel[];
  discoveredAt: number;
}

function formatContextSize(tokens?: number): string | null {
  if (!tokens || tokens <= 0) return null;
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(tokens % 1_000_000 === 0 ? 0 : 1)}M context`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K context`;
  return `${tokens} context`;
}

function extractCapabilities(model: AnthropicRawModel): string[] {
  const caps: string[] = [];
  if (!model.capabilities) return caps;

  const check = (key: string, label: string) => {
    const cap = model.capabilities?.[key];
    if (cap?.supported) caps.push(label);
  };

  check("thinking", "thinking");
  check("image_input", "vision");
  check("pdf_input", "PDF");
  check("citations", "citations");
  check("code_execution", "code exec");
  check("structured_outputs", "structured output");

  return caps;
}

function buildSummary(model: AnthropicRawModel): string | undefined {
  const parts: string[] = [];

  const ctx = formatContextSize(model.max_input_tokens);
  if (ctx) parts.push(ctx);

  const caps = extractCapabilities(model);
  if (caps.length > 0) parts.push(caps.join(", "));

  return parts.length > 0 ? parts.join(" · ") : undefined;
}

/** Date-stamped model IDs contain an 8-digit date suffix like `-20250514`. */
const DATE_SUFFIX_RE = /-\d{8}$/;

function sortModels(left: AnthropicRawModel, right: AnthropicRawModel): number {
  const leftIsAlias = !DATE_SUFFIX_RE.test(left.id);
  const rightIsAlias = !DATE_SUFFIX_RE.test(right.id);

  if (leftIsAlias !== rightIsAlias) return leftIsAlias ? -1 : 1;
  return left.display_name.localeCompare(right.display_name);
}

function toDigest(model: AnthropicRawModel): ModelDigest {
  return {
    id: `completion:${model.id}`,
    kind: "completion",
    displayName: model.display_name || model.id,
    targetModelId: model.id,
    provider: "anthropic",
    maxContextLength: model.max_input_tokens,
    summary: buildSummary(model),
  };
}

export class AnthropicModelsService implements ModelsService {
  private static readonly cache = new Map<string, AnthropicDiscoveredModels>();
  private readonly cacheKey: string;

  constructor(private readonly apiKey: string) {
    this.cacheKey = apiKey.slice(0, 8);
  }

  private buildHeaders(): Record<string, string> {
    return {
      "x-api-key": this.apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
      "Content-Type": "application/json",
    };
  }

  async discoverModels(
    options: AnthropicModelsQueryOptions = {}
  ): Promise<AnthropicDiscoveredModels> {
    if (!options.forceRefresh) {
      const cached = AnthropicModelsService.cache.get(this.cacheKey);
      if (cached) return cached;
    }

    const allModels: AnthropicRawModel[] = [];
    let afterId: string | undefined;

    while (true) {
      const query = new URLSearchParams({ limit: String(PAGE_LIMIT) });
      if (afterId) query.set("after_id", afterId);

      const raw = await nodeRequest(
        "GET",
        ANTHROPIC_BASE_URL,
        `/v1/models?${query.toString()}`,
        undefined,
        options.signal,
        this.buildHeaders()
      );

      const page = JSON.parse(raw) as AnthropicModelsResponse;
      allModels.push(...page.data);

      if (!page.has_more) break;
      afterId = page.last_id;
    }

    const discovered: AnthropicDiscoveredModels = {
      models: allModels,
      discoveredAt: Date.now(),
    };
    AnthropicModelsService.cache.set(this.cacheKey, discovered);
    return discovered;
  }

  async getCompletionCandidates(
    options: AnthropicModelsQueryOptions = {}
  ): Promise<ModelCandidateResult> {
    const discovery = await this.discoverModels(options);
    const candidates = discovery.models
      .sort(sortModels)
      .map(toDigest);

    return {
      candidates,
      source: "anthropic-api",
      discoveredAt: discovery.discoveredAt,
    };
  }

  async getEmbeddingCandidates(): Promise<ModelCandidateResult> {
    return {
      candidates: [],
      source: "anthropic-api",
      discoveredAt: Date.now(),
    };
  }
}
