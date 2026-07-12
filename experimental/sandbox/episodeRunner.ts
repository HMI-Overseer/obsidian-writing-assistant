import type { ChatClient } from "../../src/api/chatClient";
import type { CompletionResult } from "../../src/api/usageTypes";
import type { ChatRequest, ChatTurn } from "../../src/shared/chatRequest";
import type { ToolCall } from "../../src/tools/types";
import type { LabCheck } from "../lab/types";
import type { LabRunProvenance } from "../lab/types";
import { SandboxToolRegistry } from "./toolRegistry";
import { replaySandboxState } from "./stateReplay";
import { diffSyntheticSnapshots, SyntheticVault } from "./syntheticVault";
import {
  SANDBOX_EPISODE_TRACE_SCHEMA_VERSION,
  type SandboxEpisodeOptions,
  type SandboxEpisodeEvaluationContext,
  type SandboxEpisodeEvaluator,
  type SandboxEpisodeOutcome,
  type SandboxEpisodeRound,
  type SandboxEpisodeScenario,
  type SandboxEpisodeTrace,
  type SandboxStateEvaluator,
  type SyntheticVaultSnapshot,
} from "./types";

const DEFAULT_MAX_ROUNDS = 5;
const DEFAULT_MAX_TOOL_CALLS = 10;
const DEFAULT_MAX_REPEATED_TOOL_CALLS = 3;
const DEFAULT_MAX_TOTAL_TOKENS = 100_000;
const DEFAULT_MAX_OUTPUT_CHARS = 100_000;

function clone<T>(value: T): T {
  return structuredClone(value);
}

function evaluateEpisode(
  evaluator: SandboxEpisodeEvaluator,
  context: SandboxEpisodeEvaluationContext,
): LabCheck {
  try {
    const result = evaluator.evaluate(context);
    const normalized = typeof result === "boolean" ? { passed: result } : result;
    return {
      id: evaluator.id,
      label: evaluator.label,
      passed: normalized.passed,
      required: evaluator.required ?? true,
      ...(normalized.detail !== undefined ? { detail: normalized.detail } : {}),
    };
  } catch (error) {
    const detail = errorDetail(error);
    return {
      id: evaluator.id,
      label: evaluator.label,
      passed: false,
      required: true,
      detail: `Episode evaluator failed with ${detail.name}: ${detail.message}`,
    };
  }
}

function createEpisodeId(): string {
  return globalThis.crypto.randomUUID();
}

function errorDetail(error: unknown): { name: string; message: string } {
  return error instanceof Error
    ? { name: error.name, message: error.message }
    : { name: "UnknownError", message: String(error) };
}

function snapshotsEqual(left: SyntheticVaultSnapshot, right: SyntheticVaultSnapshot): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function evaluateState(
  evaluator: SandboxStateEvaluator,
  initial: SyntheticVaultSnapshot,
  final: SyntheticVaultSnapshot,
): LabCheck {
  try {
    const result = evaluator.evaluate(initial, final);
    const normalized = typeof result === "boolean" ? { passed: result } : result;
    return {
      id: evaluator.id,
      label: evaluator.label,
      passed: normalized.passed,
      required: evaluator.required ?? true,
      ...(normalized.detail !== undefined ? { detail: normalized.detail } : {}),
    };
  } catch (error) {
    const detail = errorDetail(error);
    return {
      id: evaluator.id,
      label: evaluator.label,
      passed: false,
      required: true,
      detail: `State evaluator failed with ${detail.name}: ${detail.message}`,
    };
  }
}

function validateLimit(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }
}

function assistantTurn(completion: CompletionResult, calls: ToolCall[]): ChatTurn {
  return {
    role: "assistant",
    content: completion.text || null,
    toolCalls: clone(calls),
    ...(completion.thinkingBlocks ? { anthropicThinkingBlocks: clone(completion.thinkingBlocks) } : {}),
  };
}

function completeWithAbort(
  client: ChatClient,
  request: ChatRequest,
  modelId: string,
  samplingParams: SandboxEpisodeScenario["samplingParams"],
  signal?: AbortSignal,
): Promise<CompletionResult> {
  if (!signal) return client.complete(request, modelId, samplingParams);
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error("Sandbox episode was aborted."));
  return new Promise((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason ?? new Error("Sandbox episode was aborted."));
    signal.addEventListener("abort", onAbort, { once: true });
    void client.complete(request, modelId, samplingParams, signal).then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", onAbort);
    });
  });
}

function callKey(call: ToolCall): string {
  const sortedArguments = Object.entries(call.arguments).sort(([left], [right]) =>
    left.localeCompare(right));
  return JSON.stringify([call.name, sortedArguments]);
}

export async function runSandboxEpisode(
  client: ChatClient,
  scenario: SandboxEpisodeScenario,
  options: SandboxEpisodeOptions = {},
): Promise<SandboxEpisodeTrace> {
  const maxRounds = options.maxRounds ?? DEFAULT_MAX_ROUNDS;
  const maxToolCalls = options.maxToolCalls ?? DEFAULT_MAX_TOOL_CALLS;
  const maxRepeatedToolCalls = options.maxRepeatedToolCalls ?? DEFAULT_MAX_REPEATED_TOOL_CALLS;
  const maxTotalTokens = options.maxTotalTokens ?? DEFAULT_MAX_TOTAL_TOKENS;
  const maxOutputChars = options.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS;
  validateLimit("Sandbox maximum rounds", maxRounds);
  validateLimit("Sandbox maximum tool calls", maxToolCalls);
  validateLimit("Sandbox maximum repeated tool calls", maxRepeatedToolCalls);
  validateLimit("Sandbox maximum total tokens", maxTotalTokens);
  validateLimit("Sandbox maximum output characters", maxOutputChars);

  const now = options.now ?? Date.now;
  const episodeId = (options.createEpisodeId ?? createEpisodeId)();
  const provenance: LabRunProvenance = clone(options.provenance ?? {
    sourceRevision: null,
    subject: { provider: "unspecified", modelId: scenario.modelId },
  });
  if (provenance.subject.modelId !== scenario.modelId) {
    throw new Error("Sandbox provenance model ID must match the scenario model ID.");
  }
  const startedAt = now();
  const vault = new SyntheticVault(clone(scenario.fixture));
  const registry = new SandboxToolRegistry(vault, scenario.writeReview ?? null);
  const initialSnapshot = vault.snapshot();
  const turns: ChatTurn[] = clone(scenario.request.messages);
  const rounds: SandboxEpisodeRound[] = [];
  let outcome: SandboxEpisodeOutcome = { kind: "completed" };
  let finalText = "";
  let toolCallCount = 0;
  let totalTokens = 0;
  const repeatedCalls = new Map<string, number>();

  try {
    for (let round = 1; round <= maxRounds; round++) {
      if (options.signal?.aborted) {
        throw options.signal.reason ?? new Error("Sandbox episode was aborted.");
      }
      const request: ChatRequest = {
        ...clone(scenario.request),
        messages: clone(turns),
        tools: clone(registry.definitions),
        allowedToolNames: registry.definitions.map((definition) => definition.name),
      };
      const roundStartedAt = now();
      const rawResponse = await completeWithAbort(
        client,
        clone(request),
        scenario.modelId,
        clone(scenario.samplingParams),
        options.signal,
      );
      const response = options.responseNormalizer
        ? options.responseNormalizer.normalize(clone(request), clone(rawResponse))
        : rawResponse;
      const calls = clone(response.toolCalls ?? []);
      const episodeRound: SandboxEpisodeRound = {
        round,
        request,
        rawResponse: clone(rawResponse),
        response: clone(response),
        durationMs: Math.max(0, now() - roundStartedAt),
        normalization: { changed: rawResponse.text !== response.text },
        toolExecutions: [],
      };
      rounds.push(episodeRound);

      totalTokens += (response.usage?.inputTokens ?? 0) + (response.usage?.outputTokens ?? 0);
      if (totalTokens > maxTotalTokens) {
        outcome = { kind: "token-limit", limit: maxTotalTokens };
        break;
      }
      if (rawResponse.text.length > maxOutputChars) {
        outcome = { kind: "output-limit", limit: maxOutputChars };
        break;
      }

      if (calls.length === 0) {
        finalText = response.text;
        break;
      }
      if (toolCallCount + calls.length > maxToolCalls) {
        outcome = { kind: "tool-call-limit", limit: maxToolCalls };
        break;
      }
      const pendingRepeatedCalls = new Map(repeatedCalls);
      const nextRepeatedCalls = calls.map((call) => {
        const key = callKey(call);
        const count = (pendingRepeatedCalls.get(key) ?? 0) + 1;
        pendingRepeatedCalls.set(key, count);
        return { key, count };
      });
      if (nextRepeatedCalls.some((entry) => entry.count > maxRepeatedToolCalls)) {
        outcome = { kind: "repeated-tool-call-limit", limit: maxRepeatedToolCalls };
        break;
      }
      for (const [key, count] of pendingRepeatedCalls) repeatedCalls.set(key, count);

      turns.push(assistantTurn(response, calls));
      for (const call of calls) {
        const snapshotBefore = vault.snapshot();
        const execution = await registry.executeWithEvidence(call);
        const snapshotAfter = vault.snapshot();
        episodeRound.toolExecutions.push({
          call: clone(call),
          result: clone(execution.result),
          snapshotBefore,
          snapshotAfter,
          review: clone(execution.review),
        });
        turns.push({ role: "tool", content: execution.result.content, toolCallId: call.id });
        toolCallCount++;
      }

      if (round === maxRounds) {
        outcome = { kind: "round-limit", limit: maxRounds };
      }
    }
  } catch (error) {
    outcome = { kind: "error", ...errorDetail(error) };
  }

  const finalSnapshot = vault.snapshot();
  const replayedSnapshot = replaySandboxState(initialSnapshot, rounds);
  const checks: LabCheck[] = [
    scenario.writeReview
      ? {
        id: "state-transitions-replay",
        label: "The final sandbox state replays exactly from reviewed proposals",
        passed: snapshotsEqual(replayedSnapshot, finalSnapshot),
        required: true,
      }
      : {
        id: "read-only-state-unchanged",
        label: "The read-only sandbox state is unchanged",
        passed: snapshotsEqual(initialSnapshot, finalSnapshot),
        required: true,
      },
    ...(scenario.stateEvaluators ?? []).map((evaluator) =>
      evaluateState(evaluator, initialSnapshot, finalSnapshot)),
  ];
  const evaluationContext: SandboxEpisodeEvaluationContext = {
    rounds: clone(rounds),
    finalText,
    initialSnapshot,
    finalSnapshot,
    outcome,
  };
  checks.push(
    ...(scenario.evaluators ?? []).map((evaluator) => evaluateEpisode(evaluator, evaluationContext)),
  );
  if (outcome.kind !== "completed") {
    checks.unshift({
      id: "episode-completed",
      label: "The sandbox episode completed within its limits",
      passed: false,
      required: true,
      detail: outcome.kind === "error"
        ? `${outcome.name}: ${outcome.message}`
        : `${outcome.kind} reached (${outcome.limit})`,
    });
  }

  return {
    schemaVersion: SANDBOX_EPISODE_TRACE_SCHEMA_VERSION,
    kind: "sandbox-episode",
    episodeId,
    run: options.run ? clone(options.run) : null,
    startedAt: new Date(startedAt).toISOString(),
    completedAt: new Date(now()).toISOString(),
    scenario: { id: scenario.id, version: scenario.version, title: scenario.title },
    conditions: {
      modelId: scenario.modelId,
      samplingParams: clone(scenario.samplingParams),
      maxRounds,
      maxToolCalls,
      maxRepeatedToolCalls,
      maxTotalTokens,
      maxOutputChars,
      responseNormalization: options.responseNormalizer
        ? { id: options.responseNormalizer.id, version: options.responseNormalizer.version }
        : null,
      compatibilityPolicy: options.compatibilityPolicy ? clone(options.compatibilityPolicy) : null,
      writeReview: scenario.writeReview ? clone(scenario.writeReview) : null,
    },
    provenance,
    fixture: { id: scenario.fixture.id, version: scenario.fixture.version },
    initialSnapshot,
    rounds,
    finalSnapshot,
    stateDiff: diffSyntheticSnapshots(initialSnapshot, finalSnapshot),
    finalText,
    outcome,
    checks,
    passed: outcome.kind === "completed" && checks.every((check) => !check.required || check.passed),
  };
}
