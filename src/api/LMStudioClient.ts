import type { Message } from "../shared/types";
import type { LMStudioModel, LMStudioModelListResult } from "./types";
import { resolveLMStudioBaseUrls } from "./urlResolution";
import { normalizeModelList } from "./modelNormalization";
import { requestJson, createModelListError } from "./httpTransport";
import { isRecord } from "./parsing";
import { streamNode, streamFetch } from "./streamingTransport";

// Re-export for consumers that import from this file
export { normalizeLMStudioBaseUrl } from "./urlResolution";
export type { LMStudioModelListSource, LMStudioModelListResult } from "./types";

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

  async listModelsWithSource(signal?: AbortSignal): Promise<LMStudioModelListResult> {
    const nativeEndpoint = `${this.nativeApiBaseUrl}/models`;

    try {
      const payload = await requestJson("GET", this.nativeApiBaseUrl, "/models", this.bypassCors, undefined, signal);
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
        const payload = await requestJson("GET", this.openAIBaseUrl, "/models", this.bypassCors, undefined, signal);
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

    const json = await requestJson(
      "POST",
      this.openAIBaseUrl,
      "/chat/completions",
      this.bypassCors,
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
    const url = `${this.openAIBaseUrl}/chat/completions`;
    const body = JSON.stringify({
      model,
      messages,
      max_tokens: maxTokens,
      temperature,
      stream: true,
    });

    if (this.bypassCors) {
      yield* streamNode(url, body, signal);
    } else {
      yield* streamFetch(url, body, signal);
    }
  }
}
