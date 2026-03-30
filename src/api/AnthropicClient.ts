import type { SamplingParams } from "../shared/types";
import type { ChatRequest } from "../shared/chatRequest";
import type { ChatClient } from "./chatClient";
import type { UsageResult, StreamResult, CompletionResult } from "./usageTypes";
import { nodeRequestWithHeaders } from "./httpTransport";
import { streamNode } from "./streamingTransport";
import type { DeltaExtractor } from "./streamingTransport";
import { ANTHROPIC_BASE_URL, ANTHROPIC_VERSION } from "./anthropicConstants";
const DEFAULT_MAX_TOKENS = 4096;

interface AnthropicMessage {
  role: "user" | "assistant";
  content: string;
}

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
    const { system, messages } = this.buildMessages(request);
    const payload = this.buildPayload(model, system, messages, params, false);

    const { body } = await nodeRequestWithHeaders(
      "POST",
      ANTHROPIC_BASE_URL,
      "/v1/messages",
      payload,
      signal,
      this.buildHeaders()
    );

    const json = JSON.parse(body) as Record<string, unknown>;
    if (json.type === "error") {
      const err = json.error as Record<string, unknown> | undefined;
      throw new Error(err?.message as string ?? "Anthropic API error");
    }

    const content = json.content as Array<{ type: string; text?: string }> | undefined;
    const text = content?.[0]?.text ?? "";
    const usage = extractUsageFromJson(json);

    return { text, usage };
  }

  stream(
    request: ChatRequest,
    model: string,
    params: SamplingParams,
    signal?: AbortSignal
  ): StreamResult {
    const { system, messages } = this.buildMessages(request);
    const payload = this.buildPayload(model, system, messages, params, true);
    const url = `${ANTHROPIC_BASE_URL}/v1/messages`;

    // Accumulate usage from SSE metadata events.
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheCreationInputTokens: number | undefined;
    let cacheReadInputTokens: number | undefined;
    let usageResolved = false;
    let resolveUsage: (value: UsageResult | null) => void;

    const usagePromise = new Promise<UsageResult | null>((resolve) => {
      resolveUsage = resolve;
    });

    const onEvent = (json: unknown): void => {
      const record = json as Record<string, unknown>;

      if (record.type === "message_start") {
        // message_start carries initial usage with input_tokens.
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
        // message_delta carries final usage with output_tokens.
        const usage = record.usage as Record<string, unknown> | undefined;
        if (usage && typeof usage.output_tokens === "number") {
          outputTokens = usage.output_tokens;
        }
      }
    };

    const resolveAndFinish = (): void => {
      if (usageResolved) return;
      usageResolved = true;

      if (inputTokens > 0 || outputTokens > 0) {
        const result: UsageResult = { inputTokens, outputTokens };
        if (cacheCreationInputTokens !== undefined) result.cacheCreationInputTokens = cacheCreationInputTokens;
        if (cacheReadInputTokens !== undefined) result.cacheReadInputTokens = cacheReadInputTokens;
        resolveUsage(result);
      } else {
        resolveUsage(null);
      }
    };

    // Wrap the raw generator so we can resolve usage when it ends.
    const rawGenerator = streamNode(
      url, payload, signal, this.buildHeaders(), anthropicDeltaExtractor, onEvent
    );

    async function* wrappedDeltas(): AsyncGenerator<string> {
      try {
        yield* rawGenerator;
      } finally {
        resolveAndFinish();
      }
    }

    return { deltas: wrappedDeltas(), usage: usagePromise };
  }

  private buildHeaders(): Record<string, string> {
    return {
      "x-api-key": this.apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
      "Content-Type": "application/json",
    };
  }

  private buildMessages(request: ChatRequest): {
    system: string;
    messages: AnthropicMessage[];
  } {
    const systemParts: string[] = [];

    if (request.systemPrompt) {
      systemParts.push(request.systemPrompt);
    }

    if (request.documentContext) {
      const label = request.documentContext.isFull
        ? `Document to edit (${request.documentContext.filePath})`
        : `Current note (${request.documentContext.filePath})`;
      systemParts.push(`---\n${label}:\n${request.documentContext.content}`);
    }

    const messages: AnthropicMessage[] = request.messages.map((turn) => ({
      role: turn.role,
      content: turn.content,
    }));

    return { system: systemParts.join("\n\n"), messages };
  }

  private buildPayload(
    model: string,
    system: string,
    messages: AnthropicMessage[],
    params: SamplingParams,
    stream: boolean
  ): string {
    const body: Record<string, unknown> = {
      model,
      messages,
      max_tokens: params.maxTokens ?? DEFAULT_MAX_TOKENS,
      stream,
    };

    if (system) {
      body.system = system;
    }

    if (params.temperature !== undefined) body.temperature = params.temperature;
    if (params.topP !== null) body.top_p = params.topP;
    if (params.topK !== null) body.top_k = params.topK;
    // minP and repeatPenalty are intentionally omitted — Anthropic does not support them.

    return JSON.stringify(body);
  }
}
