import type { Message, SamplingParams } from "../shared/types";
import type { ChatRequest } from "../shared/chatRequest";
import type { ChatClient } from "./chatClient";
import type { CompletionResult, StreamResult, UsageResult, StopReason } from "./usageTypes";
import type { ToolCall } from "../tools/types";
import type { LMStudioModel, LMStudioModelListResult } from "./types";
import { formatOpenAITools } from "../tools/formatters/openai";
import { resolveLMStudioBaseUrls } from "./urlResolution";
import { normalizeModelList } from "./modelNormalization";
import { requestJson, createModelListError } from "./httpTransport";
import { isRecord } from "./parsing";
import { streamNode, streamFetch } from "./streamingTransport";
import { buildCompletionPayload } from "./buildPayload";
import { formatRagContext } from "../rag/formatContext";

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
    const openAITools = request.tools?.length
      ? formatOpenAITools(request.tools)
      : undefined;
    const payload = buildCompletionPayload(model, messages, params, false, openAITools);

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
          try {
            toolCalls.push({
              id: (tc.id as string) ?? "",
              name: (fn.name as string) ?? "",
              arguments: JSON.parse(fn.arguments as string),
            });
          } catch (e) {
            console.error(`[tool] Failed to parse tool call "${fn.name}" (${tc.id}):`, e);
          }
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
    onToolCallStreaming?: (index: number, name: string) => void,
  ): StreamResult {
    const messages = this.buildMessages(request);
    const openAITools = request.tools?.length
      ? formatOpenAITools(request.tools)
      : undefined;
    const url = `${this.openAIBaseUrl}/chat/completions`;
    const body = buildCompletionPayload(model, messages, params, true, openAITools);

    // Tool call accumulation state.
    const pendingToolCalls = new Map<number, { id: string; name: string; argChunks: string[] }>();
    const completedToolCalls: ToolCall[] = [];
    let streamStopReason: StopReason = "unknown";
    let resolveToolCalls: (value: ToolCall[] | null) => void;
    let resolveStopReason: (value: StopReason) => void;
    const toolCallsPromise = new Promise<ToolCall[] | null>((r) => { resolveToolCalls = r; });
    const stopReasonPromise = new Promise<StopReason>((r) => { resolveStopReason = r; });

    const onEvent = openAITools ? (json: unknown): void => {
      const record = json as Record<string, unknown>;
      const choices = record.choices as Array<Record<string, unknown>> | undefined;
      const choice = choices?.[0];
      const delta = choice?.delta as Record<string, unknown> | undefined;
      const toolCallDeltas = delta?.tool_calls as Array<Record<string, unknown>> | undefined;

      // Track finish_reason from streaming chunks.
      if (choice?.finish_reason && typeof choice.finish_reason === "string") {
        streamStopReason = mapOpenAIStopReason(choice.finish_reason);
      }

      if (toolCallDeltas) {
        for (const tc of toolCallDeltas) {
          const idx = tc.index as number;
          if (tc.id) {
            const fn = tc.function as Record<string, unknown> | undefined;
            const name = (fn?.name as string) ?? "";
            pendingToolCalls.set(idx, { id: tc.id as string, name, argChunks: [] });
            onToolCallStreaming?.(idx, name);
          }
          const fn = tc.function as Record<string, unknown> | undefined;
          if (fn?.arguments && typeof fn.arguments === "string") {
            pendingToolCalls.get(idx)?.argChunks.push(fn.arguments);
          }
        }
      }
    } : undefined;

    const rawDeltas = this.bypassCors
      ? streamNode(url, body, signal, undefined, undefined, onEvent)
      : streamFetch(url, body, signal, undefined, undefined, onEvent);

    // Wrap so we can resolve tool calls when the stream ends.
    async function* wrappedDeltas(): AsyncGenerator<string> {
      try {
        yield* rawDeltas;
      } finally {
        // Finalize any pending tool calls.
        for (const [, pending] of pendingToolCalls) {
          try {
            completedToolCalls.push({
              id: pending.id,
              name: pending.name,
              arguments: JSON.parse(pending.argChunks.join("")),
            });
          } catch (e) {
            console.error(`[tool] Failed to parse tool call "${pending.name}" (${pending.id}):`, e);
          }
        }
        pendingToolCalls.clear();
        resolveToolCalls(completedToolCalls.length > 0 ? completedToolCalls : null);
        resolveStopReason(streamStopReason);
      }
    }

    return { deltas: wrappedDeltas(), usage: Promise.resolve(null), toolCalls: toolCallsPromise, stopReason: stopReasonPromise };
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

    if (request.additionalContextItems) {
      for (const item of request.additionalContextItems) {
        messages.push({
          role: "system",
          content: `---\nContext note (${item.filePath}):\n${item.content}`,
        });
      }
    }

    for (const turn of request.messages) {
      if (turn.role === "assistant" && turn.toolCalls && turn.toolCalls.length > 0) {
        messages.push({
          role: "assistant",
          content: turn.content || null,
          tool_calls: turn.toolCalls.map((tc) => ({
            id: tc.id,
            type: "function" as const,
            function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
          })),
        });
      } else if (turn.role === "tool") {
        messages.push({
          role: "tool",
          content: turn.content ?? "",
          tool_call_id: turn.toolCallId,
        });
      } else {
        messages.push({ role: turn.role as "system" | "user" | "assistant", content: turn.content ?? "" });
      }
    }

    // RAG context is appended to the last user message (not a system message)
    // to prevent prompt injection from retrieved content being treated as instructions.
    if (request.ragContext && request.ragContext.length > 0 && messages.length > 0) {
      const lastIdx = messages.length - 1;
      if (messages[lastIdx].role === "user") {
        messages[lastIdx] = {
          ...messages[lastIdx],
          content: messages[lastIdx].content + "\n\n" + formatRagContext(request.ragContext),
        };
      }
    }

    return messages;
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
