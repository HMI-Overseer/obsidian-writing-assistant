import type { SamplingParams } from "../shared/types";
import type { ChatRequest, ChatTurn } from "../shared/chatRequest";
import type { ChatClient } from "./chatClient";
import type { ToolCall } from "../tools/types";
import type { CompletionResult, StreamResult, StopReason, UsageResult } from "./usageTypes";
import {
  streamClaudeCode,
  extractClaudeCodeResult,
  resolveClaudeBinary,
  type ClaudeCodeResultUsage,
} from "./claudeCodeProcess";

/**
 * Claude Code's built-in tools, removed from the model's context via
 * `--disallowedTools` so it can only call the plugin's MCP tools. `dontAsk`
 * permission mode also denies any tool not explicitly allowed, so this list need
 * not be exhaustive against future built-ins — it just keeps the common ones out
 * of context entirely.
 */
const DISALLOWED_NATIVE_TOOLS =
  "Bash,Edit,Write,Read,Grep,Glob,WebFetch,WebSearch,NotebookEdit,Task,TodoWrite,BashOutput,KillShell,SlashCommand,ExitPlanMode";

/**
 * Extended-thinking budget (tokens) for each reasoning level, passed to the CLI
 * as `MAX_THINKING_TOKENS`. Thinking is emitted before the visible answer, so a
 * non-zero budget delays the first user-facing token — we keep it at 0 unless
 * the profile explicitly asks for reasoning, which keeps time-to-first-token low.
 */
const THINKING_BUDGET_BY_LEVEL: Record<NonNullable<SamplingParams["reasoning"]>, number> = {
  off: 0,
  low: 4096,
  medium: 10000,
  high: 24000,
  on: 10000,
};

/** Maps the profile's reasoning level to a `MAX_THINKING_TOKENS` budget (0 when unset). */
export function thinkingBudget(reasoning: SamplingParams["reasoning"]): number {
  return reasoning ? THINKING_BUDGET_BY_LEVEL[reasoning] : 0;
}

/**
 * Runtime context the Claude Code client needs but that the static provider
 * settings can't supply. Resolved per-call from the plugin's services.
 */
export interface ClaudeCodeRuntime {
  /** Subprocess working directory — the vault root. */
  vaultRoot?: string;
  /**
   * In-process MCP server connection. When present, Claude Code is launched with
   * all native tools disabled and bridged to the plugin's toolstack instead.
   */
  mcp?: {
    /** JSON config string passed to `--mcp-config` describing the localhost server. */
    configJson: string;
    /** allowedTools value granting the plugin's MCP server, e.g. "mcp__writing_assistant". */
    allowedTools: string;
  };
}

/**
 * Drives the Claude Code CLI (`claude`) as a chat provider.
 *
 * Claude Code runs its own agent loop and (when an MCP runtime is supplied) uses
 * the plugin's tools through an in-process MCP server. This client spawns the
 * subprocess, streams its line-delimited JSON, and maps it onto the
 * provider-agnostic {@link ChatClient} contract. From the caller's perspective it
 * behaves like any other client: it streams text and resolves `toolCalls: null`,
 * so the plugin's own tool loop runs a single pass and exits.
 */
export class ClaudeCodeClient implements ChatClient {
  constructor(
    private readonly claudePath: string,
    private readonly runtime: ClaudeCodeRuntime = {},
  ) {}

  async complete(
    request: ChatRequest,
    model: string,
    params: SamplingParams,
    signal?: AbortSignal,
  ): Promise<CompletionResult> {
    const { args, prompt } = this.buildInvocation(request, model);
    let captured: ClaudeCodeResultUsage | null = null;
    const parts: string[] = [];

    const deltas = streamClaudeCode({
      command: this.command,
      args,
      cwd: this.runtime.vaultRoot,
      env: this.buildEnv(params),
      prompt,
      signal,
      onEvent: (json) => {
        const result = extractClaudeCodeResult(json);
        if (result) captured = result;
      },
    });

    for await (const delta of deltas) parts.push(delta);

    return {
      text: parts.join(""),
      usage: toUsageResult(captured),
      toolCalls: null,
      stopReason: "end_turn",
    };
  }

  stream(
    request: ChatRequest,
    model: string,
    params: SamplingParams,
    signal?: AbortSignal,
    _onToolCallStreaming?: (index: number, name: string) => void,
  ): StreamResult {
    const { args, prompt } = this.buildInvocation(request, model);

    let captured: ClaudeCodeResultUsage | null = null;
    let resolveUsage!: (value: UsageResult | null) => void;
    let resolveToolCalls!: (value: ToolCall[] | null) => void;
    let resolveStopReason!: (value: StopReason) => void;

    const usage = new Promise<UsageResult | null>((r) => { resolveUsage = r; });
    const toolCalls = new Promise<ToolCall[] | null>((r) => { resolveToolCalls = r; });
    const stopReason = new Promise<StopReason>((r) => { resolveStopReason = r; });

    const rawDeltas = streamClaudeCode({
      command: this.command,
      args,
      cwd: this.runtime.vaultRoot,
      env: this.buildEnv(params),
      prompt,
      signal,
      onEvent: (json) => {
        const result = extractClaudeCodeResult(json);
        if (result) captured = result;
      },
    });

    // Mirror the AnthropicClient contract: deferred promises resolve only after
    // the delta generator is fully consumed (completed, thrown, or returned).
    async function* wrappedDeltas(): AsyncGenerator<string> {
      try {
        yield* rawDeltas;
      } finally {
        resolveUsage(toUsageResult(captured));
        // Claude Code runs its own tools internally via MCP — it never returns
        // plugin tool calls through the stream.
        resolveToolCalls(null);
        resolveStopReason("end_turn");
      }
    }

    return { deltas: wrappedDeltas(), usage, toolCalls, stopReason };
  }

  private get command(): string {
    return resolveClaudeBinary(this.claudePath);
  }

  /**
   * Subprocess environment, inherited from the plugin's process plus speed
   * tuning. `*_NONESSENTIAL_*` mute the CLI's boot-time update checks, telemetry,
   * and background model calls (the dominant cold-start tax), and
   * `MAX_THINKING_TOKENS` gates extended thinking on the profile's reasoning
   * level so the first visible token isn't delayed by silent thinking.
   */
  private buildEnv(params: SamplingParams): NodeJS.ProcessEnv {
    return {
      ...process.env,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:
        process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC ?? "1",
      DISABLE_NON_ESSENTIAL_MODEL_CALLS:
        process.env.DISABLE_NON_ESSENTIAL_MODEL_CALLS ?? "1",
      MAX_THINKING_TOKENS: thinkingBudget(params.reasoning).toString(),
    };
  }

  /** Builds the CLI args + the stdin prompt for a request. */
  private buildInvocation(request: ChatRequest, model: string): { args: string[]; prompt: string } {
    const args = [
      "--print",
      "--output-format", "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--no-session-persistence",
      "--model", model,
    ];

    if (request.systemPrompt.trim()) {
      args.push("--append-system-prompt", request.systemPrompt);
    }

    if (this.runtime.mcp) {
      // Overrule Claude Code's own toolstack with the plugin's. Validated config:
      //   --disallowedTools  removes native tools from the model's context
      //   --permission-mode dontAsk  denies anything not explicitly allowed
      //   --allowedTools mcp__<server>  auto-approves the plugin's MCP tools
      // (`--tools ""` is NOT used: it also strips MCP tools, so the model gets
      // nothing to call.)
      args.push(
        "--strict-mcp-config",
        "--mcp-config", this.runtime.mcp.configJson,
        "--disallowedTools", DISALLOWED_NATIVE_TOOLS,
        "--permission-mode", "dontAsk",
        "--allowedTools", this.runtime.mcp.allowedTools,
      );
    } else {
      // No MCP bridge available — run as a pure analyst with no tools at all.
      args.push("--tools", "");
    }

    return { args, prompt: buildClaudeCodePrompt(request) };
  }
}

function toUsageResult(result: ClaudeCodeResultUsage | null): UsageResult | null {
  if (!result) return null;
  const usage: UsageResult = {
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
  };
  if (result.cacheCreationInputTokens !== undefined) {
    usage.cacheCreationInputTokens = result.cacheCreationInputTokens;
  }
  if (result.cacheReadInputTokens !== undefined) {
    usage.cacheReadInputTokens = result.cacheReadInputTokens;
  }
  if (result.costUsd !== undefined) usage.costUsd = result.costUsd;
  return usage;
}

/**
 * Flattens a {@link ChatRequest} into a single prompt string for Claude Code's
 * stdin. The active document and any attached context become labeled blocks; the
 * conversation history is rendered as a simple speaker transcript.
 *
 * RAG context is intentionally omitted when the MCP bridge is active — Claude Code
 * retrieves from the vault through the plugin's tools — but is included as a block
 * when supplied so the client also works as a plain (tool-less) analyst.
 */
export function buildClaudeCodePrompt(request: ChatRequest): string {
  const blocks: string[] = [];

  if (request.documentContext) {
    const { filePath, content } = request.documentContext;
    blocks.push(`# Active document: ${filePath}\n\n${content}`);
  }

  if (request.additionalContextItems?.length) {
    for (const item of request.additionalContextItems) {
      blocks.push(`# Attached context: ${item.fileName}\n\n${item.content}`);
    }
  }

  if (request.ragContext?.length) {
    const chunks = request.ragContext
      .map((c) => `## ${c.filePath} — ${c.headingPath}\n\n${c.content}`)
      .join("\n\n");
    blocks.push(`# Retrieved context\n\n${chunks}`);
  }

  const transcript = request.messages.map(renderTurn).filter(Boolean).join("\n\n");
  if (transcript) blocks.push(transcript);

  return blocks.join("\n\n---\n\n");
}

function renderTurn(turn: ChatTurn): string {
  if (turn.content === null || turn.content === "") return "";
  const speaker = turn.role === "assistant" ? "Assistant" : "User";
  return `${speaker}: ${turn.content}`;
}
