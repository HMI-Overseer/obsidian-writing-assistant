import type { ClaudeCodeResumeCursor, SamplingParams } from "../shared/types";
import type { ChatRequest, ChatTurn } from "../shared/chatRequest";
import type { ChatClient } from "./chatClient";
import { formatNoteAttachment } from "./contextFormatting";
import type { ImageAttachment } from "../shared/types";
import type { CompletionResult, UsageResult } from "./usageTypes";
import type {
  AssistantCaptureBatch,
  AssistantCaptureFrame,
} from "./assistantCapture";
import { sealCaptureFrame } from "./assistantCapture";
import type {
  AssistantStreamAttemptContext,
  AssistantStreamRun,
  ProviderDisposalHooks,
} from "./assistantStreamRun";
import { createStreamMetadataGate } from "./assistantStreamRun";
import { createLinkedAbort, createOwnedStreamRun } from "./assistantStreamRuntime";
import { ClaudeCodeProcessOwner } from "./sdk/claudeCodeSpawn";
import {
  CLAUDE_HARD_DISPOSE_MS,
  CLAUDE_LEGACY_GRACEFUL_STOP_MS,
  CLAUDE_SDK_GRACEFUL_STOP_MS,
  CLAUDE_SDK_INTERRUPT_STOP_MS,
} from "../constants";
import {
  streamClaudeCodeMessages,
  claudeCodeHarnessEnv,
  extractClaudeCodeResult,
  extractClaudeCodeContextTokens,
  resolveClaudeBinary,
  type ClaudeCodeResultUsage,
} from "./claudeCodeProcess";
import { assertMintBlobFits } from "./claudeCodeContextPreflight";
import {
  DISALLOWED_NATIVE_TOOLS,
  streamSdkTurn,
} from "./sdk/sdkQueryEngine";
import { ClaudeCodeSdkMessageTranslator } from "./sdk/claudeCodeSdkMessageTranslator";
import { isEffortLevel } from "../shared/reasoning";
import type { McpSdkServerConfigWithInstance } from "./sdk/claudeAgentSdk";
import type { ClaudeCodeGenerationHandle } from "../services/ClaudeCodeGenerationLease";
import type { SessionRecovery, SessionTurn } from "./harnessSession";
import { generateId } from "../utils";

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
  /**
   * Images attached to the new user turn, sent as content blocks beside the prompt
   * text on every tier. The prompt itself never carries them: a session's transcript
   * is text, and a cold mint replays only that text, so images attached to earlier
   * turns do not survive a rebuild.
   */
  images: ImageAttachment[];
  signal?: AbortSignal;
  onResult?: (result: ClaudeCodeResultUsage) => void;
  /** Reports the recovery tier this turn took: reused / resumed / rebuilt. */
  onRecoveryDecision?: (decision: SessionRecovery) => void;
  /** Receives the resume cursor this turn banked, to persist as the resume point. */
  onSessionBanked?: (cursor: ClaudeCodeResumeCursor) => void;
}

/**
 * Runtime context the Claude Code client needs but that the static provider
 * settings can't supply. Resolved per-call from the plugin's services.
 */
export interface ClaudeCodeRuntime {
  /** Subprocess working directory, the vault root. */
  vaultRoot?: string;
  /**
   * This generation's grip on every Claude callback surface it can reach
   * (ADR-0032). The chat pipeline activates it with the generation's
   * review, ask, and lifecycle owners before the provider runs, and releases it in
   * its `finally`. It rides the runtime rather than being threaded through this
   * client, the query engine, and the session registry, because the callback a
   * lease guards is dispatched by the SDK rather than by any of them: the run slot
   * a persistent session's MCP server captured is the only place the lease could
   * be read from anyway, and threading would have given up the property that a
   * lease ID enters at exactly one place per provider.
   */
  generation?: ClaudeCodeGenerationHandle;
  /**
   * The model's discovered context window (Claude Code reports it per turn; its
   * catalog aliases carry no static size). Feeds the send-path preflight
   * ({@link ./claudeCodeContextPreflight}), which refuses a mint blob that would
   * overflow it, surfacing a clear "conversation too large" state before spend
   * instead of an opaque mid-turn API error. Absent on the first turn (none
   * reported yet) ⇒ the preflight is a passive no-op.
   */
  contextWindow?: number;
  /**
   * Whether to drive Claude Code through the Agent SDK. False when the installed
   * CLI is missing or version-incompatible with the bundled SDK, the client then
   * falls back to the legacy one-shot `claude --print` path (the always-lit floor).
   */
  useSdk: boolean;
  /**
   * Persistent per-conversation SDK session (ADR-0016). Present on the SDK path when
   * a conversation id is available; the client routes each turn through it for
   * context retention + incremental caching. Absent ⇒ stateless one-shot.
   */
  sdkSession?: {
    conversationId: string;
    run: (input: SdkSessionTurnInput) => AsyncGenerator<AssistantCaptureFrame>;
    /**
     * Disposes the conversation's live session and resolves once its CLI child is
     * provably gone. This is the persistent path's bounded hard-dispose operation
     * (ADR-0032); without it the SDK path would
     * have no termination the plugin can bound.
     */
    hardDispose: () => Promise<void>;
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
  /** Exact correlation fidelity observed by the active MCP bridge. */
  getToolCorrelation?: () => "provider_id" | "none";
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
    let decision: SessionRecovery | undefined;
    let bankedCursor: ClaudeCodeResumeCursor | undefined;
    const segmentOrder: string[] = [];
    const textBySegment = new Map<string, string>();

    const deltas = this.runTurn(
      request,
      model,
      params,
      signal,
      (result) => { captured = result; },
      (d) => { decision = d; },
      (cursor) => { bankedCursor = cursor; },
    );

    for await (const frame of deltas) {
      for (const event of frame.facts) {
        if (event.type === "segment_start" && !textBySegment.has(event.segmentId)) {
          segmentOrder.push(event.segmentId);
          textBySegment.set(event.segmentId, "");
        } else if (event.type === "prose_delta") {
          textBySegment.set(
            event.segmentId,
            (textBySegment.get(event.segmentId) ?? "") + event.delta,
          );
        } else if (event.type === "segment_reconcile") {
          textBySegment.set(
            event.segmentId,
            event.blocks
              .filter((block) => block.type === "prose")
              .map((block) => block.text)
              .join(""),
          );
        }
      }
    }

    return {
      text: segmentOrder.map((id) => textBySegment.get(id) ?? "").join(""),
      usage: applyRecoveryDecision(toUsageResult(captured), decision, bankedCursor),
      toolCalls: null,
      stopReason: "end_turn",
    };
  }

  stream(
    request: ChatRequest,
    model: string,
    params: SamplingParams,
    attempt: AssistantStreamAttemptContext,
  ): AssistantStreamRun {
    let captured: ClaudeCodeResultUsage | null = null;
    let decision: SessionRecovery | undefined;
    let bankedCursor: ClaudeCodeResumeCursor | undefined;
    const metadata = createStreamMetadataGate();
    const runtime = this.runtime;
    // The turn's own abort controller, linked to the lease. Aborting it is what
    // the persistent session reads as a user Stop, which takes its clean
    // `interrupt()` and preserves the session; the disposal hooks below cover the
    // reasons that must not.
    const transport = createLinkedAbort(attempt);
    const processOwner = new ClaudeCodeProcessOwner();

    const rawFrames = this.runTurn(
      request,
      model,
      params,
      transport.signal,
      (result) => { captured = result; },
      (d) => { decision = d; },
      (cursor) => { bankedCursor = cursor; },
      processOwner,
    );

    async function* source(): AsyncGenerator<AssistantCaptureBatch> {
      try {
        // The lease ID enters here and nowhere deeper, so every batch this
        // attempt publishes is attempt-scoped by construction and a retried
        // attempt can never collide with the one it replaced.
        for await (const frame of rawFrames) {
          yield sealCaptureFrame(attempt.leaseId, frame);
        }
      } finally {
        metadata.usage.settle(
          applyRecoveryDecision(toUsageResult(captured), decision, bankedCursor),
        );
        metadata.stopReason.settle("end_turn");
        metadata.replayCapsule.settle(null);
        const nativeContinuation =
          decision?.outcome === "reused" || decision?.outcome === "resumed";
        const sdkCapture = runtime.useSdk || runtime.sdkSession !== undefined;
        const correlation = sdkCapture
          ? runtime.getToolCorrelation?.() ?? "provider_id"
          : "none";
        metadata.replayEvidence.settle({
          tier: nativeContinuation ? "native" : "textual",
          capabilities: {
            captureOrder: sdkCapture ? "exact" : "segment",
            toolCorrelation: correlation,
            coldReplay: "textual",
            nativeResume: nativeContinuation,
          },
          ...(!sdkCapture
            ? { loweredReason: "claude_code_legacy_stream_json_capture" }
            : correlation === "none"
              ? { loweredReason: "claude_code_tool_correlation_missing" }
              : nativeContinuation
                ? {}
                : { loweredReason: "claude_code_structural_cold_replay_deferred" }),
        });
      }
    }

    return createOwnedStreamRun({
      attempt,
      provider: "claudecode",
      open: source,
      metadata,
      abort: () => {
        transport.abort();
        transport.release();
      },
      disposal: this.disposalHooks(processOwner),
    });
  }

  /**
   * The two-deadline termination contract for whichever Claude path this client is
   * driving. Every number comes from the provider termination report; none is
   * guessed here.
   *
   * The graceful step is deliberately just the abort plus the provider's own
   * settling, because the *measured* graceful behavior differs per path and per
   * reason: a persistent session under user Stop acknowledges `interrupt()` in
   * 1 ms and stays reusable, while a full SDK abort-and-drain took about seven
   * seconds. A deadline shorter than that would force-dispose every ordinary Stop,
   * which is why the constant is what it is.
   */
  private disposalHooks(processOwner: ClaudeCodeProcessOwner): ProviderDisposalHooks {
    const session = this.runtime.sdkSession;
    const usesSdk = this.runtime.useSdk || session !== undefined;
    return {
      requestGracefulStop: (reason) => {
        // The cancel already went out through the run's `abort` hook, and returning
        // the iterator (the rest of the graceful step) is what lets the provider's
        // own termination run: the session's clean `interrupt()`, the legacy
        // subprocess's `kill()`, the SDK query's transport close.
        //
        // Capture failure is the exception. It means the transcript is no longer
        // authoritative, so the session must not survive to be reused. Refusing the
        // graceful tier here is how that reaches disposal, rather than reporting a
        // proven quiescence the evidence does not support.
        if (reason === "capture_failed") {
          return Promise.reject(
            new Error("capture failure disposes the Claude session"),
          );
        }
        return Promise.resolve();
      },
      // The persistent session owns its own child, so its disposal goes through the
      // registry; a one-shot or legacy run is owned by this call's own spawn owner.
      hardDispose: session ? session.hardDispose : () => processOwner.hardDispose(),
      gracefulDeadlineMs: usesSdk
        ? session
          ? CLAUDE_SDK_INTERRUPT_STOP_MS
          : CLAUDE_SDK_GRACEFUL_STOP_MS
        : CLAUDE_LEGACY_GRACEFUL_STOP_MS,
      hardDisposeDeadlineMs: CLAUDE_HARD_DISPOSE_MS,
    };
  }

  /**
   * Runs one turn: through the persistent session when available (context
   * retention + caching), else the stateless SDK engine, else the legacy one-shot
   * subprocess on the version-mismatch fallback.
   *
   * An `async *` so the send-path preflight ({@link assertMintBlobFits}) runs on
   * first consumption, before any dispatch: an oversized blob throws here and no
   * `claude` process is ever spawned (zero spend), the throw surfacing through the
   * ordinary streamed-error path.
   */
  private async *runTurn(
    request: ChatRequest,
    model: string,
    params: SamplingParams,
    signal: AbortSignal | undefined,
    onResult: (result: ClaudeCodeResultUsage) => void,
    onRecoveryDecision?: (decision: SessionRecovery) => void,
    onSessionBanked?: (cursor: ClaudeCodeResumeCursor) => void,
    processOwner?: ClaudeCodeProcessOwner,
  ): AsyncGenerator<AssistantCaptureFrame> {
    // The persistent session delivers images as blocks; the fallback paths cannot.
    const imagesDelivered = this.runtime.sdkSession !== undefined;
    const prompt = buildClaudeCodePrompt(request, { imagesDelivered });
    // Passive preflight: refuse a mint blob that would overflow the discovered
    // window (leaving no room for a reply) rather than let it die opaquely
    // mid-turn once CLI compaction is disabled. Reads only, mutates nothing.
    assertMintBlobFits(prompt, request.systemPrompt, this.runtime.contextWindow);

    if (this.runtime.sdkSession) {
      const sessionEvents = this.runtime.sdkSession.run({
        fullPrompt: prompt,
        deltaPrompt: buildDeltaPrompt(request, { imagesDelivered }),
        images: latestUserTurnImages(request),
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
        onRecoveryDecision,
        onSessionBanked,
      });
      yield* sessionEvents;
      return;
    }

    if (this.runtime.useSdk) {
      yield* streamSdkTurn({
        prompt,
        model,
        systemPrompt: request.systemPrompt,
        reasoning: params.reasoning,
        claudePath: this.command,
        vaultRoot: this.runtime.vaultRoot,
        sdkMcp: this.runtime.sdkMcp,
        signal,
        onResult,
        ...(processOwner ? { processOwner } : {}),
      });
      return;
    }

    let contextTokens: number | null = null;
    const segmentPrefix = `claude-legacy-segment-${generateId()}`;
    const translator = new ClaudeCodeSdkMessageTranslator({
      createSegmentId: (index) => `${segmentPrefix}-${index}`,
      toolCorrelation: "none",
    });
    for await (const message of streamClaudeCodeMessages({
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
    })) {
      const frame = translator.translateFrame(message);
      if (frame) yield frame;
    }
  }

  private get command(): string {
    return resolveClaudeBinary(this.claudePath);
  }

  /**
   * Legacy subprocess environment, inherited from the plugin's process plus the
   * shared harness tuning ({@link claudeCodeHarnessEnv}: speed vars + disabled CLI
   * compaction). Reasoning rides the `--effort` flag ({@link buildLegacyArgs}) now,
   * the retired `MAX_THINKING_TOKENS` budget only ever applied to pre-adaptive
   * models.
   */
  private buildLegacyEnv(): NodeJS.ProcessEnv {
    return {
      ...process.env,
      ...claudeCodeHarnessEnv(),
    };
  }

  private buildLegacyArgs(request: ChatRequest, model: string, params: SamplingParams): string[] {
    const args = [
      "--print",
      "--output-format", "stream-json",
      "--verbose",
      "--include-partial-messages",
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
 * Folds the session recovery decision (reused / resumed / rebuilt) and the banked
 * resume cursor onto the turn's usage so both ride the same path to the usage badge
 * and to persistence (ADR-0016). A turn with no usage (error / abort) carries
 * neither; those aren't the baseline-measurement target, and a token-less usage
 * object would render a misleading "0 in / 0 out" badge.
 */
function applyRecoveryDecision(
  usage: UsageResult | null,
  decision: SessionRecovery | undefined,
  bankedCursor: ClaudeCodeResumeCursor | undefined,
): UsageResult | null {
  if (!usage) return usage;
  if (decision) {
    usage.sessionReused = decision.outcome === "reused";
    if (decision.outcome === "resumed") usage.sessionResumed = true;
    if (decision.outcome === "rebuilt") usage.sessionRebuildReason = decision.reason;
  }
  if (bankedCursor) usage.resumeCursor = bankedCursor;
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
/**
 * Framing preamble for the cold-mint blob. Tells the rebuilt session it is
 * resuming a replayed conversation, that it is the Assistant, and that the bracketed
 * digest lines beneath an assistant turn record tool calls that already ran,
 * so it must not repeat them or re-propose anything the user declined. Prepended only
 * when the transcript actually replays an assistant turn, and only on the mint path: the
 * delta path (session reuse) already holds this context, and keeping the preamble out of
 * it plus stable across rebuilds is what stops it from becoming a linearity drift source
 * (ADR-0016).
 *
 * The assistant-turn condition is load-bearing, not a tidy-up. A conversation's opening
 * turn also mints cold, and every claim here is false of it: there is no prior
 * conversation, nothing was replayed, and no tool call already ran. A model that believes
 * it answers by transcribing bracketed calls it never made, inventing their results.
 */
const REPLAY_PREAMBLE =
  "The following is a prior conversation, replayed after your session was restarted. " +
  "You are the Assistant. Bracketed lines beneath an assistant turn record tool calls " +
  "that already ran and how the user disposed of them: treat them as history, do not " +
  "re-run those actions, and do not re-propose anything the user declined. Continue from " +
  "the final User message below.";

/** How the prompt builders treat image attachments on user turns. */
export interface ClaudeCodePromptOptions {
  /**
   * True when the runtime sends images as content blocks beside the text (the
   * persistent SDK session), so the text says nothing about them. False on the
   * `--print` and one-shot paths, where an image cannot cross and the text names
   * it as undeliverable rather than dropping it silently.
   */
  imagesDelivered?: boolean;
}

export function buildClaudeCodePrompt(
  request: ChatRequest,
  options: ClaudeCodePromptOptions = {},
): string {
  const delivered = options.imagesDelivered === true;
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

  // Speaker labels and the preamble both describe a *prior* conversation, so both hang
  // on the same fact: whether any assistant turn survives rendering. Without one this is
  // a conversation's opening turn, which ships exactly as the delta path sends it.
  const replayed = request.messages.some(
    (turn) => turn.role === "assistant" && renderTurnBody(turn, delivered).length > 0,
  );

  // Per-mode wording rides the latest user turn so request.systemPrompt stays
  // mode-invariant and the live session's configFingerprint stops rebuilding on
  // mode switch. On a cold mint the whole transcript
  // is replayed, so the framing is prepended to the last user turn within it.
  const lastIdx = request.messages.length - 1;
  const transcript = request.messages
    .map((turn, i) => {
      const framing = i === lastIdx && turn.role === "user" ? request.modeTail : undefined;
      return replayed
        ? renderTurn(turn, delivered, framing)
        : renderLiveTurn(turn, delivered, framing);
    })
    .filter(Boolean)
    .join("\n\n");
  if (transcript) blocks.push(transcript);

  const body = blocks.join("\n\n---\n\n");
  // Frame the replay only when there is a replayed turn to frame; a transcript-less
  // analyst blob (documentContext only) is not a replayed conversation, and neither is
  // an opening turn.
  return replayed && transcript ? `${REPLAY_PREAMBLE}\n\n${body}` : body;
}

/**
 * One live turn: its body plus any per-mode framing, with no speaker label.
 *
 * Nothing is escaped here. Labels are what {@link escapeSpeakerLabels} protects, and
 * without them a literal `User:` in the body is just text, exactly as the delta path
 * already sends it.
 */
function renderLiveTurn(turn: ChatTurn, imagesDelivered: boolean, framing?: string): string {
  const body = renderTurnBody(turn, imagesDelivered);
  if (!body) return "";
  return framing ? `${framing}\n\n${body}` : body;
}

function renderTurn(turn: ChatTurn, imagesDelivered: boolean, framing?: string): string {
  const body = renderTurnBody(turn, imagesDelivered);
  if (!body) return "";
  const speaker = turn.role === "assistant" ? "Assistant" : "User";
  // Escape line-leading speaker labels inside the body so a literal `User:` /
  // `Assistant:` in the content can't be misread as a turn boundary (ADR-0016).
  // Mint-path only: renderTurnBody stays unescaped for the delta path, which sends
  // one live user turn with no transcript to shear.
  const escaped = escapeSpeakerLabels(body);
  const framed = framing ? `${framing}\n\n${escaped}` : escaped;
  return `${speaker}: ${framed}`;
}

/** Backslash-escapes a line-leading `User:` / `Assistant:` label within a turn body. */
function escapeSpeakerLabels(body: string): string {
  return body.replace(/^(User|Assistant):/gm, "\\$1:");
}

/**
 * A turn's text body: its content plus any frozen note snapshots. An image rides
 * the message as a content block where the runtime delivers one (the persistent
 * session), and is named here as undeliverable where it cannot (the `--print` and
 * one-shot paths), so the model reports the limitation instead of reporting nothing.
 */
function renderTurnBody(turn: ChatTurn, imagesDelivered: boolean): string {
  const parts: string[] = [];
  if (turn.content) parts.push(turn.content);
  for (const att of turn.attachments ?? []) {
    if (att.type === "note") parts.push(formatNoteAttachment(att));
    else if (att.type === "image" && !imagesDelivered) parts.push(undeliverableImageLine(att));
  }
  return parts.join("\n\n");
}

function undeliverableImageLine(image: ImageAttachment): string {
  return (
    `[Attached image "${image.fileName ?? "image"}" could not be delivered on this Claude Code ` +
    "runtime. Ask the user to paste it into a note or describe it.]"
  );
}

/** The images on the new user turn, the ones a session sends as blocks beside its text. */
export function latestUserTurnImages(request: ChatRequest): ImageAttachment[] {
  const last = request.messages[request.messages.length - 1];
  if (!last || last.role !== "user") return [];
  return (last.attachments ?? []).filter(
    (att): att is ImageAttachment => att.type === "image",
  );
}

/**
 * The delta prompt sent when a persistent session is reused: only the new user
 * turn's text. The session already holds the prior conversation in memory, so
 * re-sending the transcript (or the context blocks, which are re-grounded via MCP)
 * would defeat the point. An image-only turn has no text but is still one live
 * turn: its images ride the message as blocks, and replaying the transcript into
 * a session that holds it would double the history. Falls back to the full prompt
 * only when the last turn isn't a user message; reuse won't fire in that case,
 * but the value must still be valid.
 */
export function buildDeltaPrompt(
  request: ChatRequest,
  options: ClaudeCodePromptOptions = {},
): string {
  const delivered = options.imagesDelivered === true;
  const last = request.messages[request.messages.length - 1];
  if (last && last.role === "user") {
    const body = renderTurnBody(last, delivered);
    const carriesImages =
      delivered && (last.attachments ?? []).some((att) => att.type === "image");
    if (body || carriesImages) {
      // The per-mode framing is prepended to the new user turn so the baked
      // systemPrompt stays mode-invariant.
      return [request.modeTail, body].filter(Boolean).join("\n\n");
    }
  }
  return buildClaudeCodePrompt(request, options);
}
