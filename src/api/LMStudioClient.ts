import type { Message, SamplingParams } from "../shared/types";
import type { ChatRequest } from "../shared/chatRequest";
import type { ChatClient } from "./chatClient";
import type { CompletionResult, StreamResult, UsageResult } from "./usageTypes";
import type { LMStudioModel, LMStudioModelListResult } from "./types";
import { resolveLMStudioBaseUrls } from "./urlResolution";
import { normalizeModelList } from "./modelNormalization";
import { requestJson, createModelListError } from "./httpTransport";
import { isRecord } from "./parsing";
import { streamNode, streamFetch } from "./streamingTransport";
import { buildCompletionPayload } from "./buildPayload";

// Re-export for consumers that import from this file
export { normalizeLMStudioBaseUrl } from "./urlResolution";
export type { LMStudioModelListSource, LMStudioModelListResult } from "./types";

export class LMStudioClient implements ChatClient {
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
    request: ChatRequest,
    model: string,
    params: SamplingParams,
    signal?: AbortSignal
  ): Promise<CompletionResult> {
    const messages = this.buildMessages(request);
    const payload = buildCompletionPayload(model, messages, params, false);

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

    const text = (json.choices as Array<{ message?: { content?: string } }>)[0]?.message?.content ?? "";

    // Extract usage from OpenAI-compatible response.
    let usage: UsageResult | null = null;
    const rawUsage = json.usage as Record<string, unknown> | undefined;
    if (rawUsage) {
      const inputTokens = typeof rawUsage.prompt_tokens === "number" ? rawUsage.prompt_tokens : 0;
      const outputTokens = typeof rawUsage.completion_tokens === "number" ? rawUsage.completion_tokens : 0;
      if (inputTokens > 0 || outputTokens > 0) {
        usage = { inputTokens, outputTokens };
      }
    }

    return { text, usage };
  }

  stream(
    request: ChatRequest,
    model: string,
    params: SamplingParams,
    signal?: AbortSignal
  ): StreamResult {
    const messages = this.buildMessages(request);
    const url = `${this.openAIBaseUrl}/chat/completions`;
    const body = buildCompletionPayload(model, messages, params, true);

    const deltas = this.bypassCors
      ? streamNode(url, body, signal)
      : streamFetch(url, body, signal);

    // OpenAI-compatible streaming doesn't include usage in SSE deltas.
    return { deltas, usage: Promise.resolve(null) };
  }

  private buildMessages(request: ChatRequest): Message[] {
    const messages: Message[] = [];

    if (request.systemPrompt) {
      messages.push({ role: "system", content: request.systemPrompt });
    }

    if (request.documentContext) {
      const label = request.documentContext.isFull
        ? `Document to edit (${request.documentContext.filePath})`
        : `Current note (${request.documentContext.filePath})`;
      messages.push({
        role: "system",
        content: `---\n${label}:\n${request.documentContext.content}`,
      });
    }

    for (const turn of request.messages) {
      messages.push({ role: turn.role, content: turn.content });
    }

    return messages;
  }
}
