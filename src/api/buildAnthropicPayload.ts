import type { SamplingParams, AnthropicCacheSettings } from "../shared/types";
import type { ChatRequest, NoteImageContextItem } from "../shared/chatRequest";
import type { AnthropicToolEntry } from "../tools/formatters/anthropic";
import { formatRagContext } from "../rag/formatContext";
import {
  formatAdditionalContextItem,
  formatDocumentContext,
  formatNoteAttachment,
  noteImageLabel,
} from "./contextFormatting";

const DEFAULT_MAX_TOKENS = 4096;

/**
 * Conversation cache breakpoints share the 4-per-request budget with the
 * tools + system breakpoint, so at most 3 land on the conversation. Each
 * breakpoint's cache lookup walks back at most 20 content blocks, so intermediate
 * breakpoints are spaced ~15 blocks apart to keep a long agentic turn (many
 * tool_use / tool_result blocks emitted in one turn) inside that window
 * (prompt-cache design §5 / §10, verified against the bundled claude-api
 * reference's 20-block-lookback and 4-breakpoint rules).
 */
const MAX_CONVERSATION_BREAKPOINTS = 3;
const CONVERSATION_BREAKPOINT_BLOCK_STRIDE = 15;

/**
 * Model-id prefixes whose models still accept the `temperature` / `top_p` / `top_k`
 * sampling params. Opus 4.7+, Fable 5, and Mythos REMOVED these and return HTTP 400 if
 * any is sent; Opus 4.6 and earlier, plus the Sonnet 4.x and Haiku 4.x families, still
 * accept them. Verified against docs/reference/external/anthropic-api.md and the bundled
 * claude-api reference (the sampling-removal set is Opus 4.7+, not 4.6).
 *
 * The gate is an allowlist on purpose: emit sampling only for a model known to accept
 * it, and omit for anything current-gen OR unrecognized. An unknown / future id (e.g.
 * the next Opus generation) therefore fails safe, it never 400s on a stale sampling
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
  "claude-opus-4-6", // Opus 4.6, the last Opus tier to accept sampling params
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
 * 3.x / 4.0 / 4.1 / 4.5, these use the legacy budget_tokens path, intentionally out of scope
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

/**
 * Model-id prefixes whose models accept `output_config.effort: "xhigh"`. Introduced
 * with Opus 4.7; Opus 4.6 / Sonnet 4.6 lack it (Anthropic documents unsupported
 * `xhigh` as silently falling back to `high`, but the level selector shouldn't
 * offer what a model doesn't honor).
 * `max` needs no gate of its own: every adaptive-capable model accepts it.
 */
const XHIGH_EFFORT_CAPABLE_PREFIXES = [
  "claude-opus-4-7",
  "claude-opus-4-8",
  "claude-sonnet-5",
  "claude-fable-5",
  "claude-mythos-5",
];

/** Whether this Anthropic model accepts `output_config.effort: "xhigh"`. */
export function anthropicModelSupportsXhighEffort(modelId: string): boolean {
  return XHIGH_EFFORT_CAPABLE_PREFIXES.some((prefix) => modelId.startsWith(prefix));
}

/**
 * Model-id prefixes whose models accept a mid-conversation `{role:"system"}`
 * message in the `messages` array (no beta header). Verified against the bundled
 * claude-api reference: this is Claude Opus 4.8 ONLY today, Fable 5, Sonnet 4.6,
 * and Opus 4.7 are not on the platform-availability list and return HTTP 400
 * (`role 'system' is not supported on this model`). So the gate is an allowlist:
 * any other / unrecognized id falls back to the `<system-reminder>` user-turn
 * block. Re-confirm at platform.claude.com as more models add support. The id the
 * plugin sends is the wire model id (e.g. "claude-opus-4-8"), so a prefix match
 * also covers harness-suffixed variants.
 */
const SYSTEM_ROLE_CAPABLE_PREFIXES = ["claude-opus-4-8"];

/** Whether this Anthropic model accepts a mid-conversation `{role:"system"}` message. */
export function anthropicModelSupportsSystemRole(modelId: string): boolean {
  return SYSTEM_ROLE_CAPABLE_PREFIXES.some((prefix) => modelId.startsWith(prefix));
}

/**
 * A cache breakpoint marker. `ttl: "1h"` selects the 1-hour extended cache TTL;
 * omitting it is the wire default (5-min). The extended TTL is GA and needs no
 * beta header (see buildAnthropicHeaders).
 */
export interface AnthropicCacheControl {
  type: string;
  ttl?: "1h";
}

/**
 * Content block types used in Anthropic messages. Any block may carry a
 * `cache_control` breakpoint; the conversation breakpoint (placeConversationBreakpoints)
 * lands on the last block of a stable history turn.
 */
export type AnthropicContentBlock =
  | { type: "text"; text: string; cache_control?: AnthropicCacheControl }
  | {
      type: "image";
      source: { type: "base64"; media_type: string; data: string };
      cache_control?: AnthropicCacheControl;
    }
  | {
      type: "tool_use";
      id: string;
      name: string;
      input: Record<string, unknown>;
      cache_control?: AnthropicCacheControl;
    }
  | { type: "tool_result"; tool_use_id: string; content: string; cache_control?: AnthropicCacheControl }
  // Echoed verbatim from a prior response (thinking + tool use round trip).
  // cache_control exists only for type uniformity: the breakpoint placer marks a
  // turn's LAST block, and echoed thinking always precedes the tool_use block,
  // so a breakpoint never actually lands here (adding one would modify a block
  // the API requires unmodified).
  | { type: "thinking"; thinking: string; signature: string; cache_control?: AnthropicCacheControl }
  | { type: "redacted_thinking"; data: string; cache_control?: AnthropicCacheControl };

export interface AnthropicMessage {
  // `system` is the mid-conversation operator channel: a {role:"system"} message
  // placed after the cached history (Opus 4.8+ only, see
  // anthropicModelSupportsSystemRole). It carries the per-mode tail without
  // touching the cached prefix.
  role: "user" | "assistant" | "system";
  content: string | AnthropicContentBlock[];
}

export interface AnthropicSystemBlock {
  type: "text";
  text: string;
  cache_control?: AnthropicCacheControl;
}

export type AnthropicSystem = string | AnthropicSystemBlock[];

/**
 * Converts a provider-independent ChatRequest into Anthropic-specific system + messages.
 * When caching is enabled and a system prompt exists, system is returned as a
 * content block array with `cache_control`; otherwise it's a plain string.
 */
export function buildAnthropicMessages(
  request: ChatRequest,
  cacheSettings?: AnthropicCacheSettings,
  model?: string
): { system: AnthropicSystem; messages: AnthropicMessage[] } {
  // The system block holds only the stable prompt, it carries the cache
  // breakpoint. All note/document context lives in the conversation (after the
  // breakpoint) so editing the note never voids the cached prefix.
  const systemText = request.systemPrompt ?? "";

  const messages: AnthropicMessage[] = [];
  for (const turn of request.messages) {
    if (turn.role === "assistant" && turn.toolCalls && turn.toolCalls.length > 0) {
      // Assistant turn with tool calls: use content block array. Captured
      // thinking blocks come FIRST and unmodified, with thinking enabled on a
      // tool-use turn, Anthropic requires them echoed back exactly as received
      // (signatures included; text may be empty under display "omitted").
      const blocks: AnthropicContentBlock[] = [];
      for (const block of turn.anthropicThinkingBlocks ?? []) {
        blocks.push(block as AnthropicContentBlock);
      }
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

  // Per-mode wording rides the message tail so the cached `system` block stays
  // mode-invariant (Layer 1, prompt-cache design §6.1.3). On Opus 4.8+ it's a
  // non-spoofable {role:"system"} message appended after the cached history (it
  // must follow a user turn and be the last entry, both hold here); older
  // models 400 on a system message, so it falls back to a <system-reminder>
  // block in the last user turn. Either way it sits after the breakpoint, so it
  // never invalidates the cached prefix.
  if (request.modeTail && messages.length > 0) {
    const lastIdx = messages.length - 1;
    if (messages[lastIdx].role === "user") {
      if (model && anthropicModelSupportsSystemRole(model)) {
        messages.push({ role: "system", content: request.modeTail });
      } else {
        appendTextToUserMessage(
          messages[lastIdx],
          `<system-reminder>\n${request.modeTail}\n</system-reminder>`
        );
      }
    }
  }

  if (!cacheSettings?.enabled) {
    return { system: systemText, messages };
  }

  // The selected TTL rides on every breakpoint: `ttl: "1h"` for the extended
  // cache, omitted for the wire default (5-min). `CacheTtl` "default" is an
  // internal label, not a wire value.
  const cacheControl: AnthropicCacheControl =
    cacheSettings.ttl === "1h" ? { type: "ephemeral", ttl: "1h" } : { type: "ephemeral" };

  // Conversation breakpoint(s): cache the growing history incrementally, not just
  // tools + system (prompt-cache design §6.1.6, goal G3). Anchored on the last
  // stable turn so the per-turn volatile tail (note/doc/RAG context + the modeTail
  // system/<system-reminder>) stays after the breakpoint and never voids the
  // cached prefix (§3.4 / §10).
  placeConversationBreakpoints(messages, cacheControl);

  // System breakpoint: a content block carrying cache_control caches tools +
  // system together (only when there is a system prompt to cache).
  if (systemText) {
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
  tools?: AnthropicToolEntry[],
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
    // Force one tool call per assistant turn (`disable_parallel_tool_use`). The in-loop
    // approval gate (ask mode) pauses on each tool call and feeds the user's
    // approve/decline back to the model before it writes the next; that gate is only a
    // real per-tool gate when a round holds a single call. Without this, a model emitting
    // parallel tool_use blocks commits to the whole batch up front, so the serial
    // approval UI can no longer let it respond to feedback between calls. The value is
    // constant, so it never thrashes the prompt cache: changing `tool_choice` would
    // invalidate only the messages tier, and it never changes here (tools + system stay
    // cached). Compatible with adaptive thinking: only FORCED tool_choice
    // ({type:"tool"} / "any") conflicts with thinking, `auto` +
    // disable_parallel_tool_use does not.
    body.tool_choice = { type: "auto", disable_parallel_tool_use: true };
  }

  // Reasoning: map the resolved reasoning level to adaptive thinking + the effort control
  // for models that support it. Adaptive is the only on-mode on current-gen models; effort
  // (low..max) sets depth, and "on" leaves the model default. "off"/null emit no
  // thinking. The former tool-free gate is lifted (P1-6): the tool loop now
  // round-trips the thinking blocks Anthropic requires on a tool-use turn
  // (captured verbatim in AnthropicClient, echoed first in the assistant content
  // by buildAnthropicMessages). Older / unknown models fail safe (no thinking field).
  const emitThinking =
    params.reasoning !== null &&
    params.reasoning !== "off" &&
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

/**
 * Places up to {@link MAX_CONVERSATION_BREAKPOINTS} cache breakpoints on the
 * stable conversation history so it caches incrementally turn over turn (goal G3),
 * not just tools + system.
 *
 * The newest breakpoint lands on the last *stable* turn (everything before the
 * latest user turn and any trailing modeTail system message), so the per-turn
 * volatile tail, note/doc/RAG context and the modeTail, stays after it and
 * never voids the cached prefix. Stable string turns are first normalized to
 * single-block arrays so an anchored turn renders identically whether or not it
 * carries the breakpoint in a given request (the prefix-stability invariant);
 * this keeps pure-text conversations cacheable too, not only tool-heavy ones,
 * with no reliance on string vs single-block cache equivalence.
 *
 * Intermediate breakpoints are spaced ~{@link CONVERSATION_BREAKPOINT_BLOCK_STRIDE}
 * blocks back so a single long agentic turn stays inside the 20-block lookback
 * window. One residual gap the design accepts: a single turn whose own content
 * exceeds 20 blocks (e.g. >20 parallel tool calls) cannot be bridged at message
 * granularity; cache_read staying ~0 across such turns is the signal.
 */
function placeConversationBreakpoints(
  messages: AnthropicMessage[],
  cacheControl: AnthropicCacheControl
): void {
  const stableEnd = lastStableMessageIndex(messages);
  if (stableEnd < 0) return; // No settled history yet (the opening turn).

  for (let i = 0; i <= stableEnd; i++) {
    normalizeMessageToBlocks(messages[i]);
  }

  let placed = 0;
  let blocksSinceMark = 0;
  for (let i = stableEnd; i >= 0 && placed < MAX_CONVERSATION_BREAKPOINTS; i--) {
    const blocks = messages[i].content;
    if (!Array.isArray(blocks) || blocks.length === 0) continue;
    if (placed === 0 || blocksSinceMark >= CONVERSATION_BREAKPOINT_BLOCK_STRIDE) {
      blocks[blocks.length - 1].cache_control = cacheControl;
      placed++;
      blocksSinceMark = 0;
    }
    blocksSinceMark += blocks.length;
  }
}

/**
 * Index of the last conversation turn that is stable across requests: skips a
 * trailing modeTail `{role:"system"}` turn and the latest user turn (which carries
 * the per-turn volatile context). Returns -1 when there is no settled history yet
 * (the opening turn), so no conversation breakpoint is placed.
 */
function lastStableMessageIndex(messages: AnthropicMessage[]): number {
  let i = messages.length - 1;
  if (i >= 0 && messages[i].role === "system") i--;
  if (i >= 0 && messages[i].role === "user") i--;
  return i;
}

/** Normalizes a non-empty string turn to a single text block so it can carry a breakpoint. */
function normalizeMessageToBlocks(message: AnthropicMessage): void {
  if (typeof message.content === "string" && message.content.length > 0) {
    message.content = [{ type: "text", text: message.content }];
  }
}
