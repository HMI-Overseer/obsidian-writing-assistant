import type {
  AssistantReplayEvidence,
  ProviderReplayCapsule,
  ProviderTurnCapabilities,
} from "../shared/types";
import { validateProviderReplayCapsule } from "../chat/turns/assistantTurnValidation";
import type {
  AssistantStreamEvent,
  AssistantStreamMetadata,
  StopReason,
  UsageResult,
} from "./usageTypes";

const ANTHROPIC_CAPABILITIES: ProviderTurnCapabilities = {
  captureOrder: "exact",
  toolCorrelation: "provider_id",
  coldReplay: "structural",
  nativeResume: false,
};

export interface AnthropicStreamTranslatorOptions {
  segmentId: string;
}

export interface TranslatedAnthropicStream extends AssistantStreamMetadata {
  events: AssistantStreamEvent[];
}

interface PendingThinking {
  thinking: string;
  signature: string;
}

/**
 * Stateful, transport-free translation of Anthropic SSE payloads.
 *
 * The translator preserves content-block order while keeping provider-private
 * thinking blocks outside visible prose. It is attempt-local and deterministic.
 */
export class AnthropicStreamTranslator {
  private readonly segmentId: string;
  private messageId: string | undefined;
  private started = false;
  private ended = false;
  private inputTokens = 0;
  private outputTokens = 0;
  private cacheCreationInputTokens: number | undefined;
  private cacheReadInputTokens: number | undefined;
  private stopReason: StopReason = "unknown";
  private readonly pendingThinking = new Map<number, PendingThinking>();
  private readonly thinkingBlocks: ProviderReplayCapsule["thinkingBlocks"] = [];
  private capsuleInvalid = false;

  constructor(options: AnthropicStreamTranslatorOptions) {
    requireNonEmpty(options.segmentId, "segmentId");
    this.segmentId = options.segmentId;
  }

  translate(value: unknown): AssistantStreamEvent[] {
    const record = asRecord(value);
    if (!record) return [];
    const events: AssistantStreamEvent[] = [];

    if (record.type === "message_start") {
      const message = asRecord(record.message);
      const providerMessageId =
        typeof message?.id === "string" && message.id.trim()
          ? message.id
          : undefined;
      this.messageId = providerMessageId;
      events.push(...this.start(providerMessageId));
      this.captureUsage(asRecord(message?.usage));
      return events;
    }

    events.push(...this.start());
    if (record.type === "content_block_start") {
      events.push(...this.translateBlockStart(record));
    } else if (record.type === "content_block_delta") {
      events.push(...this.translateBlockDelta(record));
    } else if (record.type === "content_block_stop") {
      this.finishThinkingBlock(record.index);
    } else if (record.type === "message_delta") {
      this.captureUsage(asRecord(record.usage));
      const delta = asRecord(record.delta);
      if (typeof delta?.stop_reason === "string") {
        this.stopReason = mapAnthropicStopReason(delta.stop_reason);
      }
    } else if (record.type === "message_stop") {
      events.push(...this.finishEvents());
    }
    return events;
  }

  finishEvents(): AssistantStreamEvent[] {
    if (this.ended) return [];
    const events = this.start();
    for (const index of this.pendingThinking.keys()) {
      this.finishThinkingBlock(index);
    }
    this.ended = true;
    events.push(
      { type: "segment_end", segmentId: this.segmentId },
      { type: "turn_end", status: "completed" },
    );
    return events;
  }

  /**
   * Anthropic's `message.id` is unique per request, so it needs no further
   * scope qualification to stay collision-free across attempts.
   */
  providerMessageKey(): string | undefined {
    return this.messageId;
  }

  metadata(): AssistantStreamMetadata {
    const replayCapsule = this.validatedReplayCapsule();
    const replayEvidence: AssistantReplayEvidence =
      this.capsuleInvalid
        ? {
            tier: "textual",
            capabilities: {
              ...ANTHROPIC_CAPABILITIES,
              coldReplay: "textual",
            },
            loweredReason: "anthropic_replay_capsule_invalid",
          }
        : {
            tier: "structural",
            capabilities: { ...ANTHROPIC_CAPABILITIES },
          };
    return {
      usage: this.usage(),
      stopReason: this.stopReason,
      replayCapsule,
      replayEvidence,
    };
  }

  private start(providerMessageId?: string): AssistantStreamEvent[] {
    if (this.started) return [];
    this.started = true;
    return [{
      type: "segment_start",
      segmentId: this.segmentId,
      ...(providerMessageId === undefined ? {} : { providerMessageId }),
    }];
  }

  private translateBlockStart(
    record: Record<string, unknown>,
  ): AssistantStreamEvent[] {
    const index = validIndex(record.index);
    const block = asRecord(record.content_block);
    if (index === null || !block) return [];
    if (block.type === "text") {
      return typeof block.text === "string" && block.text.length > 0
        ? [{
            type: "prose_delta",
            segmentId: this.segmentId,
            delta: block.text,
          }]
        : [];
    }
    if (block.type === "tool_use") {
      const declarationKey = this.declarationKey(index);
      const events: AssistantStreamEvent[] = [{
        type: "tool_call_start",
        segmentId: this.segmentId,
        declarationKey,
        ...(typeof block.name === "string" && block.name.length > 0
          ? { toolName: block.name }
          : {}),
      }];
      if (typeof block.id === "string" && block.id.trim().length > 0) {
        events.push({
          type: "tool_call_identity",
          declarationKey,
          toolCallId: block.id,
          correlation: "provider_id",
        });
      }
      const initialInput = block.input;
      if (
        typeof initialInput === "object" &&
        initialInput !== null &&
        !Array.isArray(initialInput) &&
        Object.keys(initialInput).length > 0
      ) {
        events.push({
          type: "tool_call_delta",
          declarationKey,
          argumentsDelta: JSON.stringify(initialInput),
        });
      }
      return events;
    }
    if (block.type === "thinking") {
      this.pendingThinking.set(index, {
        thinking: typeof block.thinking === "string" ? block.thinking : "",
        signature: typeof block.signature === "string" ? block.signature : "",
      });
    } else if (block.type === "redacted_thinking") {
      if (typeof block.data === "string") {
        this.thinkingBlocks.push({
          type: "redacted_thinking",
          data: block.data,
        });
      } else {
        this.capsuleInvalid = true;
      }
    }
    return [];
  }

  private translateBlockDelta(
    record: Record<string, unknown>,
  ): AssistantStreamEvent[] {
    const index = validIndex(record.index);
    const delta = asRecord(record.delta);
    if (index === null || !delta) return [];
    if (delta.type === "text_delta" && typeof delta.text === "string") {
      return delta.text.length > 0
        ? [{
            type: "prose_delta",
            segmentId: this.segmentId,
            delta: delta.text,
          }]
        : [];
    }
    if (
      delta.type === "input_json_delta" &&
      typeof delta.partial_json === "string" &&
      delta.partial_json.length > 0
    ) {
      return [{
        type: "tool_call_delta",
        declarationKey: this.declarationKey(index),
        argumentsDelta: delta.partial_json,
      }];
    }
    const pending = this.pendingThinking.get(index);
    if (delta.type === "thinking_delta" && pending) {
      if (typeof delta.thinking === "string") {
        pending.thinking += delta.thinking;
      } else {
        this.capsuleInvalid = true;
      }
    } else if (delta.type === "signature_delta" && pending) {
      if (typeof delta.signature === "string") {
        pending.signature += delta.signature;
      } else {
        this.capsuleInvalid = true;
      }
    }
    return [];
  }

  private finishThinkingBlock(rawIndex: unknown): void {
    const index = validIndex(rawIndex);
    if (index === null) return;
    const pending = this.pendingThinking.get(index);
    if (!pending) return;
    this.thinkingBlocks.push({
      type: "thinking",
      thinking: pending.thinking,
      signature: pending.signature,
    });
    this.pendingThinking.delete(index);
  }

  private declarationKey(index: number): string {
    return `${this.segmentId}:block:${index}`;
  }

  private captureUsage(usage: Record<string, unknown> | null): void {
    if (!usage) return;
    if (typeof usage.input_tokens === "number") {
      this.inputTokens = usage.input_tokens;
    }
    if (typeof usage.output_tokens === "number") {
      this.outputTokens = usage.output_tokens;
    }
    if (typeof usage.cache_creation_input_tokens === "number") {
      this.cacheCreationInputTokens = usage.cache_creation_input_tokens;
    }
    if (typeof usage.cache_read_input_tokens === "number") {
      this.cacheReadInputTokens = usage.cache_read_input_tokens;
    }
  }

  private usage(): UsageResult | null {
    if (this.inputTokens === 0 && this.outputTokens === 0) return null;
    return {
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      ...(this.cacheCreationInputTokens === undefined
        ? {}
        : { cacheCreationInputTokens: this.cacheCreationInputTokens }),
      ...(this.cacheReadInputTokens === undefined
        ? {}
        : { cacheReadInputTokens: this.cacheReadInputTokens }),
    };
  }

  private validatedReplayCapsule(): ProviderReplayCapsule | null {
    if (this.thinkingBlocks.length === 0) return null;
    const candidate: ProviderReplayCapsule = {
      provider: "anthropic",
      version: 1,
      thinkingBlocks: structuredClone(this.thinkingBlocks),
    };
    const validation = validateProviderReplayCapsule(candidate);
    if (!validation.ok) {
      this.capsuleInvalid = true;
      return null;
    }
    return structuredClone(validation.value);
  }
}

export function translateAnthropicStream(
  events: readonly unknown[],
  options: AnthropicStreamTranslatorOptions,
): TranslatedAnthropicStream {
  const translator = new AnthropicStreamTranslator(options);
  const translatedEvents = events.flatMap((event) => translator.translate(event));
  translatedEvents.push(...translator.finishEvents());
  return {
    events: translatedEvents,
    ...translator.metadata(),
  };
}

function mapAnthropicStopReason(raw: string): StopReason {
  switch (raw) {
    case "end_turn":
      return "end_turn";
    case "tool_use":
      return "tool_use";
    case "max_tokens":
      return "max_tokens";
    case "pause_turn":
      return "pause_turn";
    default:
      return "unknown";
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function validIndex(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) >= 0
    ? value as number
    : null;
}

function requireNonEmpty(value: string, label: string): void {
  if (value.trim().length === 0) {
    throw new Error(`${label} must be non-empty.`);
  }
}
