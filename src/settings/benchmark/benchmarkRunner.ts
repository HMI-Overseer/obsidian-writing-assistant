import type { LMStudioClient } from "../../api/LMStudioClient";
import type { CompletionModel, Message } from "../../shared/types";
import type { BenchmarkTestCase, BenchmarkRunResult, BenchmarkIterationResult } from "./types";

/**
 * Runs a single test case for N iterations, returning aggregate results.
 * Invokes `onIteration` after each individual iteration completes.
 */
export async function runBenchmarkTest(
  client: LMStudioClient,
  model: CompletionModel,
  testCase: BenchmarkTestCase,
  iterationCount: number,
  onIteration?: (testId: string, iteration: BenchmarkIterationResult) => void,
  signal?: AbortSignal
): Promise<BenchmarkRunResult> {
  const systemContent =
    model.systemPrompt +
    testCase.systemPromptSuffix +
    `\n\n---\nDocument to edit (test-document.md):\n${testCase.document}`;

  const messages: Message[] = [
    { role: "system", content: systemContent },
    ...testCase.messages.map((m) => ({
      role: m.role as "system" | "user" | "assistant",
      content: m.content,
    })),
  ];

  const iterations: BenchmarkIterationResult[] = [];

  for (let i = 0; i < iterationCount; i++) {
    if (signal?.aborted) break;

    const start = Date.now();
    const rawResponse = await client.complete(
      messages,
      model.modelId,
      model.maxTokens,
      model.temperature,
      signal
    );
    const durationMs = Date.now() - start;
    const result = testCase.evaluate(rawResponse, testCase);

    const iterResult: BenchmarkIterationResult = { iteration: i + 1, result, rawResponse, durationMs };
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
  client: LMStudioClient,
  model: CompletionModel,
  testCases: BenchmarkTestCase[],
  iterationCount: number,
  onTestComplete: (result: BenchmarkRunResult, index: number) => void,
  onIteration?: (testId: string, iteration: BenchmarkIterationResult) => void,
  signal?: AbortSignal
): Promise<BenchmarkRunResult[]> {
  const results: BenchmarkRunResult[] = [];

  for (let i = 0; i < testCases.length; i++) {
    if (signal?.aborted) break;

    const result = await runBenchmarkTest(client, model, testCases[i], iterationCount, onIteration, signal);
    results.push(result);
    onTestComplete(result, i);
  }

  return results;
}
