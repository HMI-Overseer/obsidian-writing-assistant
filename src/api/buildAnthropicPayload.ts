import type { SamplingParams, AnthropicCacheSettings } from "../shared/types";
import type { ChatRequest } from "../shared/chatRequest";

const DEFAULT_MAX_TOKENS = 4096;

export interface AnthropicMessage {
  role: "user" | "assistant";
  content: string;
}

export interface AnthropicSystemBlock {
  type: "text";
  text: string;
  cache_control?: { type: string };
}

export type AnthropicSystem = string | AnthropicSystemBlock[];

/**
 * Converts a provider-independent ChatRequest into Anthropic-specific system + messages.
 * When caching is enabled and a system prompt exists, system is returned as a
 * content block array with `cache_control`; otherwise it's a plain string.
 */
export function buildAnthropicMessages(
  request: ChatRequest,
  cacheSettings?: AnthropicCacheSettings
): { system: AnthropicSystem; messages: AnthropicMessage[] } {
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

  const systemText = systemParts.join("\n\n");

  const messages: AnthropicMessage[] = request.messages.map((turn) => ({
    role: turn.role,
    content: turn.content,
  }));

  // When caching is enabled, send system as a content block with cache_control.
  if (cacheSettings?.enabled && systemText) {
    const system: AnthropicSystemBlock[] = [
      { type: "text", text: systemText, cache_control: { type: "ephemeral" } },
    ];
    return { system, messages };
  }

  return { system: systemText, messages };
}

/** Builds Anthropic API request headers, adding the beta header when extended TTL is used. */
export function buildAnthropicHeaders(
  apiKey: string,
  anthropicVersion: string,
  cacheSettings?: AnthropicCacheSettings
): Record<string, string> {
  const headers: Record<string, string> = {
    "x-api-key": apiKey,
    "anthropic-version": anthropicVersion,
    "Content-Type": "application/json",
  };
  // Extended TTL requires a beta header.
  if (cacheSettings?.enabled && cacheSettings.ttl === "1h") {
    headers["anthropic-beta"] = "prompt-caching-2024-07-31";
  }
  return headers;
}

/** Serializes an Anthropic Messages API payload to JSON. */
export function buildAnthropicPayload(
  model: string,
  system: AnthropicSystem,
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

  // system can be a string or an array of content blocks (when caching is enabled).
  if (Array.isArray(system) ? system.length > 0 : system) {
    body.system = system;
  }

  if (params.temperature !== undefined) body.temperature = params.temperature;
  if (params.topP !== null) body.top_p = params.topP;
  if (params.topK !== null) body.top_k = params.topK;
  // minP and repeatPenalty are intentionally omitted — Anthropic does not support them.

  return JSON.stringify(body);
}
