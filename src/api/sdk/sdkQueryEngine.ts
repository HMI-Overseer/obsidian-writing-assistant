import type { SamplingParams } from "../../shared/types";
import { createAbortError } from "../httpTransport";
import {
  extractClaudeCodeContextTokens,
  extractClaudeCodeContextWindow,
  type ClaudeCodeResultUsage,
} from "../claudeCodeProcess";
import { AbortError, query } from "./claudeAgentSdk";
import type { McpSdkServerConfigWithInstance, Options, SDKMessage } from "./claudeAgentSdk";

/**
 * SDK-backed engine for one Claude Code turn (R1: stateless, one-shot parity).
 *
 * Runs the official Agent SDK's `query()` against the user's installed `claude`
 * CLI in place of the hand-spawned subprocess, mapping SDK messages onto the same
 * text-delta + `ClaudeCodeResultUsage` shape {@link ../claudeCodeProcess.streamClaudeCode}
 * produces, so {@link ../ClaudeCodeClient.ClaudeCodeClient} can consume either path
 * symmetrically. No session is retained, every turn sends the full transcript and
 * runs with `persistSession: false` (the persistent session lands in a later phase).
 */

/**
 * Claude Code's built-in tools, removed from the model's context so it can only
 * call the plugin's MCP tools. `dontAsk` permission mode also denies anything not
 * explicitly allowed, so this list need not be exhaustive against future
 * built-ins, it just keeps the common ones out of context entirely.
 */
export const DISALLOWED_NATIVE_TOOLS: readonly string[] = [
  "Bash",
  "Edit",
  "Write",
  "Read",
  "Grep",
  "Glob",
  "WebFetch",
  "WebSearch",
  "NotebookEdit",
  "Task",
  "TodoWrite",
  "BashOutput",
  "KillShell",
  "SlashCommand",
  "ExitPlanMode",
];

/**
 * Extended-thinking budget (tokens) for each reasoning level. Thinking is emitted
 * before the visible answer, so a non-zero budget delays the first user-facing
 * token, we keep it at 0 unless the profile explicitly asks for reasoning, which
 * keeps time-to-first-token low.
 */
const THINKING_BUDGET_BY_LEVEL: Record<NonNullable<SamplingParams["reasoning"]>, number> = {
  off: 0,
  low: 4096,
  medium: 10000,
  high: 24000,
  on: 10000,
};

/** Maps the profile's reasoning level to a thinking-token budget (0 when unset). */
export function thinkingBudget(reasoning: SamplingParams["reasoning"]): number {
  return reasoning ? THINKING_BUDGET_BY_LEVEL[reasoning] : 0;
}

export interface SdkTurnOptions {
  /** Flat prompt carrying the full transcript + context (R1 sends everything each turn). */
  prompt: string;
  model: string;
  /** Plugin behavioral instructions, appended to Claude Code's own system prompt. */
  systemPrompt: string;
  reasoning: SamplingParams["reasoning"];
  /** Resolved `claude` executable path passed to the SDK as `pathToClaudeCodeExecutable`. */
  claudePath: string;
  /** Subprocess working directory, the vault root. */
  vaultRoot?: string;
  /**
   * In-process MCP server bridging the plugin's toolstack. When present, Claude
   * Code runs agentically with native tools disabled; when absent it runs as a
   * pure analyst with no tools.
   */
  sdkMcp?: { server: McpSdkServerConfigWithInstance; serverName: string };
  signal?: AbortSignal;
  /** Receives the terminal usage/cost once the turn completes cleanly. */
  onResult?: (usage: ClaudeCodeResultUsage) => void;
}

/**
 * Streams one SDK-driven turn as text deltas, forwarding terminal usage via
 * `onResult`. Aborts surface as an `AbortError`-named error so the chat layer's
 * abort handling recognizes them; SDK/CLI errors surface as plain `Error`s.
 */
export async function* streamSdkTurn(opts: SdkTurnOptions): AsyncGenerator<string> {
  if (opts.signal?.aborted) throw createAbortError();

  const abortController = new AbortController();
  const onAbort = () => abortController.abort();
  opts.signal?.addEventListener("abort", onAbort, { once: true });

  try {
    const session = query({ prompt: opts.prompt, options: buildSdkOptions(opts, abortController) });
    let contextTokens: number | null = null;
    for await (const message of session) {
      const text = textDelta(message);
      if (text) {
        yield text;
        continue;
      }

      contextTokens = extractClaudeCodeContextTokens(message) ?? contextTokens;

      if (message.type === "assistant" && message.error) {
        throw new Error(`Claude Code error: ${message.error}`);
      }

      if (message.type === "result") {
        if (message.subtype !== "success" || message.is_error) {
          throw new Error(resultErrorMessage(message));
        }
        opts.onResult?.(resultUsage(message, contextTokens));
      }
    }
  } catch (error) {
    if (opts.signal?.aborted || error instanceof AbortError) throw createAbortError();
    throw error;
  } finally {
    opts.signal?.removeEventListener("abort", onAbort);
  }
}

/**
 * The slice of a turn's runtime + profile that shapes the SDK `Options`. Shared by
 * the one-shot engine ({@link streamSdkTurn}) and the persistent session
 * ({@link ./sdkSession.SdkSession}) so both bake an identical option set, the
 * session's {@link ../harnessSession.fingerprint} guards reuse against any of these
 * changing.
 */
export interface SdkOptionsConfig {
  model: string;
  systemPrompt: string;
  reasoning: SamplingParams["reasoning"];
  /** Resolved `claude` executable path passed as `pathToClaudeCodeExecutable`. */
  claudePath: string;
  /** Subprocess working directory, the vault root. */
  vaultRoot?: string;
  /** In-process MCP bridge; absent ⇒ the model runs as a pure analyst (no tools). */
  sdkMcp?: { server: McpSdkServerConfigWithInstance; serverName: string };
}

/**
 * Builds the SDK `Options` for a turn (or a session's whole lifetime) from the
 * plugin's runtime + profile. The caller owns the `abortController` so it can
 * cancel either a single turn (one-shot) or dispose a live session.
 */
export function buildSdkOptions(
  opts: SdkOptionsConfig,
  abortController: AbortController,
): Options {
  const budget = thinkingBudget(opts.reasoning);
  const systemPrompt = opts.systemPrompt.trim();

  const options: Options = {
    abortController,
    cwd: opts.vaultRoot,
    pathToClaudeCodeExecutable: opts.claudePath,
    model: opts.model,
    // Model B's win lands later; R1 retains nothing on disk or in memory.
    persistSession: false,
    // Controlled harness: ignore the user's global/project settings, hooks, and
    // other MCP servers, the plugin owns the entire tool + prompt surface.
    settingSources: [],
    includePartialMessages: true,
    systemPrompt: {
      type: "preset",
      preset: "claude_code",
      ...(systemPrompt ? { append: systemPrompt } : {}),
    },
    thinking: budget > 0 ? { type: "enabled", budgetTokens: budget } : { type: "disabled" },
    env: {
      ...process.env,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:
        process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC ?? "1",
      DISABLE_NON_ESSENTIAL_MODEL_CALLS:
        process.env.DISABLE_NON_ESSENTIAL_MODEL_CALLS ?? "1",
    },
  };

  if (opts.sdkMcp) {
    // Overrule Claude Code's own toolstack with the plugin's: bridge the in-process
    // server, auto-approve its tools, deny everything else (`dontAsk`), and strip
    // the common native tools from context entirely.
    options.mcpServers = { [opts.sdkMcp.serverName]: opts.sdkMcp.server };
    options.allowedTools = [`mcp__${opts.sdkMcp.serverName}`];
    options.disallowedTools = [...DISALLOWED_NATIVE_TOOLS];
    options.permissionMode = "dontAsk";
  } else {
    // No MCP bridge, run as a pure analyst with no tools at all.
    options.tools = [];
  }

  return options;
}

/**
 * Extracts an incremental text delta from a streamed `stream_event` message.
 * Returns null for any message that is not a streamed text delta. Mirrors the
 * legacy `extractClaudeCodeDelta`, but reads the SDK's typed partial-message
 * envelope instead of raw stream-json.
 */
export function textDelta(message: SDKMessage): string | null {
  if (message.type !== "stream_event") return null;
  const event = message.event as { type?: string; delta?: { type?: string; text?: unknown } };
  if (event.type !== "content_block_delta") return null;
  const delta = event.delta;
  if (delta?.type === "text_delta" && typeof delta.text === "string") return delta.text;
  return null;
}

/**
 * Maps a successful SDK `result` message onto the plugin's usage/cost shape.
 * `contextTokens` is the last per-call context size the caller observed via
 * {@link extractClaudeCodeContextTokens} while streaming this turn.
 */
export function resultUsage(
  message: Extract<SDKMessage, { type: "result" }>,
  contextTokens?: number | null,
): ClaudeCodeResultUsage {
  const usage = message.usage;
  const result: ClaudeCodeResultUsage = {
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    costUsd: message.total_cost_usd,
    sessionId: message.session_id,
  };
  if (typeof usage.cache_creation_input_tokens === "number") {
    result.cacheCreationInputTokens = usage.cache_creation_input_tokens;
  }
  if (typeof usage.cache_read_input_tokens === "number") {
    result.cacheReadInputTokens = usage.cache_read_input_tokens;
  }
  const contextWindow = extractClaudeCodeContextWindow(message.modelUsage);
  if (contextWindow !== null) result.contextWindow = contextWindow;
  if (typeof contextTokens === "number") result.contextTokens = contextTokens;
  return result;
}

/** Best-effort human-readable message from a failed `result`. */
export function resultErrorMessage(message: Extract<SDKMessage, { type: "result" }>): string {
  if (message.subtype !== "success" && message.errors.length > 0) {
    return `Claude Code error: ${message.errors.join("; ")}`;
  }
  if (message.subtype === "success" && message.result) return message.result;
  return `Claude Code error: ${message.subtype}`;
}
