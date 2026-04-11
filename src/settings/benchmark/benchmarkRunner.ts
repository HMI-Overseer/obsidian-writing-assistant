import type { ChatClient } from "../../api/chatClient";
import type { AnthropicCacheSettings, CompletionModel, SamplingParams } from "../../shared/types";
import type { ChatRequest, ChatTurn } from "../../shared/chatRequest";
import type { ToolCall } from "../../tools/types";
import type { BenchmarkTestCase, BenchmarkRunResult, BenchmarkIterationResult } from "./types";

/** Maximum read-only tool rounds before forcing finalization. */
const MAX_TOOL_ROUNDS = 5;

/**
 * Runs a single test case for N iterations, returning aggregate results.
 * Invokes `onIteration` after each individual iteration completes.
 *
 * When the test case includes tool definitions, the runner executes a
 * multi-round tool loop that handles write tool calls and plain text responses.
 */
export async function runBenchmarkTest(
  client: ChatClient,
  model: CompletionModel,
  testCase: BenchmarkTestCase,
  iterationCount: number,
  params: SamplingParams,
  onIteration?: (testId: string, iteration: BenchmarkIterationResult) => void,
  signal?: AbortSignal,
  cacheSettings?: AnthropicCacheSettings,
): Promise<BenchmarkRunResult> {
  const baseRequest: ChatRequest = {
    systemPrompt: testCase.systemPromptSuffix,
    documentContext: {
      filePath: "test-document.md",
      content: testCase.document,
      isFull: true,
    },
    ragContext: null,
    messages: testCase.messages.map((m) => ({
      role: m.role,
      content: m.content,
    })),
    tools: testCase.tools,
  };

  if (cacheSettings?.enabled) {
    baseRequest.anthropicCacheSettings = cacheSettings;
  }

  const iterations: BenchmarkIterationResult[] = [];

  for (let i = 0; i < iterationCount; i++) {
    if (signal?.aborted) break;

    const start = Date.now();
    const { text, toolCalls } = await runWithToolLoop(
      client, model.modelId, params, baseRequest, testCase.document, signal,
    );
    const durationMs = Date.now() - start;
    const result = testCase.evaluate(text, testCase, toolCalls);

    const iterResult: BenchmarkIterationResult = { iteration: i + 1, result, rawResponse: text, toolCalls, durationMs };
    iterations.push(iterResult);
    onIteration?.(testCase.id, iterResult);
  }

  const passCount = iterations.filter((it) => it.result.passed).length;
  const totalDuration = iterations.reduce((sum, it) => sum + it.durationMs, 0);

  return {
    testId: testCase.id,
    testName: testCase.name,
    modelId: model.modelId,
    iterations,
    passCount,
    totalCount: iterations.length,
    avgDurationMs: iterations.length > 0 ? totalDuration / iterations.length : 0,
  };
}

/**
 * Runs all test cases sequentially (each for N iterations).
 * Invokes `onTestComplete` after all iterations of a test finish.
 */
export async function runAllBenchmarks(
  client: ChatClient,
  model: CompletionModel,
  testCases: BenchmarkTestCase[],
  iterationCount: number,
  params: SamplingParams,
  onTestComplete: (result: BenchmarkRunResult, index: number) => void,
  onIteration?: (testId: string, iteration: BenchmarkIterationResult) => void,
  signal?: AbortSignal,
  cacheSettings?: AnthropicCacheSettings,
): Promise<BenchmarkRunResult[]> {
  const results: BenchmarkRunResult[] = [];

  for (let i = 0; i < testCases.length; i++) {
    if (signal?.aborted) break;

    const result = await runBenchmarkTest(client, model, testCases[i], iterationCount, params, onIteration, signal, cacheSettings);
    results.push(result);
    onTestComplete(result, i);
  }

  return results;
}

// ---------------------------------------------------------------------------
// Tool loop
// ---------------------------------------------------------------------------

interface ToolLoopResult {
  text: string;
  toolCalls: ToolCall[] | null;
}

/**
 * Executes a single-shot or multi-round completion loop.
 * The loop continues until the model produces write tool calls,
 * plain text, or the round limit is reached.
 */
async function runWithToolLoop(
  client: ChatClient,
  modelId: string,
  params: SamplingParams,
  baseRequest: ChatRequest,
  _document: string,
  signal?: AbortSignal,
): Promise<ToolLoopResult> {
  // No tools defined — single-shot completion.
  if (!baseRequest.tools || baseRequest.tools.length === 0) {
    const result = await client.complete(baseRequest, modelId, params, signal);
    return { text: result.text, toolCalls: result.toolCalls ?? null };
  }

  const toolLoopTurns: ChatTurn[] = [];
  let allWriteToolCalls: ToolCall[] = [];
  let fullText = "";

  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    if (signal?.aborted) break;

    const request: ChatRequest = {
      ...baseRequest,
      messages: [...baseRequest.messages, ...toolLoopTurns],
    };

    const result = await client.complete(request, modelId, params, signal);
    fullText += result.text;
    const toolCalls = result.toolCalls ?? null;

    if (!toolCalls || toolCalls.length === 0) break;

    allWriteToolCalls = [...allWriteToolCalls, ...toolCalls];
    break;
  }

  const finalToolCalls = allWriteToolCalls.length > 0 ? allWriteToolCalls : null;
  return { text: fullText, toolCalls: finalToolCalls };
}
