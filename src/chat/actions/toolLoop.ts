import type { App } from "obsidian";
import type { ChatClient } from "../../api/chatClient";
import type { ChatRequest, ChatTurn } from "../../shared/chatRequest";
import type { AgenticStep, ProviderOption, SamplingParams } from "../../shared/types";
import type { ToolCall, ToolResult } from "../../tools/types";
import type { UsageResult, StopReason } from "../../api/usageTypes";
import { VAULT_TOOL_NAMES } from "../../tools/vault/definition";
import { executeVaultTool } from "../../tools/vault/handlers";
import type { VaultToolContext } from "../../tools/vault/handlers";
import { toolFailure } from "../../tools/toolFailure";
import { EDIT_TOOL_NAMES } from "../../tools/editing/definition";
import { executeEditTool } from "../../tools/editing/handlers";
import type { ToolExecutionContext } from "../../tools/editing/handlers";
import { VAULT_OPS_TOOL_NAMES } from "../../tools/vault-ops/definition";
import { executeVaultOpTool, buildPendingOverlay } from "../../tools/vault-ops/handlers";
import { THINK_TOOL_NAME } from "../../tools/think/definition";
import { extractToolInput } from "../../tools/metadata";
import { normalizeVaultToolCall } from "../../tools/paths";
import type { LiveVaultReview } from "./liveVaultReview";

export type { VaultToolContext, ToolExecutionContext };

/**
 * Context for in-loop vault-op execution. When `liveReview` is present, `ask`-gated
 * ops suspend the loop until the user approves/declines and the tool result carries
 * the real disposition (in-loop-tool-approval-blocking-flow). Without it the loop
 * falls back to the legacy synchronous validate-only path.
 */
export interface VaultOpToolContext {
  app: App;
  liveReview?: LiveVaultReview;
}

/** All tool names that execute inside the tool loop (results feed back to the model). */
const ALL_LOOP_TOOL_NAMES = new Set([
  ...VAULT_TOOL_NAMES,
  ...EDIT_TOOL_NAMES,
  ...VAULT_OPS_TOOL_NAMES,
  THINK_TOOL_NAME,
]);

/** Append a round's prose to the accumulated answer, blank-line separated. */
function appendAnswerProse(existing: string, addition: string): string {
  if (!addition.trim()) return existing;
  return existing ? `${existing}\n\n${addition}` : addition;
}

/** Callbacks the tool loop uses to interact with the streaming UI. */
export interface ToolLoopCallbacks {
  /** Called with text that should appear in the chat bubble. In agentic mode this is only called for the final round's text (flushed after the stream ends). */
  onDelta: (delta: string) => void;
  /** Called when a read-only tool is about to execute. */
  onToolStatus?: (toolName: string) => void;
  /** Called as soon as a read-only tool call is identified by name during streaming, before execution. */
  onToolCallStreaming?: (toolName: string) => void;
  /** Called to reset the renderer between tool-loop rounds. */
  onNewRound?: () => void;
  /** Called after each read-only tool call completes, with a record of what was done. */
  onStepRecorded?: (step: AgenticStep) => void;
  /**
   * Called once a vault-op / edit step resolves (it was recorded before the user
   * decided). Carries the tool result so the timeline can flag failures / declines /
   * policy-denials and surface the model-facing error text.
   */
  onStepResult?: (toolCallId: string, result: { isError?: boolean; content: string }) => void;
  /** Called with each text delta during streaming for live reasoning display in the timeline. */
  onReasoningDelta?: (delta: string) => void;
  /**
   * Called when a round ends with reasoning that should stay in the timeline.
   * committed=true: keep the live reasoning entry (genuine intermediate scratch
   * before a read-only tool). committed=false: discard it, either because the
   * round produced no reasoning, or because its prose was answer-track (it
   * narrated a mutating action / is the final answer) and will be delivered to
   * the bubble via {@link onDelta} instead.
   */
  onReasoningRoundFinished?: (committed: boolean, round: number) => void;
  /** Called with the first round's usage for token estimation calibration. */
  onCalibrate?: (request: ChatRequest, usage: UsageResult) => void;
}

/** Result returned by the tool loop after all rounds complete. */
export interface ToolLoopResult {
  /** All write tool calls accumulated across rounds. */
  writeToolCalls: ToolCall[] | null;
  /** Final usage from the last round that reported usage. */
  usage: UsageResult | null;
  /**
   * Stop reason of the most recent round that contributed write tool calls, the
   * round whose trailing write_file the truncation guard inspects.
   * Null when no round produced write calls.
   */
  writeStopReason: StopReason | null;
}

/**
 * Runs the read-only tool loop: streams a response, executes any read-only
 * tool calls (edit inspection tools + vault search tools), feeds results back
 * to the model, and repeats until the model produces write tool calls or a
 * plain text response.
 *
 * When maxRounds is reached the loop pushes terminal error tool results so the
 * conversation history stays valid, then allows one synthesis pass for the
 * model to summarise what it gathered. If the model calls tools again after
 * that warning it is hard-stopped.
 *
 * This function is pure orchestration, it doesn't know about UI components,
 * conversation persistence, or edit-mode specifics.
 */
export async function runToolLoop(
  client: ChatClient,
  baseRequest: ChatRequest,
  model: string,
  provider: ProviderOption,
  params: SamplingParams,
  signal: AbortSignal,
  callbacks: ToolLoopCallbacks,
  maxRounds: number,
  agenticMode: boolean,
  vaultToolContext?: VaultToolContext,
  editToolContext?: ToolExecutionContext,
  vaultOpToolContext?: VaultOpToolContext,
): Promise<ToolLoopResult> {
  const toolLoopTurns: ChatTurn[] = [];
  let allWriteToolCalls: ToolCall[] = [];
  let fullText = "";
  let previousRoundsText = "";
  let finalUsage: UsageResult | null = null;
  let calibrated = false;
  // Set to true once a cap-hit synthesis pass has been injected.
  let capHit = false;
  // Stop reason of the latest round that accumulated write calls (truncation guard).
  let writeStopReason: StopReason | null = null;
  // Answer-track prose accumulated across rounds: prose that narrates a mutating
  // action (write/edit/vault-op) plus the final round's prose. This is the
  // user-facing answer and is flushed to the bubble at the end (agentic mode);
  // prose that merely precedes a read-only tool stays in the timeline as
  // reasoning instead. Solves the model saying its piece, e.g. a fenced code
  // block, alongside a write and having it stranded as plain-text reasoning.
  let answerProse = "";

  // The app, used only to translate absolute paths a model may emit into
  // vault-relative ones (normalizeVaultToolCall). Any context carries it.
  const app =
    vaultOpToolContext?.app ?? editToolContext?.app ?? vaultToolContext?.app;

  for (let round = 0; ; round++) {
    const requestMessages = [...baseRequest.messages, ...toolLoopTurns];
    const roundRequest = { ...baseRequest, messages: requestMessages };

    const { onToolCallStreaming } = callbacks;
    const streamResult = client.stream(
      roundRequest, model, params, signal,
      onToolCallStreaming
        ? (_idx, name) => { if (ALL_LOOP_TOOL_NAMES.has(name)) onToolCallStreaming(name); }
        : undefined,
    );

    // In agentic mode, buffer deltas internally, only the timeline receives
    // live updates per round. Answer-track prose is accumulated and flushed to
    // the bubble once, after the loop. In non-agentic mode, deltas flow directly
    // to the bubble as they arrive.
    let roundBuffer = "";
    try {
      for await (const delta of streamResult.deltas) {
        fullText += delta;
        roundBuffer += delta;
        if (!agenticMode) {
          callbacks.onDelta(delta);
        }
        callbacks.onReasoningDelta?.(delta);
      }
    } catch (e) {
      // On abort (or other errors), flush whatever we have so partial text is
      // preserved in the renderer for finalizeAbortedResponse: earlier rounds'
      // answer prose plus this round's partial buffer.
      if (agenticMode) {
        const partial = appendAnswerProse(answerProse, roundBuffer);
        if (partial) callbacks.onDelta(partial);
      }
      throw e;
    }

    const usage = await streamResult.usage;
    const rawToolCalls = await streamResult.toolCalls;
    // Translate any absolute paths to vault-relative *once*, here, so every
    // downstream consumer, overlay, accumulation, finalization, timeline, sees
    // the same resolved path (tools/paths.ts).
    const toolCalls =
      rawToolCalls && app ? rawToolCalls.map((tc) => normalizeVaultToolCall(app, tc)) : rawToolCalls;
    const stopReason = await streamResult.stopReason;

    if (usage && callbacks.onCalibrate && !calibrated) {
      callbacks.onCalibrate(roundRequest, usage);
      calibrated = true;
    }
    if (usage) finalUsage = usage;

    const roundText = fullText.slice(previousRoundsText.length);

    const hasToolCalls = toolCalls !== null && toolCalls.length > 0;

    // Detect failed tool calls: model stopped but produced nothing useful.
    checkForFailedToolCall({
      hasToolCalls,
      roundText,
      stopReason,
      round,
      maxRounds,
      usage,
      model,
      provider,
      agenticMode,
      toolCount: baseRequest.tools?.length ?? 0,
      mode: baseRequest.documentContext ? "edit" : "chat",
    });

    if (!hasToolCalls || !toolCalls) {
      // Final round: its prose is the answer (or its tail). Accumulate it and
      // discard the live reasoning entry, the answer is delivered to the bubble
      // via the single flush after the loop.
      answerProse = appendAnswerProse(answerProse, roundText);
      callbacks.onReasoningRoundFinished?.(false, round);
      break;
    }

    // Classify tool calls: known loop tools execute inline; unknown tools are
    // accumulated as write tool calls for the finalization pipeline.
    const loopCalls = toolCalls.filter((tc) => ALL_LOOP_TOOL_NAMES.has(tc.name));
    const unknownCalls = toolCalls.filter((tc) => !ALL_LOOP_TOOL_NAMES.has(tc.name));
    if (unknownCalls.length > 0) {
      allWriteToolCalls = [...allWriteToolCalls, ...unknownCalls];
      writeStopReason = stopReason;
    }

    // Collect edit tool calls for finalization (they execute in the loop AND
    // get accumulated so the diff review panel can render them at the end).
    const editCalls = loopCalls.filter((tc) => EDIT_TOOL_NAMES.has(tc.name));
    if (editCalls.length > 0) {
      allWriteToolCalls = [...allWriteToolCalls, ...editCalls];
      writeStopReason = stopReason;
    }

    // Vault-op calls execute in the loop AND accumulate for finalization, just
    // like edits. The pending overlay is seeded from vault ops
    // accumulated in PRIOR rounds, captured before this round's are appended,
    // so a later round's move_file sees an earlier round's write_file.
    const priorVaultOpCalls = allWriteToolCalls.filter((tc) => VAULT_OPS_TOOL_NAMES.has(tc.name));
    const vaultOpCalls = loopCalls.filter((tc) => VAULT_OPS_TOOL_NAMES.has(tc.name));
    if (vaultOpCalls.length > 0) {
      allWriteToolCalls = [...allWriteToolCalls, ...vaultOpCalls];
      writeStopReason = stopReason;
    }

    // Prose that narrates a mutating action (write/edit/vault-op) is part of the
    // user-facing answer, e.g. "Here's the file I created: ```…```", not
    // reasoning. Accumulate it toward the bubble; prose before a read-only tool
    // stays in the timeline as reasoning (committed below).
    const roundIsMutating =
      unknownCalls.length > 0 || editCalls.length > 0 || vaultOpCalls.length > 0;

    // Cap reached: push terminal error results to keep history valid, then let
    // the model produce one synthesis response. If it calls tools again after
    // the warning, hard-stop.
    if (capHit || round >= maxRounds) {
      if (capHit) {
        // Model ignored the cap warning and called tools again, hard stop.
        answerProse = appendAnswerProse(answerProse, roundText);
        callbacks.onReasoningRoundFinished?.(false, round);
        break;
      }
      capHit = true;
      toolLoopTurns.push({
        role: "assistant",
        content: roundText || null,
        toolCalls: loopCalls.map((tc) => ({ id: tc.id, name: tc.name, arguments: tc.arguments })),
      });
      for (const tc of loopCalls) {
        toolLoopTurns.push({
          role: "tool",
          content: "Retrieval limit reached. Synthesize an answer from the information gathered so far.",
          toolCallId: tc.id,
        });
      }
      callbacks.onReasoningRoundFinished?.(true, round);
      previousRoundsText = fullText;
      callbacks.onNewRound?.();
      continue;
    }

    // Normal intermediate tool execution round. Mutating prose is answer-track
    // (accumulate, discard its live reasoning); read-only prose is genuine
    // reasoning (keep it in the timeline).
    if (roundIsMutating) {
      answerProse = appendAnswerProse(answerProse, roundText);
      callbacks.onReasoningRoundFinished?.(false, round);
    } else {
      callbacks.onReasoningRoundFinished?.(true, round);
    }

    const vaultCalls = loopCalls.filter((tc) => VAULT_TOOL_NAMES.has(tc.name));
    const thinkCalls = loopCalls.filter((tc) => tc.name === THINK_TOOL_NAME);

    toolLoopTurns.push({
      role: "assistant",
      content: roundText || null,
      toolCalls: loopCalls.map((tc) => ({ id: tc.id, name: tc.name, arguments: tc.arguments })),
    });

    // Read-only / think tools and the (possibly suspending) vault ops and edits run
    // concurrently. Vault-op and edit steps are recorded BEFORE resolving so their
    // timeline rows exist while the review blocks this round until the user decides;
    // both channels return the *real* disposition as the tool result.
    const [otherResults, vaultOpResults, editResults] = await Promise.all([
      Promise.all([
        ...vaultCalls.map(async (tc) => {
          callbacks.onToolStatus?.(tc.name);
          if (!vaultToolContext) {
            return {
              tc,
              result: toolFailure({ kind: "unavailable", what: "vault tool context unavailable" }),
            };
          }
          return { tc, result: await executeVaultTool(tc, vaultToolContext) };
        }),
        // think is a no-op: returns empty content so the model continues reasoning.
        ...thinkCalls.map((tc) => ({
          tc,
          result: { content: "", isReadOnly: true as const } as ToolResult,
        })),
      ]),
      resolveVaultOps(),
      resolveEdits(),
    ]);

    for (const { tc, result } of otherResults) {
      toolLoopTurns.push({ role: "tool", content: result.content, toolCallId: tc.id });
      callbacks.onStepRecorded?.({
        type: "tool_call",
        round,
        toolName: tc.name,
        toolCallId: tc.id,
        toolInput: extractToolInput(tc),
        toolArgs: tc.arguments,
        // The result is in hand here, so a failed read-only tool flags its step
        // immediately (no separate onStepResult round-trip).
        ...(result.isError && { isError: true, errorContent: result.content }),
      });
    }
    // Vault-op and edit steps were already recorded before resolution, push results,
    // and report the outcome so the timeline can flag failures / declines / denials.
    for (const { tc, result } of [...vaultOpResults, ...editResults]) {
      toolLoopTurns.push({ role: "tool", content: result.content, toolCallId: tc.id });
      callbacks.onStepResult?.(tc.id, { isError: result.isError, content: result.content });
    }

    previousRoundsText = fullText;
    callbacks.onNewRound?.();

    /**
     * Resolve this round's vault-op calls. Records each op's timeline step first,
     * then routes to the live review (suspends on `ask` ops, returns real
     * dispositions) or the legacy synchronous validate-only fallback.
     */
    async function resolveVaultOps(): Promise<Array<{ tc: ToolCall; result: ToolResult }>> {
      if (vaultOpCalls.length === 0) return [];
      for (const tc of vaultOpCalls) {
        callbacks.onToolStatus?.(tc.name);
        callbacks.onStepRecorded?.({
          type: "tool_call",
          round,
          toolName: tc.name,
          toolCallId: tc.id,
          toolInput: extractToolInput(tc),
          toolArgs: tc.arguments,
        });
      }
      if (vaultOpToolContext?.liveReview) {
        return vaultOpToolContext.liveReview.resolveRound(vaultOpCalls, stopReason === "max_tokens");
      }
      // Fallback: no live review, validate only (overlay seeded from prior rounds).
      const overlay = vaultOpToolContext
        ? buildPendingOverlay(vaultOpToolContext.app, priorVaultOpCalls)
        : null;
      return vaultOpCalls.map((tc) => {
        if (!vaultOpToolContext || !overlay) {
          return {
            tc,
            result: toolFailure({
              kind: "unavailable",
              what: "vault operation context unavailable",
              isReadOnly: false,
            }),
          };
        }
        return { tc, result: executeVaultOpTool(tc, { app: vaultOpToolContext.app, overlay }) };
      });
    }

    /**
     * Resolve this round's edit calls. Records each edit's timeline step first, then
     * routes to the live review (resolves in-loop with the real three-tier resolver,
     * blocks on `ask` edits, returns real dispositions) or the legacy synchronous
     * validate-only fallback when no live review is available.
     */
    async function resolveEdits(): Promise<Array<{ tc: ToolCall; result: ToolResult }>> {
      if (editCalls.length === 0) return [];
      for (const tc of editCalls) {
        callbacks.onToolStatus?.(tc.name);
        callbacks.onStepRecorded?.({
          type: "tool_call",
          round,
          toolName: tc.name,
          toolCallId: tc.id,
          toolInput: extractToolInput(tc),
          toolArgs: tc.arguments,
        });
      }
      if (vaultOpToolContext?.liveReview) {
        return vaultOpToolContext.liveReview.resolveEdits(editCalls);
      }
      // Fallback: no live review, validate-only acknowledge (legacy non-blocking path).
      return Promise.all(
        editCalls.map(async (tc) => {
          if (!editToolContext) {
            return {
              tc,
              result: toolFailure({
                kind: "unavailable",
                what: "edit tool context unavailable",
                isReadOnly: false,
              }),
            };
          }
          return { tc, result: await executeEditTool(tc, editToolContext) };
        }),
      );
    }
  }

  // Deliver the accumulated answer to the bubble in one shot. In non-agentic
  // mode the deltas already streamed live, so there is nothing to flush.
  if (agenticMode && answerProse) {
    callbacks.onDelta(answerProse);
  }

  return {
    writeToolCalls: allWriteToolCalls.length > 0 ? allWriteToolCalls : null,
    usage: finalUsage,
    writeStopReason,
  };
}

export interface FailedRoundContext {
  hasToolCalls: boolean;
  roundText: string;
  stopReason: StopReason;
  /** Zero-based round index; surfaced 1-based in the message. */
  round: number;
  /** The configured round cap, surfaced as "round X of Y". */
  maxRounds: number;
  /** This round's usage, when the provider reported it. */
  usage: UsageResult | null;
  /** The model id, so the message names what to swap out. */
  model: string;
  /** Which backend ran the turn, the first thing a bug report needs. */
  provider: ProviderOption;
  /** Whether tools were attached / the agent loop was active this turn. */
  agenticMode: boolean;
  /** How many tools were advertised to the model. */
  toolCount: number;
  /** Edit vs chat, derived from whether a live document rode the request. */
  mode: "edit" | "chat";
}

/**
 * A round ended with no tool calls and no usable text. Rather than the old
 * one-size-fits-all message, classify *why*, raw tool-call markup, a `tool_use`
 * stop with nothing parseable, a genuinely empty turn, or reasoning-only output,
 * then render a multi-line block (summary, cause, fix, and a copyable diagnostics
 * section) via {@link formatFailedRoundMessage}. Each failure mode is
 * distinguishable in practice and points at a different fix, so collapsing them
 * hid the signal; the diagnostics exist to be pasted verbatim into a bug report.
 *
 * A clean `end_turn` after a productive round is *not* a failure: a terse local
 * model (e.g. Gemma) that did its tool work in an earlier round often emits an
 * empty final turn with nothing to add. This surfaces especially on regeneration,
 * where the re-issued ops resolve as "already satisfied" and leave nothing to
 * summarize. Treating that as fatal threw the user a scary error on a turn that
 * actually succeeded, so an empty `end_turn` past round 0 ends the loop quietly.
 */
export function checkForFailedToolCall(ctx: FailedRoundContext): void {
  const { hasToolCalls, roundText, stopReason, round, usage } = ctx;
  if (hasToolCalls) return;

  const textContent = roundText.trim();
  const outputTokens = usage?.outputTokens ?? null;

  const isMarkup =
    textContent.startsWith("[TOOL_CALLS]") || textContent.startsWith("[TOOL_REQUEST]");

  // The loop only reaches round > 0 by way of a prior tool round, so a clean
  // end_turn here means the model finished after doing its work, complete, even
  // if it added no closing prose. (Round 0 empty stays a failure: the model
  // answered nothing at all.) Markup / tool_use still fall through as failures.
  if (stopReason === "end_turn" && !isMarkup && round > 0) return;

  const isFailure = !textContent || isMarkup || stopReason === "tool_use";
  if (!isFailure) return;

  let cause: string;
  let recovery: string;
  if (isMarkup) {
    cause = "It emitted raw tool-call markup as plain text instead of a structured tool call, so no call could be parsed.";
    recovery =
      "This model's tool-call format isn't being recognized by the provider, switch to a model with native tool-calling, or turn tools off for this request.";
  } else if (stopReason === "tool_use") {
    cause = 'The provider reported a tool call (stop reason "tool_use") but returned no parseable call.';
    recovery = "The tool-call payload was malformed or empty, regenerate, or switch to a more capable model.";
  } else if (outputTokens && outputTokens > 0) {
    cause = `It generated ${outputTokens} token${outputTokens === 1 ? "" : "s"} but none were text content (likely reasoning-only output with an empty final message).`;
    recovery =
      "If this is a reasoning model it may have spent the turn thinking without answering, regenerate, or use a model that emits a final message.";
  } else if (stopReason === "max_tokens") {
    cause = "It hit the output token limit before producing any text.";
    recovery = "Raise the max output tokens for this model, or shorten the conversation.";
  } else {
    cause = "It returned an empty response with no text and no tool calls.";
    recovery =
      "The context may be too long, the request may have been cut off, or the model may be overloaded, regenerate, shorten the conversation, or switch models.";
  }

  throw new Error(formatFailedRoundMessage(ctx, cause, recovery, textContent, outputTokens));
}

/**
 * Render the failure as a multi-line block: a one-line summary, the classified
 * cause and suggested fix, then a labelled diagnostics section the user can copy
 * verbatim into a bug report. Errors render in a `white-space: pre-wrap` bubble,
 * so the line breaks survive; the same text is also useful pasted into a console
 * or issue. Keep every field on its own line, this exists to be reported.
 */
function formatFailedRoundMessage(
  ctx: FailedRoundContext,
  cause: string,
  recovery: string,
  textContent: string,
  outputTokens: number | null,
): string {
  const inputTokens = ctx.usage?.inputTokens ?? null;
  const tokenLine = (n: number | null): string => (n === null ? "unknown" : String(n));

  const diagnostics: Array<[string, string]> = [
    ["Provider", ctx.provider],
    ["Model", ctx.model],
    ["Round", `${ctx.round + 1} of ${ctx.maxRounds + 1}`],
    ["Stop reason", ctx.stopReason],
    ["Output tokens", tokenLine(outputTokens)],
    ["Input tokens", tokenLine(inputTokens)],
    ["Mode", ctx.mode],
    ["Agentic", ctx.agenticMode ? "on" : "off"],
    ["Tools attached", String(ctx.toolCount)],
  ];
  if (textContent) {
    const preview = textContent.slice(0, 300).replace(/\s+/g, " ");
    diagnostics.push(["Raw output", `"${preview}${textContent.length > 300 ? "…" : ""}"`]);
  }

  const diagnosticsBlock = diagnostics.map(([label, value]) => `  ${label}: ${value}`).join("\n");

  return [
    "The model returned no usable response.",
    "",
    `What happened: ${cause}`,
    `Try this: ${recovery}`,
    "",
    "Diagnostics (copy this when reporting the issue):",
    diagnosticsBlock,
  ].join("\n");
}
