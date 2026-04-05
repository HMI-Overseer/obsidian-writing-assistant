import type { App } from "obsidian";
import type { ChatClient } from "../../api/chatClient";
import type { ChatRequest, ChatTurn } from "../../shared/chatRequest";
import type { SamplingParams } from "../../shared/types";
import type { ToolCall } from "../../tools/types";
import type { UsageResult, StopReason } from "../../api/usageTypes";
import { READ_ONLY_TOOL_NAMES } from "../../tools/editing/definition";
import { executeReadOnlyTool } from "../../tools/editing/handlers";

/** Maximum number of read-only tool rounds before forcing finalization. */
export const MAX_TOOL_ROUNDS = 5;

/** Callbacks the tool loop uses to interact with the streaming UI. */
export interface ToolLoopCallbacks {
  /** Called with each text delta from the stream. */
  onDelta: (delta: string) => void;
  /** Called to retrieve the full accumulated response text. */
  getFullResponse: () => string;
  /** Called when a read-only tool is about to execute. */
  onToolStatus?: (toolName: string) => void;
  /** Called to reset the renderer between tool-loop rounds. */
  onNewRound?: () => void;
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
 * tool calls, feeds results back to the model, and repeats until the model
 * produces write tool calls or a plain text response.
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
  app: App,
  filePath: string | undefined,
  callbacks: ToolLoopCallbacks,
): Promise<ToolLoopResult> {
  const toolLoopTurns: ChatTurn[] = [];
  let allWriteToolCalls: ToolCall[] = [];
  let previousRoundsText = "";
  let finalUsage: UsageResult | null = null;
  let calibrated = false;

  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    const requestMessages = [...baseRequest.messages, ...toolLoopTurns];
    const roundRequest = { ...baseRequest, messages: requestMessages };

    const streamResult = client.stream(roundRequest, model, params, signal);

    for await (const delta of streamResult.deltas) {
      callbacks.onDelta(delta);
    }

    const usage = await streamResult.usage;
    const toolCalls = await streamResult.toolCalls;
    const stopReason = await streamResult.stopReason;

    if (usage && callbacks.onCalibrate && !calibrated) {
      callbacks.onCalibrate(roundRequest, usage);
      calibrated = true;
    }
    if (usage) finalUsage = usage;

    const totalText = callbacks.getFullResponse();
    const roundText = totalText.slice(previousRoundsText.length);

    const hasToolCalls = toolCalls !== null && toolCalls.length > 0;

    // Detect failed tool calls: model stopped but produced nothing useful.
    checkForFailedToolCall(hasToolCalls, roundText, stopReason);

    if (!hasToolCalls || !toolCalls) break;

    const readOnlyCalls = toolCalls.filter((tc) => READ_ONLY_TOOL_NAMES.has(tc.name));
    const writeCalls = toolCalls.filter((tc) => !READ_ONLY_TOOL_NAMES.has(tc.name));
    allWriteToolCalls = [...allWriteToolCalls, ...writeCalls];

    // Only continue looping if ALL calls are read-only.
    if (readOnlyCalls.length > 0 && writeCalls.length === 0 && round < MAX_TOOL_ROUNDS) {
      if (!filePath) break;

      const assistantTurn: ChatTurn = {
        role: "assistant",
        content: roundText || null,
        toolCalls: readOnlyCalls.map((tc) => ({
          id: tc.id,
          name: tc.name,
          arguments: tc.arguments,
        })),
      };
      toolLoopTurns.push(assistantTurn);

      // Execute read-only tools in parallel.
      const results = await Promise.all(
        readOnlyCalls.map(async (tc) => {
          callbacks.onToolStatus?.(tc.name);
          return { tc, result: await executeReadOnlyTool(tc, { app, filePath }) };
        }),
      );

      for (const { tc, result } of results) {
        toolLoopTurns.push({
          role: "tool",
          content: result.content,
          toolCallId: tc.id,
        });
      }

      previousRoundsText = totalText;
      callbacks.onNewRound?.();
      continue;
    }

    // Has write tool calls (or mixed) — break and finalize.
    break;
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
    throw new Error(
      "The model attempted a tool call but failed to generate valid output. " +
      "Try regenerating or switching to a more capable model."
    );
  }
}
