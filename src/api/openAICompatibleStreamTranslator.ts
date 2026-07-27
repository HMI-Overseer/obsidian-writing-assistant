import type {
  AssistantReplayEvidence,
  ProviderTurnCapabilities,
} from "../shared/types";
import type {
  AssistantStreamEvent,
  AssistantStreamMetadata,
  StopReason,
  UsageResult,
} from "./usageTypes";

export type OpenAICompatibleProvider = "openai" | "lmstudio";

export interface OpenAICompatibleStreamTranslatorOptions {
  segmentId: string;
  provider: OpenAICompatibleProvider;
}

export interface TranslatedOpenAICompatibleStream
  extends AssistantStreamMetadata {
  events: AssistantStreamEvent[];
}

interface DeclarationState {
  index: number;
  declarationKey: string;
  name: string;
  argumentsText: string;
  toolCallId?: string;
}

const OPENAI_COMPATIBLE_CAPABILITIES: ProviderTurnCapabilities = {
  captureOrder: "exact",
  toolCorrelation: "provider_id",
  coldReplay: "structural",
  nativeResume: false,
};

/**
 * Attempt-local translator shared by OpenAI and LM Studio.
 *
 * Indexed declaration identity remains separate from the provider call ID. Missing
 * IDs are not filled until the segment is complete.
 */
export class OpenAICompatibleStreamTranslator {
  private readonly segmentId: string;
  private readonly declarations = new Map<number, DeclarationState>();
  private started = false;
  private ended = false;
  private providerMessageId: string | undefined;
  private stopReason: StopReason = "unknown";
  private usageValue: UsageResult | null = null;
  private missingProviderId = false;
  private invalidArguments = false;
  private captureDegraded = false;

  constructor(options: OpenAICompatibleStreamTranslatorOptions) {
    requireNonEmpty(options.segmentId, "segmentId");
    this.segmentId = options.segmentId;
  }

  translate(value: unknown): AssistantStreamEvent[] {
    const record = asRecord(value);
    if (!record) {
      this.captureDegraded = true;
      return [];
    }
    if (
      this.providerMessageId === undefined &&
      typeof record.id === "string" &&
      record.id.trim().length > 0
    ) {
      this.providerMessageId = record.id;
    }
    const events = this.start();
    const usage = extractUsage(record);
    if (usage) this.usageValue = usage;

    const choices = Array.isArray(record.choices) ? record.choices : [];
    const choice = asRecord(choices[0]);
    if (!choice) return events;
    if (typeof choice.finish_reason === "string") {
      this.stopReason = mapOpenAIStopReason(choice.finish_reason);
    }
    const delta = asRecord(choice.delta);
    if (!delta) return events;

    for (const key of Object.keys(delta)) {
      if (key === "content" && typeof delta.content === "string") {
        if (delta.content.length > 0) {
          events.push({
            type: "prose_delta",
            segmentId: this.segmentId,
            delta: delta.content,
          });
        }
      } else if (key === "tool_calls") {
        events.push(...this.translateToolCalls(delta.tool_calls));
      }
    }
    return events;
  }

  finishEvents(): AssistantStreamEvent[] {
    if (this.ended) return [];
    const events = this.start();
    const declarations = [...this.declarations.values()]
      .sort((left, right) => left.index - right.index);
    for (const declaration of declarations) {
      if (declaration.toolCallId !== undefined) continue;
      this.missingProviderId = true;
      events.push({
        type: "tool_call_identity",
        declarationKey: declaration.declarationKey,
        toolCallId: `lmsa-tool-${this.segmentId}-${declaration.index}`,
        correlation: "plugin_id",
      });
    }
    this.invalidArguments = declarations.some(
      (declaration) => !isJsonObject(declaration.argumentsText),
    );
    this.ended = true;
    events.push(
      { type: "segment_end", segmentId: this.segmentId },
      { type: "turn_end", status: "completed" },
    );
    return events;
  }

  /**
   * The completion ID every chunk of one response repeats, unique per request,
   * so it needs no further scope qualification. A server that omits it leaves
   * this undefined and its items honestly unplaced.
   */
  providerMessageKey(): string | undefined {
    return this.providerMessageId;
  }

  metadata(): AssistantStreamMetadata {
    const capabilities: ProviderTurnCapabilities = {
      ...OPENAI_COMPATIBLE_CAPABILITIES,
      ...(this.captureDegraded ? { captureOrder: "segment" as const } : {}),
      ...(this.missingProviderId
        ? { toolCorrelation: "plugin_id" as const }
        : {}),
      ...(this.invalidArguments ? { coldReplay: "textual" as const } : {}),
    };
    const loweredReason = this.invalidArguments
      ? "tool_arguments_invalid"
      : this.missingProviderId
        ? "provider_tool_call_id_missing"
        : this.captureDegraded
          ? "provider_chunk_invalid"
          : undefined;
    const replayEvidence: AssistantReplayEvidence = {
      tier: this.invalidArguments ? "textual" : "structural",
      capabilities,
      ...(loweredReason === undefined ? {} : { loweredReason }),
    };
    return {
      usage: this.usageValue,
      stopReason: this.stopReason,
      replayCapsule: null,
      replayEvidence,
    };
  }

  private start(): AssistantStreamEvent[] {
    if (this.started) return [];
    this.started = true;
    return [{
      type: "segment_start",
      segmentId: this.segmentId,
      ...(this.providerMessageId === undefined
        ? {}
        : { providerMessageId: this.providerMessageId }),
    }];
  }

  private translateToolCalls(value: unknown): AssistantStreamEvent[] {
    if (!Array.isArray(value)) {
      this.captureDegraded = true;
      return [];
    }
    const events: AssistantStreamEvent[] = [];
    for (const rawToolCall of value) {
      const toolCall = asRecord(rawToolCall);
      const index = validIndex(toolCall?.index);
      if (!toolCall || index === null) {
        this.captureDegraded = true;
        continue;
      }
      const fn = asRecord(toolCall.function);
      const incomingName = typeof fn?.name === "string" ? fn.name : "";
      let declaration = this.declarations.get(index);
      if (!declaration) {
        declaration = {
          index,
          declarationKey: `${this.segmentId}:tool:${index}`,
          name: incomingName,
          argumentsText: "",
        };
        this.declarations.set(index, declaration);
        events.push({
          type: "tool_call_start",
          segmentId: this.segmentId,
          declarationKey: declaration.declarationKey,
          ...(incomingName.length > 0 ? { toolName: incomingName } : {}),
        });
      } else {
        const nameDelta = deriveNameDelta(declaration.name, incomingName);
        if (nameDelta.length > 0) {
          declaration.name += nameDelta;
          events.push({
            type: "tool_call_delta",
            declarationKey: declaration.declarationKey,
            nameDelta,
          });
        }
      }

      if (typeof toolCall.id === "string" && toolCall.id.trim().length > 0) {
        if (
          declaration.toolCallId !== undefined &&
          declaration.toolCallId !== toolCall.id
        ) {
          throw new Error(
            `Declaration "${declaration.declarationKey}" received conflicting provider IDs.`,
          );
        }
        if (declaration.toolCallId === undefined) {
          declaration.toolCallId = toolCall.id;
          events.push({
            type: "tool_call_identity",
            declarationKey: declaration.declarationKey,
            toolCallId: toolCall.id,
            correlation: "provider_id",
          });
        }
      }
      if (typeof fn?.arguments === "string" && fn.arguments.length > 0) {
        declaration.argumentsText += fn.arguments;
        events.push({
          type: "tool_call_delta",
          declarationKey: declaration.declarationKey,
          argumentsDelta: fn.arguments,
        });
      }
    }
    return events;
  }
}

export function translateOpenAICompatibleStream(
  chunks: readonly unknown[],
  options: OpenAICompatibleStreamTranslatorOptions,
): TranslatedOpenAICompatibleStream {
  const translator = new OpenAICompatibleStreamTranslator(options);
  const events = chunks.flatMap((chunk) => translator.translate(chunk));
  events.push(...translator.finishEvents());
  return { events, ...translator.metadata() };
}

function deriveNameDelta(current: string, incoming: string): string {
  if (!incoming || incoming === current) return "";
  return incoming.startsWith(current)
    ? incoming.slice(current.length)
    : incoming;
}

function extractUsage(record: Record<string, unknown>): UsageResult | null {
  const usage = asRecord(record.usage);
  if (!usage) return null;
  const inputTokens =
    typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : 0;
  const outputTokens =
    typeof usage.completion_tokens === "number" ? usage.completion_tokens : 0;
  return inputTokens > 0 || outputTokens > 0
    ? { inputTokens, outputTokens }
    : null;
}

function mapOpenAIStopReason(raw: string): StopReason {
  switch (raw) {
    case "stop":
      return "end_turn";
    case "tool_calls":
      return "tool_use";
    case "length":
      return "max_tokens";
    default:
      return "unknown";
  }
}

function isJsonObject(text: string): boolean {
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed);
  } catch {
    return false;
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
