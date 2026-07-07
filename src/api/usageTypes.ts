import type { ToolCall } from "../tools/types";
import type { ClaudeCodeResumeCursor, SessionRebuildReason } from "../shared/types";

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
   * Claude Code only: whether this turn reused the warm live session (true) or did
   * not (false, a disk resume or a synthetic rebuild). Undefined for every other
   * provider and for Claude Code turns without a persistent session.
   */
  sessionReused?: boolean;
  /**
   * Claude Code only: whether this turn restored the session from disk (Model A′)
   * rather than reusing a warm process or rebuilding. Mutually exclusive with
   * {@link sessionReused}.
   */
  sessionResumed?: boolean;
  /** Claude Code only: when the session cold-rebuilt, the change that drove it. */
  sessionRebuildReason?: SessionRebuildReason;
  /**
   * Claude Code only: the on-disk resume cursor this turn's session banked (Model
   * A′), forwarded so it can be persisted onto the assistant message and read back
   * next turn as the conversation's resume point.
   */
  resumeCursor?: ClaudeCodeResumeCursor;
  /**
   * Claude Code only: the model's context-window size (tokens) as the CLI itself
   * reports it (`modelUsage.contextWindow`). Feeds the capacity ring for a
   * provider whose catalog entries are CLI aliases with no static window.
   */
  contextWindow?: number;
  /**
   * Claude Code only: prompt tokens (uncached + cache read + cache write) of the
   * turn's last internal API call, i.e. the session's current context size. The
   * aggregate `inputTokens`/`cache*` fields sum every internal call of an agentic
   * turn, so they cannot stand in for context occupancy.
   */
  contextTokens?: number;
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
  /**
   * Anthropic only: raw thinking / redacted_thinking blocks captured verbatim
   * from this response, for the tool-use round trip (the tool loop attaches
   * them to the assistant turn via {@link ../shared/chatRequest.ChatTurn}).
   * Absent on providers without a thinking round-trip requirement.
   */
  thinkingBlocks?: Promise<unknown[] | null>;
}

/** Wrapper returned by ChatClient.complete(). */
export interface CompletionResult {
  text: string;
  usage: UsageResult | null;
  toolCalls?: ToolCall[] | null;
  stopReason?: StopReason;
  /** Anthropic only: raw thinking blocks, mirroring {@link StreamResult.thinkingBlocks}. */
  thinkingBlocks?: unknown[] | null;
}
