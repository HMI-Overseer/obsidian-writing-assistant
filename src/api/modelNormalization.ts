import type {
  LMStudioLoadedInstance,
  LMStudioLoadedInstanceConfig,
  LMStudioModel,
  LMStudioModelCapabilities,
  LMStudioQuantization,
} from "./types";
import type { LMStudioModelListSource } from "./types";
import {
  isRecord,
  readString,
  readNullableString,
  readNumber,
  readBoolean,
  readStringArray,
} from "./parsing";

export function normalizeQuantization(value: unknown): LMStudioQuantization | undefined {
  if (typeof value === "string" && value.trim()) {
    return { name: value };
  }

  if (!isRecord(value)) return undefined;

  const name = readString(value.name);
  const bitsPerWeight = readNumber(value.bits_per_weight);
  if (!name && bitsPerWeight === undefined) return undefined;

  return {
    name,
    bitsPerWeight,
  };
}

export function normalizeLoadedInstanceConfig(value: unknown): LMStudioLoadedInstanceConfig | undefined {
  if (!isRecord(value)) return undefined;

  const config: LMStudioLoadedInstanceConfig = {
    contextLength: readNumber(value.context_length),
    evalBatchSize: readNumber(value.eval_batch_size),
    parallel: readNumber(value.parallel),
    flashAttention: readBoolean(value.flash_attention),
    offloadKvCacheToGpu: readBoolean(value.offload_kv_cache_to_gpu),
  };

  if (Object.values(config).every((entry) => entry === undefined)) {
    return undefined;
  }

  return config;
}

export function normalizeLoadedInstance(value: unknown): LMStudioLoadedInstance | null {
  if (!isRecord(value)) return null;

  const id = readString(value.id);
  if (!id) return null;

  return {
    id,
    config: normalizeLoadedInstanceConfig(value.config),
  };
}

export function normalizeCapabilities(value: unknown): LMStudioModelCapabilities | undefined {
  if (!isRecord(value)) return undefined;

  const capabilities: LMStudioModelCapabilities = {
    vision: readBoolean(value.vision),
    trainedForToolUse: readBoolean(value.trained_for_tool_use),
  };

  if (Object.values(capabilities).every((entry) => entry === undefined)) {
    return undefined;
  }

  return capabilities;
}

export function normalizeNativeModel(value: unknown): LMStudioModel | null {
  if (!isRecord(value)) return null;

  const key =
    readString(value.key) ??
    readString(value.id) ??
    readString(value.selected_variant);
  if (!key) return null;

  const loadedInstances = Array.isArray(value.loaded_instances)
    ? value.loaded_instances
        .map(normalizeLoadedInstance)
        .filter((entry): entry is LMStudioLoadedInstance => entry !== null)
    : [];
  const publisher = readString(value.publisher);

  return {
    id: key,
    key,
    displayName: readString(value.display_name) ?? key,
    type: readString(value.type),
    publisher,
    ownedBy: publisher,
    state: loadedInstances.length > 0 ? "loaded" : "available",
    isLoaded: loadedInstances.length > 0,
    architecture: readString(value.architecture),
    quantization: normalizeQuantization(value.quantization),
    sizeBytes: readNumber(value.size_bytes),
    paramsString: readNullableString(value.params_string),
    loadedInstances,
    maxContextLength: readNumber(value.max_context_length),
    format: readString(value.format),
    capabilities: normalizeCapabilities(value.capabilities),
    description: readNullableString(value.description),
    variants: readStringArray(value.variants),
    selectedVariant: readString(value.selected_variant),
  };
}

export function normalizeOpenAIModel(value: unknown): LMStudioModel | null {
  if (!isRecord(value)) return null;

  const id = readString(value.id);
  if (!id) return null;

  const isLoaded = readString(value.state) === "loaded";
  const ownedBy = readString(value.owned_by);

  return {
    id,
    key: id,
    displayName: id,
    type: readString(value.type),
    publisher: ownedBy,
    ownedBy,
    state: isLoaded ? "loaded" : "available",
    isLoaded,
    architecture: readString(value.architecture),
    quantization: normalizeQuantization(value.quantization),
    loadedInstances: isLoaded ? [{ id }] : [],
    maxContextLength: readNumber(value.max_context_length),
  };
}

export function normalizeModelList(
  payload: unknown,
  source: LMStudioModelListSource
): LMStudioModel[] | null {
  if (!isRecord(payload)) return null;

  const rawModels = source === "native" ? payload.models : payload.data;
  if (!Array.isArray(rawModels)) return null;

  const normalize = source === "native" ? normalizeNativeModel : normalizeOpenAIModel;
  return rawModels
    .map(normalize)
    .filter((model): model is LMStudioModel => model !== null);
}
