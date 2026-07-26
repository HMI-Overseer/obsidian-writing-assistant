import type { Message, OpenAIContentPart, SamplingParams } from "../shared/types";
import type { ChatRequest } from "../shared/chatRequest";
import type { ChatClient } from "./chatClient";
import { appendNoteImageContextToOpenAIMessage, appendTextToOpenAIMessage } from "./openAiMessageContent";
import {
  formatAdditionalContextItem,
  formatDocumentContext,
  formatNoteAttachment,
  noteImageLabel,
} from "./contextFormatting";
import type {
  AssistantStreamEvent,
  CompletionResult,
  StreamResult,
  UsageResult,
  StopReason,
} from "./usageTypes";
import type { ToolCall } from "../tools/types";
import { formatOpenAITools } from "../tools/formatters/openai";
import { normalizeModelList } from "./modelNormalization";
import { requestJson } from "./httpTransport";
import { generateId } from "../utils";
import { isRecord, parseToolArguments } from "./parsing";
import { streamFetch } from "./streamingTransport";
import { buildCompletionPayload } from "./buildPayload";
import { formatRagContext } from "../rag/formatContext";
import { OpenAICompatibleStreamTranslator } from "./openAICompatibleStreamTranslator";
import { createAssistantEventStream } from "./assistantEventStream";

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
    signal?: AbortSignal,
  ): StreamResult {
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
    const pendingEvents: AssistantStreamEvent[] = [];
    const rawStream = streamFetch(
      url,
      body,
      signal,
      this.headers,
      undefined,
      (event) => pendingEvents.push(...translator.translate(event)),
    );

    return createAssistantEventStream(rawStream, pendingEvents, translator);
  }

  private buildMessages(request: ChatRequest): Message[] {
    const messages: Message[] = [];

    if (request.systemPrompt) {
      messages.push({ role: "system", content: request.systemPrompt });
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
      } else if (turn.role === "user" && turn.attachments?.length) {
        // User turn with attachments: build multipart content array. Note
        // snapshots and embedded images follow the user's text, frozen on this turn.
        const parts: OpenAIContentPart[] = [];
        if (turn.content) {
          parts.push({ type: "text", text: turn.content });
        }
        for (const attachment of turn.attachments) {
          if (attachment.type === "note") {
            parts.push({ type: "text", text: formatNoteAttachment(attachment) });
          }
        }
        for (const attachment of turn.attachments) {
          if (attachment.type === "image") {
            if (attachment.sourceNotePath) {
              parts.push({
                type: "text",
                text: noteImageLabel(attachment.sourceNotePath, attachment.fileName ?? "image"),
              });
            }
            parts.push({
              type: "image_url",
              image_url: { url: `data:${attachment.mimeType};base64,${attachment.data}` },
            });
          }
        }
        messages.push({ role: "user", content: parts });
      } else {
        messages.push({ role: turn.role, content: turn.content ?? "" });
      }
    }

    // Edit-mode live context (document under edit + extra notes) appended to the
    // latest user message, kept out of the system messages so it stays in the
    // conversation.
    if (messages.length > 0 && messages[messages.length - 1].role === "user") {
      const last = messages[messages.length - 1];
      if (request.documentContext) {
        appendTextToOpenAIMessage(last, formatDocumentContext(request.documentContext));
      }
      if (request.additionalContextItems) {
        for (const item of request.additionalContextItems) {
          appendTextToOpenAIMessage(last, formatAdditionalContextItem(item));
        }
      }
    }

    if (request.noteImageContext?.length && messages.length > 0) {
      const lastIdx = messages.length - 1;
      if (messages[lastIdx].role === "user") {
        appendNoteImageContextToOpenAIMessage(messages[lastIdx], request.noteImageContext);
      }
    }

    if (request.ragContext && request.ragContext.length > 0 && messages.length > 0) {
      const lastIdx = messages.length - 1;
      if (messages[lastIdx].role === "user") {
        appendTextToOpenAIMessage(messages[lastIdx], formatRagContext(request.ragContext));
      }
    }

    return messages;
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
