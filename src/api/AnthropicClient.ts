import type { SamplingParams } from "../shared/types";
import type { ChatRequest } from "../shared/chatRequest";
import type { ChatClient } from "./chatClient";
import type { UsageResult, StreamResult, CompletionResult, StopReason } from "./usageTypes";
import type { ToolCall } from "../tools/types";
import { formatAnthropicTools, formatAnthropicToolsWithSearch } from "../tools/formatters/anthropic";
import type { AnthropicToolEntry } from "../tools/formatters/anthropic";
import { nodeRequestWithHeaders } from "./httpTransport";
import { withRetry } from "./retry";
import { streamNode } from "./streamingTransport";
import type { DeltaExtractor } from "./streamingTransport";
import { ANTHROPIC_BASE_URL, ANTHROPIC_VERSION } from "./anthropicConstants";
import { parseToolArguments } from "./parsing";
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

/**
 * Formats the request's tools for the wire. With {@link ChatRequest.toolSearch} set
 * (Layer 2, ADR-0009) it prepends the native tool-search entry and defers the tail;
 * otherwise it emits the Layer-1 flat list. Undefined when there are no tools, so the
 * payload omits `tools` entirely.
 */
function formatRequestTools(request: ChatRequest): AnthropicToolEntry[] | undefined {
  if (!request.tools?.length) return undefined;
  return request.toolSearch
    ? formatAnthropicToolsWithSearch(request.tools, request.toolSearch)
    : formatAnthropicTools(request.tools);
}

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
    const { system, messages } = buildAnthropicMessages(request, cacheSettings, model);
    const anthropicTools = formatRequestTools(request);
    const payload = buildAnthropicPayload(model, system, messages, params, false, anthropicTools);

    // Wrap the request in withRetry so a transient 429 / 5xx (incl. 529
    // overloaded) is retried with backoff, matching the LM Studio / OpenAI
    // model-list path and the Anthropic SDK's own default. isRetryable rejects
    // 4xx and aborts, so a bad payload still fails fast.
    const { body } = await withRetry(
      () =>
        nodeRequestWithHeaders(
          "POST",
          ANTHROPIC_BASE_URL,
          "/v1/messages",
          payload,
          signal,
          buildAnthropicHeaders(this.apiKey, ANTHROPIC_VERSION)
        ),
      { signal }
    );

    const json = JSON.parse(body) as Record<string, unknown>;
    if (json.type === "error") {
      const err = json.error as Record<string, unknown> | undefined;
      throw new Error(err?.message as string ?? "Anthropic API error");
    }

    const content = json.content as Array<Record<string, unknown>> | undefined;
    const textParts: string[] = [];
    const toolCalls: ToolCall[] = [];
    const thinkingBlocks: Record<string, unknown>[] = [];

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
        } else if (block.type === "thinking" || block.type === "redacted_thinking") {
          // Verbatim capture for the tool-use round trip (signature included).
          thinkingBlocks.push(block);
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
      thinkingBlocks: thinkingBlocks.length > 0 ? thinkingBlocks : null,
    };
  }

  stream(
    request: ChatRequest,
    model: string,
    params: SamplingParams,
    signal?: AbortSignal,
    onToolCallStreaming?: (index: number, name: string) => void,
  ): StreamResult {
    const cacheSettings = request.anthropicCacheSettings;
    const { system, messages } = buildAnthropicMessages(request, cacheSettings, model);
    const anthropicTools = formatRequestTools(request);
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

    let resolveThinkingBlocks: (value: unknown[] | null) => void;
    const thinkingBlocksPromise = new Promise<unknown[] | null>((r) => {
      resolveThinkingBlocks = r;
    });

    // Tool call accumulation state.
    const pendingToolCalls = new Map<number, { id: string; name: string; jsonChunks: string[] }>();
    const completedToolCalls: ToolCall[] = [];

    // Thinking-block accumulation (adaptive thinking + tool use, P1-6 lift).
    // Blocks are captured VERBATIM, signature included, because Anthropic
    // requires them echoed back unmodified with the tool results; under the
    // default display ("omitted" on current-gen models) the thinking text can
    // legitimately be empty while the signature still matters.
    const pendingThinking = new Map<number, { thinking: string; signature: string }>();
    const completedThinkingBlocks: Record<string, unknown>[] = [];

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
          const idx = record.index as number;
          const name = block.name as string;
          pendingToolCalls.set(idx, { id: block.id as string, name, jsonChunks: [] });
          onToolCallStreaming?.(idx, name);
        } else if (block?.type === "thinking") {
          pendingThinking.set(record.index as number, { thinking: "", signature: "" });
        } else if (block?.type === "redacted_thinking") {
          // Redacted blocks arrive whole (opaque data, no deltas); keep verbatim.
          completedThinkingBlocks.push({ type: "redacted_thinking", data: block.data });
        }
      } else if (record.type === "content_block_delta") {
        const delta = record.delta as Record<string, unknown> | undefined;
        if (delta?.type === "input_json_delta") {
          pendingToolCalls.get(record.index as number)?.jsonChunks.push(delta.partial_json as string);
        } else if (delta?.type === "thinking_delta") {
          const pending = pendingThinking.get(record.index as number);
          if (pending) pending.thinking += (delta.thinking as string) ?? "";
        } else if (delta?.type === "signature_delta") {
          const pending = pendingThinking.get(record.index as number);
          if (pending) pending.signature = (delta.signature as string) ?? "";
        }
      } else if (record.type === "content_block_stop") {
        const idx = record.index as number;
        const pending = pendingToolCalls.get(idx);
        if (pending) {
          // Malformed (or empty) args surface as {} rather than dropping the call,
          // so the tool loop returns a self-correcting validation error on the
          // timeline step and the model can retry — a dropped call would silently
          // vanish from the turn.
          completedToolCalls.push({
            id: pending.id,
            name: pending.name,
            arguments: parseToolArguments(pending.jsonChunks.join("")),
          });
          pendingToolCalls.delete(idx);
        }
        const thinking = pendingThinking.get(idx);
        if (thinking) {
          completedThinkingBlocks.push({
            type: "thinking",
            thinking: thinking.thinking,
            signature: thinking.signature,
          });
          pendingThinking.delete(idx);
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
      resolveThinkingBlocks(completedThinkingBlocks.length > 0 ? completedThinkingBlocks : null);
    };

    // Wrap the raw generator so we can resolve usage + tool calls when it ends.
    const rawGenerator = streamNode(
      url, payload, signal, buildAnthropicHeaders(this.apiKey, ANTHROPIC_VERSION), anthropicDeltaExtractor, onEvent
    );

    /**
     * Wraps the raw SSE generator to resolve deferred promises once the stream
     * ends. CONTRACT: promises resolve only after `deltas` is fully consumed
     * (iterated to completion, thrown, or returned).
     */
    async function* wrappedDeltas(): AsyncGenerator<string> {
      try {
        yield* rawGenerator;
      } finally {
        resolveAndFinish();
      }
    }

    return {
      deltas: wrappedDeltas(),
      usage: usagePromise,
      toolCalls: toolCallsPromise,
      stopReason: stopReasonPromise,
      thinkingBlocks: thinkingBlocksPromise,
    };
  }

}

/**
 * Maps Anthropic's `stop_reason` onto the provider-independent {@link StopReason}.
 *
 * Layer 2 (ADR-0009) adds the native tool-search server tool. The common tool-search
 * turn ends with `tool_use`: the server resolves the search inline, appends the matched
 * schema, and the model emits a (client-side) tool_use the loop then executes, so no new
 * stop reason is needed. The edge case is `pause_turn`: the server-tool loop can hit its
 * ~10-iteration cap (e.g. many back-to-back searches) and pause for resumption.
 *
 * `pause_turn` maps to its own {@link StopReason} (not `"unknown"`), so the tool loop can
 * render an accurate recoverable message (the server-tool loop paused, regenerate to
 * continue) instead of misclassifying the in-flight server_tool_use tokens as
 * reasoning-only output (see {@link ../chat/actions/toolLoop.checkForFailedToolCall}).
 * The plugin does NOT auto-resume a paused turn: that would mean echoing the
 * server_tool_use / tool_search_tool_result blocks back verbatim, which the
 * provider-agnostic conversation model does not carry. Resumption is the deferred option,
 * to be built only if a live gate ever observes a real `pause_turn` (ADR-0009
 * B-hardening; the realistic tool-search flow resolves to a client tool_use long before
 * the cap, so this is near-unreachable in practice).
 */
function mapAnthropicStopReason(raw: string | undefined): StopReason {
  switch (raw) {
    case "end_turn": return "end_turn";
    case "tool_use": return "tool_use";
    case "max_tokens": return "max_tokens";
    case "pause_turn": return "pause_turn";
    default: return "unknown";
  }
}
