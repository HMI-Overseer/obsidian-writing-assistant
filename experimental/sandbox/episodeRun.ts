import type { ChatClient } from "../../src/api/chatClient";
import { TOOL_RESULT_CONTROL_TOKEN_PREFIX } from "../candidates/toolResultControlTokenPrefix";
import type { LabRunProvenance } from "../lab/types";
import { runSandboxEpisode } from "./episodeRunner";
import {
  SANDBOX_EPISODE_RUN_SCHEMA_VERSION,
  type SandboxEpisodeRunManifest,
  type SandboxEpisodeRunOptions,
  type SandboxEpisodeRunResult,
  type SandboxEpisodeRunSummary,
  type SandboxEpisodeScenario,
  type SandboxEpisodeTrace,
} from "./types";

const DEFAULT_ITERATIONS = 1;
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_ROUNDS = 5;
const DEFAULT_MAX_TOOL_CALLS = 10;
const DEFAULT_MAX_REPEATED_TOOL_CALLS = 3;
const DEFAULT_MAX_TOTAL_TOKENS = 100_000;
const DEFAULT_MAX_OUTPUT_CHARS = 100_000;

function clone<T>(value: T): T {
  return structuredClone(value);
}

function createRunId(): string {
  return globalThis.crypto.randomUUID();
}

function createEpisodeId(): string {
  return globalThis.crypto.randomUUID();
}

function validatePositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }
}

function createEpisodeSignal(
  timeoutMs: number,
  parentSignal?: AbortSignal,
): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const onParentAbort = (): void => controller.abort(parentSignal?.reason);
  parentSignal?.addEventListener("abort", onParentAbort, { once: true });
  if (parentSignal?.aborted) onParentAbort();
  const timer = setTimeout(() => {
    controller.abort(new Error(`Sandbox episode exceeded ${timeoutMs} ms.`));
  }, timeoutMs);
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      parentSignal?.removeEventListener("abort", onParentAbort);
    },
  };
}

function rawLeakageRoundCount(trace: SandboxEpisodeTrace): number {
  return trace.rounds.filter((round) =>
    round.request.messages.at(-1)?.role === "tool" &&
    round.rawResponse.text.startsWith(TOOL_RESULT_CONTROL_TOKEN_PREFIX)).length;
}

function totalOrNull(values: Array<number | undefined>): number | null {
  return values.every((value) => value === undefined)
    ? null
    : values.reduce<number>((total, value) => total + (value ?? 0), 0);
}

function aggregate(values: number[]): {
  total: number;
  minimum: number | null;
  maximum: number | null;
  mean: number | null;
} {
  const total = values.reduce((sum, value) => sum + value, 0);
  return {
    total,
    minimum: values.length > 0 ? Math.min(...values) : null,
    maximum: values.length > 0 ? Math.max(...values) : null,
    mean: values.length > 0 ? total / values.length : null,
  };
}

export function summarizeSandboxEpisodeRun(
  manifest: SandboxEpisodeRunManifest,
  traces: SandboxEpisodeTrace[],
  completedAt: string,
): SandboxEpisodeRunSummary {
  const episodes = traces.map((trace) => {
    const durationMs = trace.rounds.reduce((total, round) => total + round.durationMs, 0);
    const toolCalls = trace.rounds.reduce(
      (total, round) => total + round.toolExecutions.length,
      0,
    );
    const inputTokens = totalOrNull(trace.rounds.map((round) => round.response.usage?.inputTokens));
    const outputTokens = totalOrNull(
      trace.rounds.map((round) => round.response.usage?.outputTokens),
    );
    return {
      iteration: trace.run?.iteration ?? 0,
      episodeId: trace.episodeId,
      passed: trace.passed,
      outcome: trace.outcome.kind,
      durationMs,
      toolCalls,
      inputTokens,
      outputTokens,
      normalizedRounds: trace.rounds.filter((round) => round.normalization.changed).length,
      rawLeakageRounds: rawLeakageRoundCount(trace),
      failedChecks: trace.checks
        .filter((check) => check.required && !check.passed)
        .map((check) => ({
          id: check.id,
          label: check.label,
          ...(check.detail !== undefined ? { detail: check.detail } : {}),
        })),
    };
  });
  const outcomes: Record<string, number> = {};
  for (const episode of episodes) {
    outcomes[episode.outcome] = (outcomes[episode.outcome] ?? 0) + 1;
  }
  const timing = aggregate(episodes.map((episode) => episode.durationMs));
  const tools = aggregate(episodes.map((episode) => episode.toolCalls));
  return {
    schemaVersion: SANDBOX_EPISODE_RUN_SCHEMA_VERSION,
    kind: "sandbox-episode-run-summary",
    runId: manifest.runId,
    completedAt,
    requestedCount: manifest.conditions.iterations,
    completedCount: traces.length,
    passCount: traces.filter((trace) => trace.passed).length,
    normalization: {
      episodeCount: episodes.filter((episode) => episode.normalizedRounds > 0).length,
      roundCount: episodes.reduce((total, episode) => total + episode.normalizedRounds, 0),
    },
    rawLeakage: {
      episodeCount: episodes.filter((episode) => episode.rawLeakageRounds > 0).length,
      roundCount: episodes.reduce((total, episode) => total + episode.rawLeakageRounds, 0),
    },
    timingMs: timing,
    toolCalls: tools,
    usage: {
      inputTokens: episodes.reduce((total, episode) => total + (episode.inputTokens ?? 0), 0),
      outputTokens: episodes.reduce((total, episode) => total + (episode.outputTokens ?? 0), 0),
      episodesWithInputUsage: episodes.filter((episode) => episode.inputTokens !== null).length,
      episodesWithOutputUsage: episodes.filter((episode) => episode.outputTokens !== null).length,
    },
    outcomes,
    episodes,
  };
}

function createManifest(args: {
  runId: string;
  startedAt: number;
  scenario: SandboxEpisodeScenario;
  iterations: number;
  timeoutMs: number;
  maxRounds: number;
  maxToolCalls: number;
  maxRepeatedToolCalls: number;
  maxTotalTokens: number;
  maxOutputChars: number;
  provenance: LabRunProvenance;
  options: SandboxEpisodeRunOptions;
}): SandboxEpisodeRunManifest {
  return {
    schemaVersion: SANDBOX_EPISODE_RUN_SCHEMA_VERSION,
    kind: "sandbox-episode-run",
    runId: args.runId,
    startedAt: new Date(args.startedAt).toISOString(),
    scenario: {
      id: args.scenario.id,
      version: args.scenario.version,
      title: args.scenario.title,
      description: args.scenario.description,
    },
    fixture: { id: args.scenario.fixture.id, version: args.scenario.fixture.version },
    conditions: {
      iterations: args.iterations,
      timeoutMs: args.timeoutMs,
      maxRounds: args.maxRounds,
      maxToolCalls: args.maxToolCalls,
      maxRepeatedToolCalls: args.maxRepeatedToolCalls,
      maxTotalTokens: args.maxTotalTokens,
      maxOutputChars: args.maxOutputChars,
      samplingParams: clone(args.scenario.samplingParams),
      responseNormalization: args.options.responseNormalizer
        ? {
          id: args.options.responseNormalizer.id,
          version: args.options.responseNormalizer.version,
        }
        : null,
      compatibilityPolicy: args.options.compatibilityPolicy
        ? clone(args.options.compatibilityPolicy)
        : null,
      writeReview: args.scenario.writeReview ? clone(args.scenario.writeReview) : null,
    },
    provenance: clone(args.provenance),
  };
}

export async function runSandboxEpisodeExperiment(
  client: ChatClient,
  scenario: SandboxEpisodeScenario,
  options: SandboxEpisodeRunOptions = {},
): Promise<SandboxEpisodeRunResult> {
  const iterations = options.iterations ?? DEFAULT_ITERATIONS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRounds = options.maxRounds ?? DEFAULT_MAX_ROUNDS;
  const maxToolCalls = options.maxToolCalls ?? DEFAULT_MAX_TOOL_CALLS;
  const maxRepeatedToolCalls = options.maxRepeatedToolCalls ?? DEFAULT_MAX_REPEATED_TOOL_CALLS;
  const maxTotalTokens = options.maxTotalTokens ?? DEFAULT_MAX_TOTAL_TOKENS;
  const maxOutputChars = options.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS;
  validatePositiveInteger("Sandbox episode iterations", iterations);
  validatePositiveInteger("Sandbox episode timeout", timeoutMs);
  validatePositiveInteger("Sandbox maximum rounds", maxRounds);
  validatePositiveInteger("Sandbox maximum tool calls", maxToolCalls);
  validatePositiveInteger("Sandbox maximum repeated tool calls", maxRepeatedToolCalls);
  validatePositiveInteger("Sandbox maximum total tokens", maxTotalTokens);
  validatePositiveInteger("Sandbox maximum output characters", maxOutputChars);

  const now = options.now ?? Date.now;
  const runId = (options.createRunId ?? createRunId)();
  const provenance = clone(options.provenance ?? {
    sourceRevision: null,
    subject: { provider: "unspecified", modelId: scenario.modelId },
  });
  if (provenance.subject.modelId !== scenario.modelId) {
    throw new Error("Sandbox provenance model ID must match the scenario model ID.");
  }
  const manifest = createManifest({
    runId,
    startedAt: now(),
    scenario,
    iterations,
    timeoutMs,
    maxRounds,
    maxToolCalls,
    maxRepeatedToolCalls,
    maxTotalTokens,
    maxOutputChars,
    provenance,
    options,
  });
  const traces: SandboxEpisodeTrace[] = [];
  const episodeIds = new Set<string>();
  await options.artifactSink?.begin(clone(manifest));

  for (let iteration = 1; iteration <= iterations; iteration++) {
    if (options.signal?.aborted) break;
    const episodeId = (options.createEpisodeId ?? createEpisodeId)(iteration);
    if (episodeIds.has(episodeId)) {
      throw new Error(`Sandbox episode ID ${JSON.stringify(episodeId)} is not unique within the run.`);
    }
    episodeIds.add(episodeId);
    const episodeSignal = createEpisodeSignal(timeoutMs, options.signal);
    try {
      const trace = await runSandboxEpisode(client, scenario, {
        maxRounds,
        maxToolCalls,
        maxRepeatedToolCalls,
        maxTotalTokens,
        maxOutputChars,
        signal: episodeSignal.signal,
        createEpisodeId: () => episodeId,
        now,
        provenance,
        responseNormalizer: options.responseNormalizer,
        compatibilityPolicy: options.compatibilityPolicy,
        run: { id: runId, iteration },
      });
      traces.push(trace);
      await options.artifactSink?.write(clone(trace));
    } finally {
      episodeSignal.dispose();
    }
  }

  const summary = summarizeSandboxEpisodeRun(
    manifest,
    traces,
    new Date(now()).toISOString(),
  );
  const result = { runId, manifest, traces, summary };
  await options.artifactSink?.finish(clone(result));
  return result;
}
