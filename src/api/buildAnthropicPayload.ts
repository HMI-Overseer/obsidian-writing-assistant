import type { SamplingParams, AnthropicCacheSettings } from "../shared/types";
import type { ChatRequest, NoteImageContextItem } from "../shared/chatRequest";
import type { AnthropicTool } from "../tools/formatters/anthropic";
import { formatRagContext } from "../rag/formatContext";
import {
  formatAdditionalContextItem,
  formatDocumentContext,
  formatNoteAttachment,
  noteImageLabel,
} from "./contextFormatting";

const DEFAULT_MAX_TOKENS = 4096;

/**
 * Model-id prefixes whose models still accept the `temperature` / `top_p` / `top_k`
 * sampling params. Opus 4.7+, Fable 5, and Mythos REMOVED these and return HTTP 400 if
 * any is sent; Opus 4.6 and earlier, plus the Sonnet 4.x and Haiku 4.x families, still
 * accept them. Verified against docs/reference/external/anthropic-api.md and the bundled
 * claude-api reference (the sampling-removal set is Opus 4.7+, not 4.6).
 *
 * The gate is an allowlist on purpose: emit sampling only for a model known to accept
 * it, and omit for anything current-gen OR unrecognized. An unknown / future id (e.g.
 * the next Opus generation) therefore fails safe — it never 400s on a stale sampling
 * param. This is the tactical fix; the model-aware capability layer that subsumes it is
 * tracked in docs/work/issues/anthropic-native-payload-api-drift.md (P0-1).
 */
const SAMPLING_CAPABLE_PREFIXES = [
  "claude-3", // Claude 3.x (opus / sonnet / haiku)
  "claude-sonnet-4", // Sonnet 4.0 / 4.5 / 4.6
  "claude-haiku-4", // Haiku 4.5
  "claude-opus-4-0", // Opus 4.0
  "claude-opus-4-1", // Opus 4.1
  "claude-opus-4-5", // Opus 4.5
  "claude-opus-4-6", // Opus 4.6 — the last Opus tier to accept sampling params
];

/** Whether `temperature` / `top_p` / `top_k` are safe to send to this Anthropic model. */
export function anthropicModelSupportsSampling(modelId: string): boolean {
  return SAMPLING_CAPABLE_PREFIXES.some((prefix) => modelId.startsWith(prefix));
}

/**
 * Model-id prefixes whose models support **adaptive thinking** (`thinking: {type:"adaptive"}`)
 * plus the `output_config.effort` control. Adaptive is the only on-mode on the current
 * generation; the legacy `thinking: {type:"enabled", budget_tokens:N}` 400s on Opus 4.7+/
 * Fable and is deprecated elsewhere. The effort levels this maps to (low/medium/high) are
 * valid on every model in this set. Verified against docs/reference/external/anthropic-api.md
 * and the bundled claude-api reference.
 *
 * Like the sampling gate, this is an allowlist: emit a thinking field only for a model known
 * to accept adaptive thinking, and omit for older families (Haiku 4.5, Sonnet 4.5, legacy
 * 3.x / 4.0 / 4.1 / 4.5 — these use the legacy budget_tokens path, intentionally out of scope
 * here) OR any unrecognized id. An unknown / future id therefore fails safe: no thinking
 * field, never a 400 on a stale reasoning setting. The model-aware capability layer that
 * subsumes this is tracked in docs/work/issues/anthropic-native-payload-api-drift.md (P1-6).
 */
const ADAPTIVE_THINKING_CAPABLE_PREFIXES = [
  "claude-opus-4-6", // Opus 4.6
  "claude-opus-4-7", // Opus 4.7
  "claude-opus-4-8", // Opus 4.8
  "claude-sonnet-4-6", // Sonnet 4.6
  "claude-fable-5", // Fable 5
  "claude-mythos-5", // Mythos 5 (Glasswing)
];

/** Whether this Anthropic model accepts adaptive thinking + the `effort` control. */
export function anthropicModelSupportsAdaptiveThinking(modelId: string): boolean {
  return ADAPTIVE_THINKING_CAPABLE_PREFIXES.some((prefix) => modelId.startsWith(prefix));
}

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
  // `ttl: "1h"` selects the 1-hour extended cache TTL; omitting it is the wire default
  // (5-min). The extended TTL is GA and needs no beta header (see buildAnthropicHeaders).
  cache_control?: { type: string; ttl?: "1h" };
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
  // The system block holds only the stable prompt, it carries the cache
  // breakpoint. All note/document context lives in the conversation (after the
  // breakpoint) so editing the note never voids the cached prefix.
  const systemText = request.systemPrompt ?? "";

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
      // User turn with attachments: build a content-block array. Note snapshots
      // and embedded images follow the user's text; both are frozen on this turn.
      const blocks: AnthropicContentBlock[] = [];
      if (turn.content) {
        blocks.push({ type: "text", text: turn.content });
      }
      for (const attachment of turn.attachments) {
        if (attachment.type === "note") {
          blocks.push({ type: "text", text: formatNoteAttachment(attachment) });
        }
      }
      for (const attachment of turn.attachments) {
        if (attachment.type === "image") {
          if (attachment.sourceNotePath) {
            blocks.push({
              type: "text",
              text: noteImageLabel(attachment.sourceNotePath, attachment.fileName ?? "image"),
            });
          }
          blocks.push({
            type: "image",
            source: { type: "base64", media_type: attachment.mimeType, data: attachment.data },
          });
        }
      }
      messages.push({ role: "user", content: blocks });
    } else {
      messages.push({ role: turn.role as "user" | "assistant", content: turn.content ?? "" });
    }
  }

  // Edit-mode live context (document under edit + extra notes) is re-sent each
  // turn and appended to the latest user message, after the cache breakpoint.
  if (messages.length > 0 && messages[messages.length - 1].role === "user") {
    const last = messages[messages.length - 1];
    if (request.documentContext) {
      appendTextToUserMessage(last, formatDocumentContext(request.documentContext));
    }
    if (request.additionalContextItems) {
      for (const item of request.additionalContextItems) {
        appendTextToUserMessage(last, formatAdditionalContextItem(item));
      }
    }
  }

  if (request.noteImageContext?.length && messages.length > 0) {
    const lastIdx = messages.length - 1;
    if (messages[lastIdx].role === "user") {
      appendNoteImageContextToUserMessage(messages[lastIdx], request.noteImageContext);
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

  // When caching is enabled, send system as a content block with cache_control. The
  // selected TTL rides on the block: `ttl: "1h"` for the extended cache, omitted for the
  // wire default (5-min). `CacheTtl` "default" is an internal label, not a wire value.
  if (cacheSettings?.enabled && systemText) {
    const cacheControl: AnthropicSystemBlock["cache_control"] =
      cacheSettings.ttl === "1h"
        ? { type: "ephemeral", ttl: "1h" }
        : { type: "ephemeral" };
    const system: AnthropicSystemBlock[] = [
      { type: "text", text: systemText, cache_control: cacheControl },
    ];
    return { system, messages };
  }

  return { system: systemText, messages };
}

/**
 * Builds Anthropic API request headers.
 *
 * Prompt caching needs no beta header: both base caching and the 1-hour extended cache
 * TTL are GA (the TTL is carried on the cache_control block, not a header). The retired
 * `prompt-caching-2024-07-31` header was the legacy base-caching beta and is not sent.
 */
export function buildAnthropicHeaders(
  apiKey: string,
  anthropicVersion: string
): Record<string, string> {
  return {
    "x-api-key": apiKey,
    "anthropic-version": anthropicVersion,
    "Content-Type": "application/json",
  };
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

  const hasTools = tools !== undefined && tools.length > 0;
  if (hasTools) {
    body.tools = tools;
  }

  // Reasoning: map the profile reasoning level to adaptive thinking + the effort control
  // for models that support it. Adaptive is the only on-mode on current-gen models; effort
  // (low/medium/high) sets depth, and "on" leaves the model default. "off"/null emit no
  // thinking. Gated to tool-free requests: the native tool loop does not round-trip the
  // thinking blocks Anthropic requires on a tool-use turn, so emitting thinking there would
  // 400 the follow-up. Older / unknown models fail safe (no thinking field). See P1-6.
  const emitThinking =
    params.reasoning !== null &&
    params.reasoning !== "off" &&
    !hasTools &&
    anthropicModelSupportsAdaptiveThinking(model);
  if (emitThinking) {
    body.thinking = { type: "adaptive" };
    if (params.reasoning !== "on") {
      body.output_config = { effort: params.reasoning };
    }
  }

  // Sampling params are gated by model: current-gen models (Opus 4.7+, Fable, Mythos)
  // 400 if they are sent, so they're omitted for that tier and any unknown model. They are
  // also suppressed whenever a thinking field is emitted: current-gen models steer via
  // thinking/effort, not sampling, so the two are not mixed on one request.
  if (!emitThinking && anthropicModelSupportsSampling(model)) {
    if (params.temperature !== undefined) body.temperature = params.temperature;
    if (params.topP !== null) body.top_p = params.topP;
    if (params.topK !== null) body.top_k = params.topK;
  }
  // minP and repeatPenalty are intentionally omitted, Anthropic does not support them.

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

function appendNoteImageContextToUserMessage(
  message: AnthropicMessage,
  images: NoteImageContextItem[],
): void {
  const blocks = ensureAnthropicUserBlocks(message);
  for (const image of images) {
    blocks.push({
      type: "text",
      text: `Embedded image from attached note (${image.noteFilePath}): ${image.fileName}`,
    });
    blocks.push({
      type: "image",
      source: { type: "base64", media_type: image.mimeType, data: image.data },
    });
  }
}

function ensureAnthropicUserBlocks(message: AnthropicMessage): AnthropicContentBlock[] {
  if (Array.isArray(message.content)) {
    return message.content as AnthropicContentBlock[];
  }
  const blocks: AnthropicContentBlock[] = [];
  if (typeof message.content === "string" && message.content) {
    blocks.push({ type: "text", text: message.content });
  }
  message.content = blocks;
  return blocks;
}
