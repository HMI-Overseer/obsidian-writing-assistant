import type { Message, SamplingParams } from "../shared/types";
import type { ChatRequest } from "../shared/chatRequest";
import type { ChatClient } from "./chatClient";
import type {
  CompletionResult,
  UsageResult,
  StopReason,
} from "./usageTypes";
import type {
  AssistantStreamAttemptContext,
  AssistantStreamRun,
} from "./assistantStreamRun";
import { createLinkedAbort } from "./assistantStreamRuntime";
import type { ToolCall } from "../tools/types";
import { formatOpenAITools } from "../tools/formatters/openai";
import { normalizeModelList } from "./modelNormalization";
import { requestJson } from "./httpTransport";
import { generateId } from "../utils";
import { isRecord, parseToolArguments } from "./parsing";
import { streamFetch } from "./streamingTransport";
import { buildCompletionPayload } from "./buildPayload";
import { OpenAICompatibleStreamTranslator } from "./openAICompatibleStreamTranslator";
import {
  CaptureFrameQueue,
  createAssistantCaptureStream,
} from "./assistantCaptureStream";
import { buildOpenAICompatibleMessages } from "./buildOpenAICompatibleMessages";

export interface OpenAIModelListResult {
  models: Array<{ id: string; name: string }>;
}

export class OpenAIClient implements ChatClient {
  private readonly headers: Record<string, string>;

  constructor(
    private readonly apiKey: string,
    private readonly baseUrl: string,
  ) {
    this.headers = {
      "Authorization": `Bearer ${apiKey}`,
    };
  }

  async listModels(signal?: AbortSignal): Promise<Array<{ id: string; name: string }>> {
    const payload = await requestJson(
      "GET", this.baseUrl, "/models", false, undefined, signal, this.headers,
    );
    const models = normalizeModelList(payload, "openai");
    if (!models) {
      throw new Error("OpenAI returned an unexpected model list response.");
    }
    return models.map((m) => ({ id: m.id, name: m.displayName }));
  }

  async complete(
    request: ChatRequest,
    model: string,
    params: SamplingParams,
    signal?: AbortSignal,
  ): Promise<CompletionResult> {
    const messages = this.buildMessages(request);
    const openAITools = request.tools?.length
      ? formatOpenAITools(request.tools)
      : undefined;
    const payload = buildCompletionPayload(model, messages, params, false, openAITools);

    const json = await requestJson(
      "POST", this.baseUrl, "/chat/completions", false, payload, signal, this.headers,
    );
    if (!isRecord(json)) {
      throw new Error("OpenAI returned an invalid chat completion response.");
    }

    const choice = (json.choices as Array<Record<string, unknown>>)?.[0];
    const message = choice?.message as Record<string, unknown> | undefined;
    const text = (typeof message?.content === "string" ? message.content : "") ?? "";

    const toolCalls = extractToolCalls(message);
    const usage = extractUsage(json);
    const stopReason = mapOpenAIStopReason(choice?.finish_reason as string | undefined);

    return { text, usage, toolCalls, stopReason };
  }

  stream(
    request: ChatRequest,
    model: string,
    params: SamplingParams,
    attempt: AssistantStreamAttemptContext,
  ): AssistantStreamRun {
    const messages = this.buildMessages(request);
    const openAITools = request.tools?.length
      ? formatOpenAITools(request.tools)
      : undefined;
    const url = `${this.baseUrl}/chat/completions`;
    const body = buildCompletionPayload(model, messages, params, true, openAITools, true);

    const translator = new OpenAICompatibleStreamTranslator({
      segmentId: `segment-${generateId()}`,
      provider: "openai",
    });
    // One chunk becomes one capture batch. A tool call whose provider ID arrives
    // on a later chunk therefore stays a later identity-only batch, rather than
    // being folded back into the batch that declared it.
    const frames = new CaptureFrameQueue(translator);
    const transport = createLinkedAbort(attempt);
    const rawStream = streamFetch(
      url,
      body,
      transport.signal,
      this.headers,
      undefined,
      frames.onPayload,
    );

    return createAssistantCaptureStream(rawStream, frames, translator, {
      attempt,
      provider: "openai",
      abort: () => {
        transport.abort();
        transport.release();
      },
    });
  }

  private buildMessages(request: ChatRequest): Message[] {
    return buildOpenAICompatibleMessages(request);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractToolCalls(message: Record<string, unknown> | undefined): ToolCall[] | null {
  const rawToolCalls = message?.tool_calls as Array<Record<string, unknown>> | undefined;
  if (!rawToolCalls || rawToolCalls.length === 0) return null;

  const toolCalls: ToolCall[] = [];
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
  return toolCalls.length > 0 ? toolCalls : null;
}

function extractUsage(json: Record<string, unknown>): UsageResult | null {
  const rawUsage = json.usage as Record<string, unknown> | undefined;
  if (!rawUsage) return null;

  const inputTokens = typeof rawUsage.prompt_tokens === "number" ? rawUsage.prompt_tokens : 0;
  const outputTokens = typeof rawUsage.completion_tokens === "number" ? rawUsage.completion_tokens : 0;
  if (inputTokens > 0 || outputTokens > 0) {
    return { inputTokens, outputTokens };
  }
  return null;
}

function mapOpenAIStopReason(raw: string | undefined): StopReason {
  switch (raw) {
    case "stop": return "end_turn";
    case "tool_calls": return "tool_use";
    case "length": return "max_tokens";
    default: return "unknown";
  }
}
