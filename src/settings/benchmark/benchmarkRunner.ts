import type { ChatClient } from "../../api/chatClient";
import type { CompletionResult } from "../../api/usageTypes";
import type { AnthropicCacheSettings, CompletionModel, SamplingParams } from "../../shared/types";
import type { ChatRequest } from "../../shared/chatRequest";
import type { BenchmarkTestCase, BenchmarkRunResult, BenchmarkIterationResult } from "./types";

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Runs a single test case for N iterations, returning aggregate results.
 * Invokes `onIteration` after each individual iteration completes.
 *
 * Each iteration is a single completion request — benchmark tests evaluate the
 * model's first response (text or tool calls), mirroring the single-turn
 * scenarios the test cases describe.
 *
 * A request error stops the remaining iterations and is recorded on
 * `result.error`; iterations completed before the error are kept.
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
  const request: ChatRequest = {
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
    request.anthropicCacheSettings = cacheSettings;
  }

  const iterations: BenchmarkIterationResult[] = [];
  let runError: string | undefined;

  for (let i = 0; i < iterationCount; i++) {
    if (signal?.aborted) break;

    const start = Date.now();
    let completion: CompletionResult;
    try {
      completion = await client.complete(request, model.modelId, params, signal);
    } catch (err) {
      if (!isAbortError(err)) runError = errorMessage(err);
      break;
    }
    const durationMs = Date.now() - start;
    const toolCalls = completion.toolCalls ?? null;
    const result = testCase.evaluate(completion.text, testCase, toolCalls);

    const iterResult: BenchmarkIterationResult = { iteration: i + 1, result, rawResponse: completion.text, toolCalls, durationMs };
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
    error: runError,
  };
}

/**
 * Runs all test cases sequentially (each for N iterations).
 * Invokes `onTestComplete` after all iterations of a test finish.
 *
 * A failing test does not stop the run: its error is recorded on the result
 * and the remaining tests still execute. Only an abort stops the run early.
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
