import type { SamplingParams } from "../shared/types";
import type { ChatRequest, ChatTurn } from "../shared/chatRequest";
import type { ChatClient } from "./chatClient";
import { formatNoteAttachment } from "./contextFormatting";
import type { ToolCall } from "../tools/types";
import type { CompletionResult, StreamResult, StopReason, UsageResult } from "./usageTypes";
import {
  streamClaudeCode,
  extractClaudeCodeResult,
  extractClaudeCodeContextTokens,
  resolveClaudeBinary,
  type ClaudeCodeResultUsage,
} from "./claudeCodeProcess";
import { streamSdkTurn, DISALLOWED_NATIVE_TOOLS } from "./sdk/sdkQueryEngine";
import { isEffortLevel } from "../shared/reasoning";
import type { McpSdkServerConfigWithInstance } from "./sdk/claudeAgentSdk";
import type { SessionReuseDiagnosis, SessionTurn } from "./harnessSession";

/**
 * One turn's input to the persistent-session path. The client builds both prompt
 * forms (it can't know which the session will use) and the transcript turns for the
 * reuse/linearity check; the service decides reuse vs cold rebuild and runs it.
 */
export interface SdkSessionTurnInput {
  /** Full transcript prompt, sent on a cold mint. */
  fullPrompt: string;
  /** New user turn only, sent on reuse (the live session holds the rest). */
  deltaPrompt: string;
  model: string;
  systemPrompt: string;
  reasoning: SamplingParams["reasoning"];
  /** Full live transcript including the new user turn (drives the reuse check). */
  turns: SessionTurn[];
  signal?: AbortSignal;
  onResult?: (result: ClaudeCodeResultUsage) => void;
  /** Reports whether this turn reused the live session or cold-rebuilt it. */
  onReuseDecision?: (decision: SessionReuseDiagnosis) => void;
}

/**
 * Runtime context the Claude Code client needs but that the static provider
 * settings can't supply. Resolved per-call from the plugin's services.
 */
export interface ClaudeCodeRuntime {
  /** Subprocess working directory, the vault root. */
  vaultRoot?: string;
  /**
   * Whether to drive Claude Code through the Agent SDK. False when the installed
   * CLI is missing or version-incompatible with the bundled SDK, the client then
   * falls back to the legacy one-shot `claude --print` path (the always-lit floor).
   */
  useSdk: boolean;
  /**
   * Persistent per-conversation SDK session (Model B). Present on the SDK path when
   * a conversation id is available; the client routes each turn through it for
   * context retention + incremental caching. Absent ⇒ stateless one-shot.
   */
  sdkSession?: {
    conversationId: string;
    run: (input: SdkSessionTurnInput) => AsyncGenerator<string>;
  };
  /**
   * In-process SDK MCP server bridging the plugin's toolstack. Present on the
   * stateless one-shot SDK path (no conversation id) when agentic mode is on;
   * absent ⇒ Claude Code runs as a pure analyst.
   */
  sdkMcp?: { server: McpSdkServerConfigWithInstance; serverName: string };
  /**
   * Legacy loopback-HTTP MCP bridge, used only on the fallback path. When present,
   * Claude Code is launched with all native tools disabled and bridged to the
   * plugin's toolstack instead.
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
 * the plugin's tools through an in-process MCP server. On the SDK path this client
 * delegates each turn to the official Agent SDK ({@link ./sdk/sdkQueryEngine});
 * on the fallback path it spawns the legacy one-shot subprocess. Either way it maps
 * the result onto the provider-agnostic {@link ChatClient} contract: it streams
 * text and resolves `toolCalls: null`, so the plugin's own tool loop runs a single
 * pass and exits.
 */
export class ClaudeCodeClient implements ChatClient {
  constructor(
    private readonly claudePath: string,
    private readonly runtime: ClaudeCodeRuntime = { useSdk: false },
  ) {}

  async complete(
    request: ChatRequest,
    model: string,
    params: SamplingParams,
    signal?: AbortSignal,
  ): Promise<CompletionResult> {
    let captured: ClaudeCodeResultUsage | null = null;
    let decision: SessionReuseDiagnosis | undefined;
    const parts: string[] = [];

    const deltas = this.runTurn(
      request,
      model,
      params,
      signal,
      (result) => { captured = result; },
      (d) => { decision = d; },
    );

    for await (const delta of deltas) parts.push(delta);

    return {
      text: parts.join(""),
      usage: applyReuseDecision(toUsageResult(captured), decision),
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
    let captured: ClaudeCodeResultUsage | null = null;
    let decision: SessionReuseDiagnosis | undefined;
    let resolveUsage!: (value: UsageResult | null) => void;
    let resolveToolCalls!: (value: ToolCall[] | null) => void;
    let resolveStopReason!: (value: StopReason) => void;

    const usage = new Promise<UsageResult | null>((r) => { resolveUsage = r; });
    const toolCalls = new Promise<ToolCall[] | null>((r) => { resolveToolCalls = r; });
    const stopReason = new Promise<StopReason>((r) => { resolveStopReason = r; });

    const rawDeltas = this.runTurn(
      request,
      model,
      params,
      signal,
      (result) => { captured = result; },
      (d) => { decision = d; },
    );

    // Mirror the AnthropicClient contract: deferred promises resolve only after
    // the delta generator is fully consumed (completed, thrown, or returned).
    async function* wrappedDeltas(): AsyncGenerator<string> {
      try {
        yield* rawDeltas;
      } finally {
        resolveUsage(applyReuseDecision(toUsageResult(captured), decision));
        // Claude Code runs its own tools internally via MCP, it never returns
        // plugin tool calls through the stream.
        resolveToolCalls(null);
        resolveStopReason("end_turn");
      }
    }

    return { deltas: wrappedDeltas(), usage, toolCalls, stopReason };
  }

  /**
   * Runs one turn: through the persistent session when available (context
   * retention + caching), else the stateless SDK engine, else the legacy one-shot
   * subprocess on the version-mismatch fallback.
   */
  private runTurn(
    request: ChatRequest,
    model: string,
    params: SamplingParams,
    signal: AbortSignal | undefined,
    onResult: (result: ClaudeCodeResultUsage) => void,
    onReuseDecision?: (decision: SessionReuseDiagnosis) => void,
  ): AsyncGenerator<string> {
    const prompt = buildClaudeCodePrompt(request);

    if (this.runtime.sdkSession) {
      return this.runtime.sdkSession.run({
        fullPrompt: prompt,
        deltaPrompt: buildDeltaPrompt(request),
        model,
        systemPrompt: request.systemPrompt,
        reasoning: params.reasoning,
        // Linearity turns hash the raw persisted text (`rawContent`) where the
        // rendered content was rewritten presentation-only (edit-outcome
        // annotations), matching the raw streamed bytes the session's watermark
        // covered; see ChatTurn.rawContent (ADR-0014).
        turns: request.messages.map((turn) => ({
          role: turn.role,
          content: turn.rawContent ?? turn.content,
        })),
        signal,
        onResult,
        onReuseDecision,
      });
    }

    if (this.runtime.useSdk) {
      return streamSdkTurn({
        prompt,
        model,
        systemPrompt: request.systemPrompt,
        reasoning: params.reasoning,
        claudePath: this.command,
        vaultRoot: this.runtime.vaultRoot,
        sdkMcp: this.runtime.sdkMcp,
        signal,
        onResult,
      });
    }

    let contextTokens: number | null = null;
    return streamClaudeCode({
      command: this.command,
      args: this.buildLegacyArgs(request, model, params),
      cwd: this.runtime.vaultRoot,
      env: this.buildLegacyEnv(),
      prompt,
      signal,
      onEvent: (json) => {
        contextTokens = extractClaudeCodeContextTokens(json) ?? contextTokens;
        const result = extractClaudeCodeResult(json);
        if (result) {
          if (contextTokens !== null) result.contextTokens = contextTokens;
          onResult(result);
        }
      },
    });
  }

  private get command(): string {
    return resolveClaudeBinary(this.claudePath);
  }

  /**
   * Legacy subprocess environment, inherited from the plugin's process plus speed
   * tuning. `*_NONESSENTIAL_*` mute the CLI's boot-time update checks, telemetry,
   * and background model calls (the dominant cold-start tax). Reasoning rides the
   * `--effort` flag ({@link buildLegacyArgs}) now, the retired
   * `MAX_THINKING_TOKENS` budget only ever applied to pre-adaptive models.
   */
  private buildLegacyEnv(): NodeJS.ProcessEnv {
    return {
      ...process.env,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:
        process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC ?? "1",
      DISABLE_NON_ESSENTIAL_MODEL_CALLS:
        process.env.DISABLE_NON_ESSENTIAL_MODEL_CALLS ?? "1",
    };
  }

  private buildLegacyArgs(request: ChatRequest, model: string, params: SamplingParams): string[] {
    const args = [
      "--print",
      "--output-format", "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--no-session-persistence",
      "--model", model,
    ];

    // Only sent for an explicit selection: omitted, the CLI runs on the model's
    // own default, mirroring the SDK path's null → send-nothing behavior.
    if (isEffortLevel(params.reasoning)) {
      args.push("--effort", params.reasoning);
    }

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
        "--disallowedTools", DISALLOWED_NATIVE_TOOLS.join(","),
        "--permission-mode", "dontAsk",
        "--allowedTools", this.runtime.mcp.allowedTools,
      );
    } else {
      // No MCP bridge available, run as a pure analyst with no tools at all.
      args.push("--tools", "");
    }

    return args;
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
  if (result.contextWindow !== undefined) usage.contextWindow = result.contextWindow;
  if (result.contextTokens !== undefined) usage.contextTokens = result.contextTokens;
  return usage;
}

/**
 * Folds the session reuse-vs-rebuild decision onto the turn's usage so it rides
 * the same path to the usage badge (Phase 0 cache instrumentation). A turn with
 * no usage (error / abort) carries no decision; those aren't the baseline-
 * measurement target, and a token-less usage object would render a misleading
 * "0 in / 0 out" badge.
 */
function applyReuseDecision(
  usage: UsageResult | null,
  decision: SessionReuseDiagnosis | undefined,
): UsageResult | null {
  if (!usage || !decision) return usage;
  usage.sessionReused = decision.reuse;
  if (!decision.reuse) usage.sessionRebuildReason = decision.reason;
  return usage;
}

/**
 * Flattens a {@link ChatRequest} into a single prompt string for Claude Code's
 * stdin. Attached context items become labeled blocks and the conversation history
 * is rendered as a simple speaker transcript. A `documentContext` block is emitted
 * only when one is supplied, i.e. the benchmark/analyst path; the production chat
 * path sends `documentContext: null` (the active note rides as a frozen attachment
 * on the user turn instead), so that block is inert there.
 *
 * RAG context is intentionally omitted when the MCP bridge is active, Claude Code
 * retrieves from the vault through the plugin's tools, but is included as a block
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
      .map((c) => `## ${c.filePath}, ${c.headingPath}\n\n${c.content}`)
      .join("\n\n");
    blocks.push(`# Retrieved context\n\n${chunks}`);
  }

  // Per-mode wording rides the latest user turn so request.systemPrompt stays
  // mode-invariant and the live session's configFingerprint stops rebuilding on
  // mode switch (prompt-cache design §6.1.3). On a cold mint the whole transcript
  // is replayed, so the framing is prepended to the last user turn within it.
  const lastIdx = request.messages.length - 1;
  const transcript = request.messages
    .map((turn, i) =>
      i === lastIdx && turn.role === "user" ? renderTurn(turn, request.modeTail) : renderTurn(turn),
    )
    .filter(Boolean)
    .join("\n\n");
  if (transcript) blocks.push(transcript);

  return blocks.join("\n\n---\n\n");
}

function renderTurn(turn: ChatTurn, framing?: string): string {
  const body = renderTurnBody(turn);
  if (!body) return "";
  const speaker = turn.role === "assistant" ? "Assistant" : "User";
  const framed = framing ? `${framing}\n\n${body}` : body;
  return `${speaker}: ${framed}`;
}

/**
 * A turn's text body: its content plus any frozen note snapshots. Images can't
 * cross Claude Code's stdin, so only note attachments are rendered.
 */
function renderTurnBody(turn: ChatTurn): string {
  const parts: string[] = [];
  if (turn.content) parts.push(turn.content);
  for (const att of turn.attachments ?? []) {
    if (att.type === "note") parts.push(formatNoteAttachment(att));
  }
  return parts.join("\n\n");
}

/**
 * The delta prompt sent when a persistent session is reused: only the new user
 * turn's text. The session already holds the prior conversation in memory, so
 * re-sending the transcript (or the context blocks, which are re-grounded via MCP)
 * would defeat the point. Falls back to the full prompt if the last turn isn't a
 * user message, reuse won't fire in that case, but the value must still be valid.
 */
export function buildDeltaPrompt(request: ChatRequest): string {
  const last = request.messages[request.messages.length - 1];
  if (last && last.role === "user") {
    const body = renderTurnBody(last);
    if (body) {
      // The per-mode framing is prepended to the new user turn so the baked
      // systemPrompt stays mode-invariant (prompt-cache design §6.1.3).
      return request.modeTail ? `${request.modeTail}\n\n${body}` : body;
    }
  }
  return buildClaudeCodePrompt(request);
}
