import type { ProviderOption } from "../shared/types";

export type RequestMethod = "GET" | "POST";
export type JsonRecord = Record<string, unknown>;

// ── Provider-agnostic model discovery types ──────────────────────────────

export interface ModelDigest {
  id: string;
  kind: "completion" | "embedding";
  displayName: string;
  targetModelId: string;
  provider: ProviderOption;
  /** Whether the model is currently loaded/active. Only meaningful for local providers. */
  isLoaded?: boolean;
  activeContextLength?: number;
  maxContextLength?: number;
  /** Free-form summary line shown below the model ID. */
  summary?: string;
  /** Whether the model was trained for tool/function calling. */
  trainedForToolUse?: boolean;
}

export interface ModelCandidateResult {
  candidates: ModelDigest[];
  source: string;
  discoveredAt: number;
}

export type LMStudioModelListSource = "native" | "openai";

export interface LMStudioModelListResult {
  models: LMStudioModel[];
  source: LMStudioModelListSource;
  endpoint: string;
}

export type LMStudioModelKind = "completion" | "embedding";

export interface LMStudioModel {
  id: string;
  key: string;
  displayName: string;
  type?: string;
  publisher?: string;
  ownedBy?: string;
  state: "loaded" | "available";
  isLoaded: boolean;
  architecture?: string;
  quantization?: LMStudioQuantization;
  sizeBytes?: number;
  paramsString?: string | null;
  loadedInstances: LMStudioLoadedInstance[];
  maxContextLength?: number;
  format?: string;
  capabilities?: LMStudioModelCapabilities;
  description?: string | null;
  variants?: string[];
  selectedVariant?: string;
}

export interface LMStudioModelDigest {
  id: string;
  kind: LMStudioModelKind;
  displayName: string;
  targetModelId: string;
  isLoaded: boolean;
  activeContextLength?: number;
  maxContextLength?: number;
  summary?: string;
}

export interface LMStudioQuantization {
  name?: string;
  bitsPerWeight?: number;
}

export interface LMStudioLoadedInstanceConfig {
  contextLength?: number;
  evalBatchSize?: number;
  parallel?: number;
  flashAttention?: boolean;
  offloadKvCacheToGpu?: boolean;
}

export interface LMStudioLoadedInstance {
  id: string;
  config?: LMStudioLoadedInstanceConfig;
}

export interface LMStudioModelCapabilities {
  vision?: boolean;
  trainedForToolUse?: boolean;
}
