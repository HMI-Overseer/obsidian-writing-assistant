import type { SamplingParams } from "../shared/types";
import type { ChatRequest } from "../shared/chatRequest";
import type { ChatClient } from "./chatClient";
import type { UsageResult, StreamResult, CompletionResult, StopReason } from "./usageTypes";
import type { ToolCall } from "../tools/types";
import { formatAnthropicTools } from "../tools/formatters/anthropic";
import { nodeRequestWithHeaders } from "./httpTransport";
import { streamNode } from "./streamingTransport";
import type { DeltaExtractor } from "./streamingTransport";
import { ANTHROPIC_BASE_URL, ANTHROPIC_VERSION } from "./anthropicConstants";
import {
  buildAnthropicMessages,
  buildAnthropicHeaders,
  buildAnthropicPayload,
} from "./buildAnthropicPayload";

/** Extracts text deltas from Anthropic SSE content_block_delta events. */
const anthropicDeltaExtractor: DeltaExtractor = (json: unknown): string | null => {
  const record = json as Record<string, unknown>;
  if (record.type === "content_block_delta") {
    const delta = record.delta as Record<string, unknown> | undefined;
    if (delta?.type === "text_delta" && typeof delta.text === "string") {
      return delta.text;
    }
  }
  return null;
};

function extractUsageFromJson(json: Record<string, unknown>): UsageResult | null {
  const usage = json.usage as Record<string, unknown> | undefined;
  if (!usage) return null;

  const inputTokens = typeof usage.input_tokens === "number" ? usage.input_tokens : 0;
  const outputTokens = typeof usage.output_tokens === "number" ? usage.output_tokens : 0;

  const result: UsageResult = { inputTokens, outputTokens };

  if (typeof usage.cache_creation_input_tokens === "number") {
    result.cacheCreationInputTokens = usage.cache_creation_input_tokens;
  }
  if (typeof usage.cache_read_input_tokens === "number") {
    result.cacheReadInputTokens = usage.cache_read_input_tokens;
  }

  return result;
}

export class AnthropicClient implements ChatClient {
  constructor(private readonly apiKey: string) {
    if (!apiKey) {
      throw new Error(
        "Anthropic API key not configured. Add your key in Settings → General → Provider API Keys."
      );
    }
  }

  async complete(
    request: ChatRequest,
    model: string,
    params: SamplingParams,
    signal?: AbortSignal
  ): Promise<CompletionResult> {
    const cacheSettings = request.anthropicCacheSettings;
    const { system, messages } = buildAnthropicMessages(request, cacheSettings);
    const anthropicTools = request.tools?.length
      ? formatAnthropicTools(request.tools)
      : undefined;
    const payload = buildAnthropicPayload(model, system, messages, params, false, anthropicTools);

    const { body } = await nodeRequestWithHeaders(
      "POST",
      ANTHROPIC_BASE_URL,
      "/v1/messages",
      payload,
      signal,
      buildAnthropicHeaders(this.apiKey, ANTHROPIC_VERSION, cacheSettings)
    );

    const json = JSON.parse(body) as Record<string, unknown>;
    if (json.type === "error") {
      const err = json.error as Record<string, unknown> | undefined;
      throw new Error(err?.message as string ?? "Anthropic API error");
    }

    const content = json.content as Array<Record<string, unknown>> | undefined;
    const textParts: string[] = [];
    const toolCalls: ToolCall[] = [];

    if (content) {
      for (const block of content) {
        if (block.type === "text" && typeof block.text === "string") {
          textParts.push(block.text);
        } else if (block.type === "tool_use") {
          toolCalls.push({
            id: block.id as string,
            name: block.name as string,
            arguments: (block.input as Record<string, unknown>) ?? {},
          });
        }
      }
    }

    const text = textParts.join("");
    const usage = extractUsageFromJson(json);
    const stopReason = mapAnthropicStopReason(json.stop_reason as string | undefined);

    return {
      text,
      usage,
      toolCalls: toolCalls.length > 0 ? toolCalls : null,
      stopReason,
    };
  }

  stream(
    request: ChatRequest,
    model: string,
    params: SamplingParams,
    signal?: AbortSignal
  ): StreamResult {
    const cacheSettings = request.anthropicCacheSettings;
    const { system, messages } = buildAnthropicMessages(request, cacheSettings);
    const anthropicTools = request.tools?.length
      ? formatAnthropicTools(request.tools)
      : undefined;
    const payload = buildAnthropicPayload(model, system, messages, params, true, anthropicTools);
    const url = `${ANTHROPIC_BASE_URL}/v1/messages`;

    // Accumulate usage from SSE metadata events.
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheCreationInputTokens: number | undefined;
    let cacheReadInputTokens: number | undefined;
    let streamStopReason: StopReason = "unknown";
    let resolved = false;
    let resolveUsage: (value: UsageResult | null) => void;
    let resolveToolCalls: (value: ToolCall[] | null) => void;
    let resolveStopReason: (value: StopReason) => void;

    const usagePromise = new Promise<UsageResult | null>((r) => { resolveUsage = r; });
    const toolCallsPromise = new Promise<ToolCall[] | null>((r) => { resolveToolCalls = r; });
    const stopReasonPromise = new Promise<StopReason>((r) => { resolveStopReason = r; });

    // Tool call accumulation state.
    const pendingToolCalls = new Map<number, { id: string; name: string; jsonChunks: string[] }>();
    const completedToolCalls: ToolCall[] = [];

    const onEvent = (json: unknown): void => {
      const record = json as Record<string, unknown>;

      if (record.type === "message_start") {
        const message = record.message as Record<string, unknown> | undefined;
        const usage = message?.usage as Record<string, unknown> | undefined;
        if (usage) {
          if (typeof usage.input_tokens === "number") inputTokens = usage.input_tokens;
          if (typeof usage.cache_creation_input_tokens === "number") {
            cacheCreationInputTokens = usage.cache_creation_input_tokens;
          }
          if (typeof usage.cache_read_input_tokens === "number") {
            cacheReadInputTokens = usage.cache_read_input_tokens;
          }
        }
      } else if (record.type === "message_delta") {
        const usage = record.usage as Record<string, unknown> | undefined;
        if (usage && typeof usage.output_tokens === "number") {
          outputTokens = usage.output_tokens;
        }
        const delta = record.delta as Record<string, unknown> | undefined;
        if (delta?.stop_reason) {
          streamStopReason = mapAnthropicStopReason(delta.stop_reason as string);
        }
      } else if (record.type === "content_block_start") {
        const block = record.content_block as Record<string, unknown> | undefined;
        if (block?.type === "tool_use") {
          pendingToolCalls.set(record.index as number, {
            id: block.id as string,
            name: block.name as string,
            jsonChunks: [],
          });
        }
      } else if (record.type === "content_block_delta") {
        const delta = record.delta as Record<string, unknown> | undefined;
        if (delta?.type === "input_json_delta") {
          pendingToolCalls.get(record.index as number)?.jsonChunks.push(delta.partial_json as string);
        }
      } else if (record.type === "content_block_stop") {
        const pending = pendingToolCalls.get(record.index as number);
        if (pending) {
          try {
            const raw = pending.jsonChunks.join("");
            completedToolCalls.push({
              id: pending.id,
              name: pending.name,
              arguments: raw ? JSON.parse(raw) : {},
            });
          } catch (e) {
            console.error(`[tool] Failed to parse tool call "${pending.name}" (${pending.id}):`, e);
          }
          pendingToolCalls.delete(record.index as number);
        }
      }
    };

    const resolveAndFinish = (): void => {
      if (resolved) return;
      resolved = true;

      if (inputTokens > 0 || outputTokens > 0) {
        const result: UsageResult = { inputTokens, outputTokens };
        if (cacheCreationInputTokens !== undefined) result.cacheCreationInputTokens = cacheCreationInputTokens;
        if (cacheReadInputTokens !== undefined) result.cacheReadInputTokens = cacheReadInputTokens;
        resolveUsage(result);
      } else {
        resolveUsage(null);
      }

      resolveToolCalls(completedToolCalls.length > 0 ? completedToolCalls : null);
      resolveStopReason(streamStopReason);
    };

    // Wrap the raw generator so we can resolve usage + tool calls when it ends.
    const rawGenerator = streamNode(
      url, payload, signal, buildAnthropicHeaders(this.apiKey, ANTHROPIC_VERSION, cacheSettings), anthropicDeltaExtractor, onEvent
    );

    async function* wrappedDeltas(): AsyncGenerator<string> {
      try {
        yield* rawGenerator;
      } finally {
        resolveAndFinish();
      }
    }

    return { deltas: wrappedDeltas(), usage: usagePromise, toolCalls: toolCallsPromise, stopReason: stopReasonPromise };
  }

}

function mapAnthropicStopReason(raw: string | undefined): StopReason {
  switch (raw) {
    case "end_turn": return "end_turn";
    case "tool_use": return "tool_use";
    case "max_tokens": return "max_tokens";
    default: return "unknown";
  }
}
