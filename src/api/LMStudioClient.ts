import type { Message, SamplingParams } from "../shared/types";
import type { ChatRequest } from "../shared/chatRequest";
import type { ChatClient } from "./chatClient";
import type {
  AssistantStreamEvent,
  CompletionResult,
  StreamResult,
  UsageResult,
  StopReason,
} from "./usageTypes";
import type { ToolCall } from "../tools/types";
import type { LMStudioModel, LMStudioModelListResult } from "./types";
import { formatOpenAITools } from "../tools/formatters/openai";
import { resolveLMStudioBaseUrls } from "./urlResolution";
import { normalizeModelList } from "./modelNormalization";
import { requestJson, createModelListError, createTimeoutSignal } from "./httpTransport";
import { isRecord, parseToolArguments } from "./parsing";
import { streamNode, streamFetch } from "./streamingTransport";
import { buildCompletionPayload } from "./buildPayload";
import { generateId } from "../utils";
import { OpenAICompatibleStreamTranslator } from "./openAICompatibleStreamTranslator";
import { createAssistantEventStream } from "./assistantEventStream";
import { buildOpenAICompatibleMessages } from "./buildOpenAICompatibleMessages";

// Re-export for consumers that import from this file
export { normalizeLMStudioBaseUrl } from "./urlResolution";
export type { LMStudioModelListSource, LMStudioModelListResult } from "./types";

/**
 * Connection budget for the model-list probe (native attempt plus the OpenAI-compatible
 * fallback share it). Caps how long a send blocks on "checking model status" when the
 * server is unreachable but not actively refusing the connection.
 */
const MODEL_LIST_TIMEOUT_MS = 3000;

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
    // One connection budget spans both the native attempt and the OpenAI fallback: once it
    // expires, the fallback sees an already-aborted signal and fails instantly, so an
    // unreachable host caps the whole probe near MODEL_LIST_TIMEOUT_MS rather than doubling it.
    const { signal: probeSignal, cleanup } = createTimeoutSignal(MODEL_LIST_TIMEOUT_MS, signal);

    try {
      const payload = await requestJson("GET", this.nativeApiBaseUrl, "/models", this.bypassCors, undefined, probeSignal);
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
        const payload = await requestJson("GET", this.openAIBaseUrl, "/models", this.bypassCors, undefined, probeSignal);
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
    } finally {
      cleanup();
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
    const openAITools = request.tools?.length
      ? formatOpenAITools(request.tools)
      : undefined;
    const payload = buildCompletionPayload(model, messages, params, false, openAITools);

    let json: unknown;
    try {
      json = await requestJson(
        "POST",
        this.openAIBaseUrl,
        "/chat/completions",
        this.bypassCors,
        payload,
        signal
      );
    } catch (error) {
      throw decorateJinjaTemplateError(error, openAITools !== undefined);
    }
    if (!isRecord(json)) {
      throw new Error("LM Studio returned an invalid chat completion response.");
    }

    const choice = (json.choices as Array<Record<string, unknown>>)?.[0];
    const message = choice?.message as Record<string, unknown> | undefined;
    const text = (typeof message?.content === "string" ? message.content : "") ?? "";

    // Extract tool calls from the response message.
    let toolCalls: ToolCall[] | null = null;
    const rawToolCalls = message?.tool_calls as Array<Record<string, unknown>> | undefined;
    if (rawToolCalls && rawToolCalls.length > 0) {
      toolCalls = [];
      for (const tc of rawToolCalls) {
        const fn = tc.function as Record<string, unknown> | undefined;
        if (fn) {
          toolCalls.push({
            id: (tc.id as string) ?? "",
            name: (fn.name as string) ?? "",
            // Malformed args surface as {} so the loop returns a self-correcting
            // validation error on the timeline step, rather than dropping the call.
            arguments: parseToolArguments(fn.arguments as string),
          });
        }
      }
      if (toolCalls.length === 0) toolCalls = null;
    }

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

    const stopReason = mapOpenAIStopReason(choice?.finish_reason as string | undefined);

    return { text, usage, toolCalls, stopReason };
  }

  stream(
    request: ChatRequest,
    model: string,
    params: SamplingParams,
    signal?: AbortSignal,
  ): StreamResult {
    const messages = this.buildMessages(request);
    const openAITools = request.tools?.length
      ? formatOpenAITools(request.tools)
      : undefined;
    const url = `${this.openAIBaseUrl}/chat/completions`;
    const body = buildCompletionPayload(model, messages, params, true, openAITools);

    const translator = new OpenAICompatibleStreamTranslator({
      segmentId: `segment-${generateId()}`,
      provider: "lmstudio",
    });
    const pendingEvents: AssistantStreamEvent[] = [];
    const onEvent = (event: unknown): void => {
      pendingEvents.push(...translator.translate(event));
    };
    const rawStream = this.bypassCors
      ? streamNode(url, body, signal, undefined, undefined, onEvent)
      : streamFetch(url, body, signal, undefined, undefined, onEvent);

    return createAssistantEventStream(
      rawStream,
      pendingEvents,
      translator,
      (error) => decorateJinjaTemplateError(error, openAITools !== undefined),
    );
  }

  private buildMessages(request: ChatRequest): Message[] {
    return buildOpenAICompatibleMessages(request);
  }
}

function mapOpenAIStopReason(raw: string | undefined): StopReason {
  switch (raw) {
    case "stop": return "end_turn";
    case "tool_calls": return "tool_use";
    case "length": return "max_tokens";
    default: return "unknown";
  }
}

/**
 * Turns LM Studio's generic jinja-template render error into an actionable one
 * when the request carried tools. Empirically pinned by a live payload bisect
 * (gemma4 fine-tune, 2026-07-06, recorded in
 * docs/02-architecture/external/lmstudio-api.md): a bare chat request renders fine,
 * adding a single `tools` entry 400s with "Cannot call something that is not a
 * function: got UndefinedValue". Some models advertise
 * `trained_for_tool_use: true` while their (often fine-tuned) chat template's
 * tools branch calls an undefined helper, so every agentic request dies at
 * render. The capability flag can't predict this, so the remedy is surfaced at
 * the failure instead: chat without tools, or fix the template.
 */
export function decorateJinjaTemplateError(error: unknown, hadTools: boolean): unknown {
  if (!hadTools || !(error instanceof Error)) return error;
  if (!error.message.includes("jinja template")) return error;
  return new Error(
    `${error.message}\n\n` +
      "This request included the plugin's tool definitions, and this model's chat template " +
      "failed while rendering them (the model reports tool-use support, but its template's " +
      "tools section is broken). Workarounds: turn off Agentic mode (wrench icon) to chat " +
      "with this model without tools, or fix the model's prompt template in LM Studio " +
      "(My Models > Prompt Template), e.g. by copying it from an lmstudio-community variant.",
  );
}
