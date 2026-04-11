import type { ChatClient } from "../../api/chatClient";
import type { ChatRequest, ChatTurn } from "../../shared/chatRequest";
import type { AgenticStep, SamplingParams } from "../../shared/types";
import type { ToolCall } from "../../tools/types";
import type { UsageResult, StopReason } from "../../api/usageTypes";
import { VAULT_TOOL_NAMES } from "../../tools/vault/definition";
import { executeVaultTool } from "../../tools/vault/handlers";
import type { VaultToolContext } from "../../tools/vault/handlers";
import { EDIT_TOOL_NAMES } from "../../tools/editing/definition";
import { executeEditTool } from "../../tools/editing/handlers";
import type { ToolExecutionContext } from "../../tools/editing/handlers";
import { THINK_TOOL_NAME } from "../../tools/think/definition";
import { extractToolInput } from "../../tools/metadata";

export type { VaultToolContext, ToolExecutionContext };

/** All tool names that execute inside the tool loop (results feed back to the model). */
const ALL_LOOP_TOOL_NAMES = new Set([
  ...VAULT_TOOL_NAMES,
  ...EDIT_TOOL_NAMES,
  THINK_TOOL_NAME,
]);

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
  /** Called with each text delta during streaming for live reasoning display in the timeline. */
  onReasoningDelta?: (delta: string) => void;
  /**
   * Called when a round ends.
   * committed=true: the model called tools — keep the live reasoning entry.
   * committed=false: the model produced a final text response — discard the live entry.
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
 * This function is pure orchestration — it doesn't know about UI components,
 * conversation persistence, or edit-mode specifics.
 */
export async function runToolLoop(
  client: ChatClient,
  baseRequest: ChatRequest,
  model: string,
  params: SamplingParams,
  signal: AbortSignal,
  callbacks: ToolLoopCallbacks,
  maxRounds: number,
  agenticMode: boolean,
  vaultToolContext?: VaultToolContext,
  editToolContext?: ToolExecutionContext,
): Promise<ToolLoopResult> {
  const toolLoopTurns: ChatTurn[] = [];
  let allWriteToolCalls: ToolCall[] = [];
  let fullText = "";
  let previousRoundsText = "";
  let finalUsage: UsageResult | null = null;
  let calibrated = false;
  // Set to true once a cap-hit synthesis pass has been injected.
  let capHit = false;

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

    // In agentic mode, buffer deltas internally — only the timeline receives
    // live updates. The bubble gets the text only for the final round (flushed
    // after we confirm no tool calls follow). In non-agentic mode, deltas flow
    // directly to the bubble as before.
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
      // On abort (or other errors), flush whatever we buffered so partial
      // text is preserved in the renderer for finalizeAbortedResponse.
      if (agenticMode && roundBuffer) {
        callbacks.onDelta(roundBuffer);
      }
      throw e;
    }

    const usage = await streamResult.usage;
    const toolCalls = await streamResult.toolCalls;
    const stopReason = await streamResult.stopReason;

    if (usage && callbacks.onCalibrate && !calibrated) {
      callbacks.onCalibrate(roundRequest, usage);
      calibrated = true;
    }
    if (usage) finalUsage = usage;

    const roundText = fullText.slice(previousRoundsText.length);

    const hasToolCalls = toolCalls !== null && toolCalls.length > 0;

    // Detect failed tool calls: model stopped but produced nothing useful.
    checkForFailedToolCall(hasToolCalls, roundText, stopReason);

    if (!hasToolCalls || !toolCalls) {
      // Final round — flush buffered text to the bubble.
      if (agenticMode && roundBuffer) {
        callbacks.onDelta(roundBuffer);
      }
      callbacks.onReasoningRoundFinished?.(false, round);
      break;
    }

    // Classify tool calls: known loop tools execute inline; unknown tools are
    // accumulated as write tool calls for the finalization pipeline.
    const loopCalls = toolCalls.filter((tc) => ALL_LOOP_TOOL_NAMES.has(tc.name));
    const unknownCalls = toolCalls.filter((tc) => !ALL_LOOP_TOOL_NAMES.has(tc.name));
    if (unknownCalls.length > 0) {
      allWriteToolCalls = [...allWriteToolCalls, ...unknownCalls];
    }

    // Collect edit tool calls for finalization (they execute in the loop AND
    // get accumulated so the diff review panel can render them at the end).
    const editCalls = loopCalls.filter((tc) => EDIT_TOOL_NAMES.has(tc.name));
    if (editCalls.length > 0) {
      allWriteToolCalls = [...allWriteToolCalls, ...editCalls];
    }

    // Cap reached: push terminal error results to keep history valid, then let
    // the model produce one synthesis response. If it calls tools again after
    // the warning, hard-stop.
    if (capHit || round >= maxRounds) {
      if (capHit) {
        // Model ignored the cap warning and called tools again — hard stop.
        if (agenticMode && roundBuffer) {
          callbacks.onDelta(roundBuffer);
        }
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

    // Normal intermediate tool execution round — do NOT flush to bubble.
    callbacks.onReasoningRoundFinished?.(true, round);

    const vaultCalls = loopCalls.filter((tc) => VAULT_TOOL_NAMES.has(tc.name));
    const thinkCalls = loopCalls.filter((tc) => tc.name === THINK_TOOL_NAME);

    toolLoopTurns.push({
      role: "assistant",
      content: roundText || null,
      toolCalls: loopCalls.map((tc) => ({ id: tc.id, name: tc.name, arguments: tc.arguments })),
    });

    // Execute all tools in parallel.
    const results = await Promise.all([
      ...vaultCalls.map(async (tc) => {
        callbacks.onToolStatus?.(tc.name);
        if (!vaultToolContext) {
          return {
            tc,
            result: { content: "Vault tool context unavailable.", isReadOnly: true, isError: true },
          };
        }
        return { tc, result: await executeVaultTool(tc, vaultToolContext) };
      }),
      ...editCalls.map(async (tc) => {
        callbacks.onToolStatus?.(tc.name);
        if (!editToolContext) {
          return {
            tc,
            result: { content: "Edit tool context unavailable.", isReadOnly: false, isError: true },
          };
        }
        return { tc, result: await executeEditTool(tc, editToolContext) };
      }),
      // think is a no-op: returns empty content so the model continues reasoning.
      ...thinkCalls.map((tc) => ({
        tc,
        result: { content: "", isReadOnly: true as const },
      })),
    ]);

    for (const { tc, result } of results) {
      toolLoopTurns.push({
        role: "tool",
        content: result.content,
        toolCallId: tc.id,
      });
      callbacks.onStepRecorded?.({
        type: "tool_call",
        round,
        toolName: tc.name,
        toolInput: extractToolInput(tc),
      });
    }

    previousRoundsText = fullText;
    callbacks.onNewRound?.();
  }

  return {
    writeToolCalls: allWriteToolCalls.length > 0 ? allWriteToolCalls : null,
    usage: finalUsage,
  };
}

function checkForFailedToolCall(
  hasToolCalls: boolean,
  roundText: string,
  stopReason: StopReason,
): void {
  if (hasToolCalls) return;

  const textContent = roundText.trim();
  const looksLikeFailedToolCall =
    !textContent
    || textContent.startsWith("[TOOL_CALLS]")
    || textContent.startsWith("[TOOL_REQUEST]")
    || (stopReason === "tool_use");

  if (looksLikeFailedToolCall) {
    const preview = textContent
      ? ` Raw output: "${textContent.slice(0, 200)}${textContent.length > 200 ? "…" : ""}"`
      : " The model produced no output.";
    throw new Error(
      "The model attempted a tool call but failed to generate valid output." +
      preview +
      " Try regenerating or switching to a more capable model."
    );
  }
}
