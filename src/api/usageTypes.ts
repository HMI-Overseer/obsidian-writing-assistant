import type { ToolCall } from "../tools/types";
import type { SessionRebuildReason } from "../shared/types";

/** Token usage returned by a provider after a completion request. */
export interface UsageResult {
  inputTokens: number;
  outputTokens: number;
  /** Tokens written to cache (Anthropic only). */
  cacheCreationInputTokens?: number;
  /** Tokens read from cache (Anthropic only). */
  cacheReadInputTokens?: number;
  /**
   * Actual cost (USD) reported directly by the provider, when available.
   * Claude Code supplies this from its `total_cost_usd` result field; preferred
   * over the token-based `estimateCost()` since the plugin has no price table
   * for a subscription-billed harness.
   */
  costUsd?: number;
  /**
   * Claude Code only: whether this turn reused the live session (true) or
   * cold-rebuilt it (false). Undefined for every other provider and for Claude
   * Code turns without a persistent session (Phase 0 cache instrumentation).
   */
  sessionReused?: boolean;
  /** Claude Code only: when the session cold-rebuilt, the change that drove it. */
  sessionRebuildReason?: SessionRebuildReason;
}

/**
 * Why the model stopped generating. `pause_turn` is Anthropic's server-tool pause:
 * the server-side tool loop (e.g. tool search) hit its iteration cap before the model
 * emitted a client tool call or a final answer. It maps to its own value (not
 * `"unknown"`) so the tool loop can surface a distinct, accurate recoverable message
 * (regenerate to continue) rather than auto-resuming the paused turn (ADR-0009
 * B-hardening; resumption is the deferred option, see
 * {@link ../chat/actions/toolLoop.checkForFailedToolCall} and mapAnthropicStopReason).
 */
export type StopReason = "end_turn" | "tool_use" | "max_tokens" | "pause_turn" | "unknown";

/** Wrapper returned by ChatClient.stream(). */
export interface StreamResult {
  /** Async generator yielding text deltas. */
  deltas: AsyncGenerator<string>;
  /** Resolves when the stream ends. null if the provider does not report usage. */
  usage: Promise<UsageResult | null>;
  /** Resolves when the stream ends. null if the model returned no tool calls. */
  toolCalls: Promise<ToolCall[] | null>;
  /** Resolves when the stream ends with the reason the model stopped. */
  stopReason: Promise<StopReason>;
}

/** Wrapper returned by ChatClient.complete(). */
export interface CompletionResult {
  text: string;
  usage: UsageResult | null;
  toolCalls?: ToolCall[] | null;
  stopReason?: StopReason;
}
