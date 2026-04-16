import type { SamplingParams, AnthropicCacheSettings } from "../shared/types";
import type { ChatRequest } from "../shared/chatRequest";
import type { AnthropicTool } from "../tools/formatters/anthropic";
import { formatRagContext } from "../rag/formatContext";

const DEFAULT_MAX_TOKENS = 4096;

/** Content block types used in Anthropic messages. */
export type AnthropicContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string };

export interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
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

  if (request.additionalContextItems) {
    for (const item of request.additionalContextItems) {
      systemParts.push(`---\nContext note (${item.filePath}):\n${item.content}`);
    }
  }

  const systemText = systemParts.join("\n\n");

  const messages: AnthropicMessage[] = [];
  for (const turn of request.messages) {
    if (turn.role === "assistant" && turn.toolCalls && turn.toolCalls.length > 0) {
      // Assistant turn with tool calls: use content block array.
      const blocks: AnthropicContentBlock[] = [];
      if (turn.content) {
        blocks.push({ type: "text", text: turn.content });
      }
      for (const tc of turn.toolCalls) {
        blocks.push({ type: "tool_use", id: tc.id, name: tc.name, input: tc.arguments });
      }
      messages.push({ role: "assistant", content: blocks });
    } else if (turn.role === "tool") {
      // Tool result: Anthropic requires these as user-role messages with tool_result blocks.
      // If the previous message is already a user-role with tool_result blocks, merge.
      const block: AnthropicContentBlock = {
        type: "tool_result",
        tool_use_id: turn.toolCallId ?? "",
        content: turn.content ?? "",
      };
      const prev = messages[messages.length - 1];
      if (prev?.role === "user" && Array.isArray(prev.content)) {
        (prev.content as AnthropicContentBlock[]).push(block);
      } else {
        messages.push({ role: "user", content: [block] });
      }
    } else if (turn.role === "user" && turn.attachments?.length) {
      // User turn with image attachments: build a content-block array.
      const blocks: AnthropicContentBlock[] = [];
      for (const attachment of turn.attachments) {
        if (attachment.type === "image") {
          blocks.push({
            type: "image",
            source: { type: "base64", media_type: attachment.mimeType, data: attachment.data },
          });
        }
      }
      if (turn.content) {
        blocks.push({ type: "text", text: turn.content });
      }
      messages.push({ role: "user", content: blocks });
    } else {
      messages.push({ role: turn.role as "user" | "assistant", content: turn.content ?? "" });
    }
  }

  // Inject RAG context after conversation history to preserve cache prefix.
  // Appended to the last user message so earlier messages remain cache-stable.
  if (request.ragContext && request.ragContext.length > 0 && messages.length > 0) {
    const lastIdx = messages.length - 1;
    if (messages[lastIdx].role === "user") {
      appendTextToUserMessage(messages[lastIdx], formatRagContext(request.ragContext));
    }
  }

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
  stream: boolean,
  tools?: AnthropicTool[],
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

  if (tools && tools.length > 0) {
    body.tools = tools;
  }

  if (params.temperature !== undefined) body.temperature = params.temperature;
  if (params.topP !== null) body.top_p = params.topP;
  if (params.topK !== null) body.top_k = params.topK;
  // minP and repeatPenalty are intentionally omitted — Anthropic does not support them.

  return JSON.stringify(body);
}

/**
 * Appends a text segment to a user message, handling both plain-string
 * and content-block-array formats.
 */
function appendTextToUserMessage(message: AnthropicMessage, text: string): void {
  if (typeof message.content === "string") {
    message.content = message.content + "\n\n" + text;
  } else if (Array.isArray(message.content)) {
    (message.content as AnthropicContentBlock[]).push({ type: "text", text });
  }
}
