import { LMStudioClient } from "../../src/api/LMStudioClient";
import type { LMStudioModel, LMStudioModelListResult } from "../../src/api/types";
import type { ChatClient } from "../../src/api/chatClient";
import type { LabDependencies, LabRunProvenance, LabRuntimeMetadataValue } from "../lab/types";

const DEFAULT_ENDPOINT = "http://127.0.0.1:1234/v1";
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

export interface LMStudioLabConfig {
  endpoint: string;
  bypassCors: boolean;
  modelId: string;
  sourceRevision: string | null;
  runtime: Record<string, LabRuntimeMetadataValue>;
}

export type LMStudioPreflightFailureKind = "endpoint-unavailable" | "model-unavailable";

export class LMStudioPreflightError extends Error {
  constructor(
    public readonly kind: LMStudioPreflightFailureKind,
    message: string,
  ) {
    super(message);
    this.name = "LMStudioPreflightError";
  }
}

export interface LMStudioDiscoveryClient extends ChatClient {
  getResolvedBaseUrl(): string;
  listModelsWithSource(signal?: AbortSignal): Promise<LMStudioModelListResult>;
}

export interface LMStudioPreflightResult {
  dependencies: LabDependencies;
  provenance: LabRunProvenance;
  discovery: {
    source: LMStudioModelListResult["source"];
    endpoint: string;
    modelCount: number;
    selectedModel: LMStudioModel;
  };
}

type Environment = Record<string, string | undefined>;

function optional(env: Environment, name: string): string | undefined {
  const value = env[name]?.trim();
  return value ? value : undefined;
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error("LAB_LMSTUDIO_BYPASS_CORS must be true or false.");
}

function validateLoopbackEndpoint(rawEndpoint: string): string {
  let endpoint: URL;
  try {
    endpoint = new URL(rawEndpoint);
  } catch {
    throw new Error("LAB_LMSTUDIO_URL must be a valid URL.");
  }
  if (!new Set(["http:", "https:"]).has(endpoint.protocol)) {
    throw new Error("LAB_LMSTUDIO_URL must use HTTP or HTTPS.");
  }
  if (!LOOPBACK_HOSTS.has(endpoint.hostname)) {
    throw new Error("The Phase 2 laboratory only permits a loopback LM Studio endpoint.");
  }
  return endpoint.toString().replace(/\/$/, "");
}

export function readLMStudioLabConfig(env: Environment): LMStudioLabConfig {
  const modelId = optional(env, "LAB_MODEL_ID");
  if (!modelId) {
    throw new Error("LAB_MODEL_ID is required.");
  }

  const runtime: Record<string, LabRuntimeMetadataValue> = {};
  const metadata = [
    ["artifact", "LAB_MODEL_ARTIFACT"],
    ["quantization", "LAB_MODEL_QUANTIZATION"],
    ["inferenceEngineVersion", "LAB_INFERENCE_ENGINE_VERSION"],
    ["chatTemplate", "LAB_CHAT_TEMPLATE"],
  ] as const;
  for (const [key, variable] of metadata) {
    const value = optional(env, variable);
    if (value) runtime[key] = value;
  }

  return {
    endpoint: validateLoopbackEndpoint(optional(env, "LAB_LMSTUDIO_URL") ?? DEFAULT_ENDPOINT),
    bypassCors: parseBoolean(optional(env, "LAB_LMSTUDIO_BYPASS_CORS"), true),
    modelId,
    sourceRevision: optional(env, "LAB_SOURCE_REVISION") ?? null,
    runtime,
  };
}

function createSubject(
  config: LMStudioLabConfig,
  client: LMStudioDiscoveryClient,
  discoveredRuntime: Record<string, LabRuntimeMetadataValue> = {},
): {
  dependencies: LabDependencies;
  provenance: LabRunProvenance;
} {
  return {
    dependencies: { client },
    provenance: {
      sourceRevision: config.sourceRevision,
      subject: {
        provider: "lmstudio",
        modelId: config.modelId,
        endpoint: client.getResolvedBaseUrl(),
        runtime: {
          bypassCors: config.bypassCors,
          ...discoveredRuntime,
          ...config.runtime,
        },
      },
    },
  };
}

export function createLMStudioLabSubject(config: LMStudioLabConfig): {
  dependencies: LabDependencies;
  provenance: LabRunProvenance;
} {
  return createSubject(config, new LMStudioClient(config.endpoint, config.bypassCors));
}

function discoveredMetadata(
  result: LMStudioModelListResult,
  model: LMStudioModel,
): Record<string, LabRuntimeMetadataValue> {
  const metadata: Record<string, LabRuntimeMetadataValue> = {
    discoverySource: result.source,
    discoveryEndpoint: result.endpoint,
    displayName: model.displayName,
    state: model.state,
    loaded: model.isLoaded,
  };
  const optionalMetadata: Array<[string, LabRuntimeMetadataValue | undefined]> = [
    ["architecture", model.architecture],
    ["quantization", model.quantization?.name],
    ["bitsPerWeight", model.quantization?.bitsPerWeight],
    ["sizeBytes", model.sizeBytes],
    ["parameters", model.paramsString],
    ["maxContextLength", model.maxContextLength],
    ["format", model.format],
    ["trainedForToolUse", model.capabilities?.trainedForToolUse],
    ["vision", model.capabilities?.vision],
    ["loadedInstanceIds", model.loadedInstances.map((instance) => instance.id).join(",") || undefined],
    ["activeContextLength", model.loadedInstances[0]?.config?.contextLength],
  ];
  for (const [key, value] of optionalMetadata) {
    if (value !== undefined) metadata[key] = value;
  }
  return metadata;
}

function matchesModel(model: LMStudioModel, modelId: string): boolean {
  return model.id === modelId || model.key === modelId || model.selectedVariant === modelId;
}

export async function preflightLMStudioLabSubject(
  config: LMStudioLabConfig,
  signal?: AbortSignal,
  client: LMStudioDiscoveryClient = new LMStudioClient(config.endpoint, config.bypassCors),
): Promise<LMStudioPreflightResult> {
  let result: LMStudioModelListResult;
  try {
    result = await client.listModelsWithSource(signal);
  } catch (error) {
    throw new LMStudioPreflightError(
      "endpoint-unavailable",
      `LM Studio preflight could not list models: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const selectedModel = result.models.find((model) => matchesModel(model, config.modelId));
  if (!selectedModel) {
    const available = result.models.map((model) => model.id).sort().join(", ") || "none";
    throw new LMStudioPreflightError(
      "model-unavailable",
      `LM Studio model ${JSON.stringify(config.modelId)} was not found. Available models: ${available}.`,
    );
  }

  return {
    ...createSubject(config, client, discoveredMetadata(result, selectedModel)),
    discovery: {
      source: result.source,
      endpoint: result.endpoint,
      modelCount: result.models.length,
      selectedModel,
    },
  };
}
