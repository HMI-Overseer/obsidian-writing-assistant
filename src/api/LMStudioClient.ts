import type {
  LMStudioLoadedInstance,
  LMStudioLoadedInstanceConfig,
  LMStudioModel,
  LMStudioModelCapabilities,
  LMStudioQuantization,
  Message,
} from "../shared/types";
import * as http from "http";
import * as https from "https";

type RequestMethod = "GET" | "POST";
type JsonRecord = Record<string, unknown>;
export type LMStudioModelListSource = "native" | "openai";

export interface LMStudioModelListResult {
  models: LMStudioModel[];
  source: LMStudioModelListSource;
  endpoint: string;
}

const DEFAULT_LM_STUDIO_ROOT_URL = "http://localhost:1234";

function createAbortError(): Error {
  const error = new Error("The request was aborted.");
  error.name = "AbortError";
  return error;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function readNullableString(value: unknown): string | null | undefined {
  if (value === null) return null;
  return readString(value);
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function readStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;

  const items = value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
  return items.length > 0 ? items : undefined;
}

function stripKnownApiSuffix(pathname: string): string {
  const trimmed = pathname.trim().replace(/\/+$/, "");
  if (!trimmed || trimmed === "/") return "";
  if (trimmed.endsWith("/api/v1")) return trimmed.slice(0, -7);
  if (trimmed.endsWith("/v1")) return trimmed.slice(0, -3);
  return trimmed;
}

function joinBasePath(rootPath: string, suffix: string): string {
  const trimmedRoot = rootPath.replace(/\/+$/, "");
  return trimmedRoot ? `${trimmedRoot}${suffix}` : suffix;
}

function normalizeQuantization(value: unknown): LMStudioQuantization | undefined {
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

function normalizeLoadedInstanceConfig(value: unknown): LMStudioLoadedInstanceConfig | undefined {
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

function normalizeLoadedInstance(value: unknown): LMStudioLoadedInstance | null {
  if (!isRecord(value)) return null;

  const id = readString(value.id);
  if (!id) return null;

  return {
    id,
    config: normalizeLoadedInstanceConfig(value.config),
  };
}

function normalizeCapabilities(value: unknown): LMStudioModelCapabilities | undefined {
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

function normalizeNativeModel(value: unknown): LMStudioModel | null {
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

function normalizeOpenAIModel(value: unknown): LMStudioModel | null {
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

function normalizeModelList(
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

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function createModelListError(nativeError: unknown, openAIError: unknown): Error {
  return new Error(
    `Failed to fetch models from LM Studio. Native /api/v1/models error: ${formatError(
      nativeError
    )}. OpenAI-compatible /v1/models error: ${formatError(openAIError)}.`
  );
}

export function resolveLMStudioBaseUrls(input: string): {
  serverRootUrl: string;
  openAIBaseUrl: string;
  nativeApiBaseUrl: string;
} {
  const trimmed = input.trim().replace(/\/+$/, "");
  const fallbackRoot = DEFAULT_LM_STUDIO_ROOT_URL;

  if (!trimmed) {
    return {
      serverRootUrl: fallbackRoot,
      openAIBaseUrl: `${fallbackRoot}/v1`,
      nativeApiBaseUrl: `${fallbackRoot}/api/v1`,
    };
  }

  try {
    const url = new URL(trimmed);
    const rootPath = stripKnownApiSuffix(url.pathname);
    const serverRootUrl = `${url.origin}${rootPath}`;

    return {
      serverRootUrl,
      openAIBaseUrl: `${url.origin}${joinBasePath(rootPath, "/v1")}`,
      nativeApiBaseUrl: `${url.origin}${joinBasePath(rootPath, "/api/v1")}`,
    };
  } catch {
    const serverRootUrl = stripKnownApiSuffix(trimmed) || fallbackRoot;

    return {
      serverRootUrl,
      openAIBaseUrl: `${serverRootUrl}/v1`,
      nativeApiBaseUrl: `${serverRootUrl}/api/v1`,
    };
  }
}

export function normalizeLMStudioBaseUrl(input: string): string {
  return resolveLMStudioBaseUrls(input).openAIBaseUrl;
}

export class LMStudioClient {
  private readonly openAIBaseUrl: string;
  private readonly nativeApiBaseUrl: string;

  constructor(baseUrl: string, private bypassCors: boolean = true) {
    const resolved = resolveLMStudioBaseUrls(baseUrl);
    this.openAIBaseUrl = resolved.openAIBaseUrl;
    this.nativeApiBaseUrl = resolved.nativeApiBaseUrl;
  }

  getResolvedBaseUrl(): string {
    return this.openAIBaseUrl;
  }

  getResolvedNativeApiBaseUrl(): string {
    return this.nativeApiBaseUrl;
  }

  private nodeRequest(
    method: RequestMethod,
    baseUrl: string,
    path: string,
    body?: string,
    signal?: AbortSignal
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(createAbortError());
        return;
      }

      const url = new URL(`${baseUrl}${path}`);
      const lib = url.protocol === "https:" ? https : http;

      const options: http.RequestOptions = {
        hostname: url.hostname,
        port: parseInt(url.port, 10) || (url.protocol === "https:" ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method,
        headers: {
          "Content-Type": "application/json",
          ...(body ? { "Content-Length": Buffer.byteLength(body) } : {}),
        },
      };

      const req = lib.request(options, (res) => {
        let data = "";
        res.on("data", (chunk: Buffer) => (data += chunk.toString()));
        res.on("end", () => {
          if (res.statusCode && res.statusCode >= 400) {
            reject(new Error(`HTTP ${res.statusCode}: ${data}`));
            return;
          }
          resolve(data);
        });
        res.on("error", reject);
      });

      const abortHandler = () => {
        req.destroy(createAbortError());
      };

      signal?.addEventListener("abort", abortHandler, { once: true });
      req.on("close", () => signal?.removeEventListener("abort", abortHandler));
      req.on("error", reject);
      if (body) req.write(body);
      req.end();
    });
  }

  private async request(
    method: RequestMethod,
    baseUrl: string,
    path: string,
    body?: string,
    signal?: AbortSignal
  ): Promise<string> {
    if (this.bypassCors) {
      return this.nodeRequest(method, baseUrl, path, body, signal);
    }

    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { "Content-Type": "application/json" },
      ...(body ? { body } : {}),
      signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.text();
  }

  private async requestJson(
    method: RequestMethod,
    baseUrl: string,
    path: string,
    body?: string,
    signal?: AbortSignal
  ): Promise<unknown> {
    return JSON.parse(await this.request(method, baseUrl, path, body, signal));
  }

  async listModelsWithSource(signal?: AbortSignal): Promise<LMStudioModelListResult> {
    const nativeEndpoint = `${this.nativeApiBaseUrl}/models`;

    try {
      const payload = await this.requestJson("GET", this.nativeApiBaseUrl, "/models", undefined, signal);
      const models = normalizeModelList(payload, "native");
      if (!models) {
        throw new Error("LM Studio returned an unexpected native model list response.");
      }

      return {
        models,
        source: "native",
        endpoint: nativeEndpoint,
      };
    } catch (nativeError) {
      const openAIEndpoint = `${this.openAIBaseUrl}/models`;

      try {
        const payload = await this.requestJson("GET", this.openAIBaseUrl, "/models", undefined, signal);
        const models = normalizeModelList(payload, "openai");
        if (!models) {
          throw new Error("LM Studio returned an unexpected OpenAI-compatible model list response.");
        }

        return {
          models,
          source: "openai",
          endpoint: openAIEndpoint,
        };
      } catch (openAIError) {
        throw createModelListError(nativeError, openAIError);
      }
    }
  }

  async listModels(signal?: AbortSignal): Promise<LMStudioModel[]> {
    const result = await this.listModelsWithSource(signal);
    return result.models;
  }

  async complete(
    messages: Message[],
    model: string,
    maxTokens: number,
    temperature: number,
    signal?: AbortSignal
  ): Promise<string> {
    const payload = JSON.stringify({
      model,
      messages,
      max_tokens: maxTokens,
      temperature,
      stream: false,
    });

    const json = await this.requestJson(
      "POST",
      this.openAIBaseUrl,
      "/chat/completions",
      payload,
      signal
    );
    if (!isRecord(json)) {
      throw new Error("LM Studio returned an invalid chat completion response.");
    }

    return (json.choices as Array<{ message?: { content?: string } }>)[0]?.message?.content ?? "";
  }

  async *stream(
    messages: Message[],
    model: string,
    maxTokens: number,
    temperature: number,
    signal?: AbortSignal
  ): AsyncGenerator<string> {
    if (this.bypassCors) {
      yield* this.streamNode(messages, model, maxTokens, temperature, signal);
      return;
    }

    yield* this.streamFetch(messages, model, maxTokens, temperature, signal);
  }

  private async *streamNode(
    messages: Message[],
    model: string,
    maxTokens: number,
    temperature: number,
    signal?: AbortSignal
  ): AsyncGenerator<string> {
    if (signal?.aborted) throw createAbortError();

    const url = new URL(`${this.openAIBaseUrl}/chat/completions`);
    const lib = url.protocol === "https:" ? https : http;
    const body = JSON.stringify({
      model,
      messages,
      max_tokens: maxTokens,
      temperature,
      stream: true,
    });

    const queue: string[] = [];
    let done = false;
    let error: Error | null = null;
    let wake: (() => void) | null = null;
    let req: http.ClientRequest | null = null;

    const notify = () => {
      if (wake) {
        wake();
        wake = null;
      }
    };

    const abortHandler = () => {
      error = createAbortError();
      done = true;
      req?.destroy(error);
      notify();
    };

    signal?.addEventListener("abort", abortHandler, { once: true });

    try {
      const options: http.RequestOptions = {
        hostname: url.hostname,
        port: parseInt(url.port, 10) || (url.protocol === "https:" ? 443 : 80),
        path: url.pathname,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
      };

      req = lib.request(options, (res) => {
        let buffer = "";
        res.on("data", (chunk: Buffer) => {
          buffer += chunk.toString();
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith("data: ")) continue;
            const payload = trimmed.slice(6);
            if (payload === "[DONE]") continue;

            try {
              const delta = JSON.parse(payload).choices?.[0]?.delta?.content;
              if (delta) {
                queue.push(delta);
                notify();
              }
            } catch {
              // Skip malformed chunks from the stream.
            }
          }
        });
        res.on("end", () => {
          done = true;
          notify();
        });
        res.on("error", (streamError: Error) => {
          error = streamError;
          done = true;
          notify();
        });
      });

      req.on("error", (requestError: Error) => {
        error = requestError;
        done = true;
        notify();
      });
      req.write(body);
      req.end();

      while (true) {
        if (queue.length > 0) {
          const token = queue.shift();
          if (token !== undefined) yield token;
        } else if (done) {
          break;
        } else {
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
        }
      }
    } finally {
      signal?.removeEventListener("abort", abortHandler);
    }

    if (error) throw error;
  }

  private async *streamFetch(
    messages: Message[],
    model: string,
    maxTokens: number,
    temperature: number,
    signal?: AbortSignal
  ): AsyncGenerator<string> {
    const res = await fetch(`${this.openAIBaseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages,
        max_tokens: maxTokens,
        temperature,
        stream: true,
      }),
      signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (!res.body) throw new Error("No response body");

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data: ")) continue;
        const payload = trimmed.slice(6);
        if (payload === "[DONE]") return;

        try {
          const delta = JSON.parse(payload).choices?.[0]?.delta?.content;
          if (delta) yield delta;
        } catch {
          // Skip malformed chunks from the stream.
        }
      }
    }
  }
}
