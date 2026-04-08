import type { ChatClient } from "../../api/chatClient";
import type { CompletionModel, SamplingParams } from "../../shared/types";
import type { ChatRequest, ChatTurn } from "../../shared/chatRequest";
import type { ToolCall } from "../../tools/types";
import { READ_ONLY_TOOL_NAMES } from "../../tools/editing/definition";
import type { BenchmarkTestCase, BenchmarkRunResult, BenchmarkIterationResult } from "./types";

/** Maximum read-only tool rounds before forcing finalization. */
const MAX_TOOL_ROUNDS = 5;

/**
 * Runs a single test case for N iterations, returning aggregate results.
 * Invokes `onIteration` after each individual iteration completes.
 *
 * When the test case includes tool definitions, the runner executes a
 * multi-round tool loop: read-only tool calls (get_document_outline,
 * get_line_range) are simulated from the test document, and results are
 * sent back to the model for another round — just like the real chat path.
 */
export async function runBenchmarkTest(
  client: ChatClient,
  model: CompletionModel,
  testCase: BenchmarkTestCase,
  iterationCount: number,
  params: SamplingParams,
  onIteration?: (testId: string, iteration: BenchmarkIterationResult) => void,
  signal?: AbortSignal
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

  if (model.anthropicCacheSettings?.enabled) {
    baseRequest.anthropicCacheSettings = model.anthropicCacheSettings;
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
  signal?: AbortSignal
): Promise<BenchmarkRunResult[]> {
  const results: BenchmarkRunResult[] = [];

  for (let i = 0; i < testCases.length; i++) {
    if (signal?.aborted) break;

    const result = await runBenchmarkTest(client, model, testCases[i], iterationCount, params, onIteration, signal);
    results.push(result);
    onTestComplete(result, i);
  }

  return results;
}

// ---------------------------------------------------------------------------
// Tool loop — simulates read-only tools from the test document
// ---------------------------------------------------------------------------

interface ToolLoopResult {
  text: string;
  toolCalls: ToolCall[] | null;
}

/**
 * Executes a multi-round completion loop. When the model calls read-only
 * tools (get_document_outline, get_line_range), their results are simulated
 * from the test document and sent back. The loop continues until the model
 * produces write tool calls, plain text, or the round limit is reached.
 */
async function runWithToolLoop(
  client: ChatClient,
  modelId: string,
  params: SamplingParams,
  baseRequest: ChatRequest,
  document: string,
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

    const readOnlyCalls = toolCalls.filter((tc) => READ_ONLY_TOOL_NAMES.has(tc.name));
    const writeCalls = toolCalls.filter((tc) => !READ_ONLY_TOOL_NAMES.has(tc.name));
    allWriteToolCalls = [...allWriteToolCalls, ...writeCalls];

    // All read-only — simulate responses and continue.
    if (readOnlyCalls.length > 0 && writeCalls.length === 0 && round < MAX_TOOL_ROUNDS) {
      // Add assistant turn with tool calls.
      toolLoopTurns.push({
        role: "assistant",
        content: result.text || null,
        toolCalls: readOnlyCalls.map((tc) => ({
          id: tc.id,
          name: tc.name,
          arguments: tc.arguments,
        })),
      });

      // Simulate each read-only tool result.
      for (const tc of readOnlyCalls) {
        const simulated = simulateReadOnlyTool(tc, document);
        toolLoopTurns.push({
          role: "tool",
          content: simulated,
          toolCallId: tc.id,
        });
      }

      continue;
    }

    // Has write calls (or mixed) — break and return them.
    break;
  }

  const finalToolCalls = allWriteToolCalls.length > 0 ? allWriteToolCalls : null;
  return { text: fullText, toolCalls: finalToolCalls };
}

/**
 * Simulates a read-only tool response from the test document string.
 * No Obsidian API needed — pure string operations.
 */
function simulateReadOnlyTool(toolCall: ToolCall, document: string): string {
  switch (toolCall.name) {
    case "get_document_outline":
      return simulateDocumentOutline(document);
    case "get_line_range":
      return simulateLineRange(document, toolCall.arguments);
    default:
      return `Unknown tool: ${toolCall.name}`;
  }
}

function simulateDocumentOutline(document: string): string {
  const lines = document.split("\n");
  const parts: string[] = [];
  parts.push(`Document: "test-document.md" (${lines.length} lines)`);

  // Detect frontmatter
  if (lines[0] === "---") {
    const endIdx = lines.indexOf("---", 1);
    if (endIdx > 0) {
      parts.push(`Frontmatter: yes (lines 1-${endIdx + 1})`);
    }
  } else {
    parts.push("Frontmatter: none");
  }

  parts.push("");
  parts.push("## Heading Outline");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const match = line.match(/^(#{1,6})\s+(.+)$/);
    if (match) {
      const level = match[1].length;
      const heading = match[2];
      parts.push(`- L${level}: ${match[1]} ${heading} (line ${i + 1})`);
    }
  }

  return parts.join("\n");
}

function simulateLineRange(document: string, args: Record<string, unknown>): string {
  const lines = document.split("\n");
  const startLine = args.start_line as number;
  if (!startLine || startLine < 1) {
    return "Error: start_line must be a positive integer (1-indexed).";
  }

  let endLine = args.end_line as number | undefined;
  if (!endLine || endLine === -1) {
    endLine = lines.length;
  }

  const clampedStart = Math.max(1, Math.min(startLine, lines.length));
  const clampedEnd = Math.max(clampedStart, Math.min(endLine, lines.length));

  const result: string[] = [];
  for (let i = clampedStart; i <= clampedEnd; i++) {
    result.push(`${i}\t${lines[i - 1]}`);
  }

  return result.join("\n");
}
