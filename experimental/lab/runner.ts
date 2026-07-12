import type { CompletionResult } from "../../src/api/usageTypes";
import {
  LAB_TRACE_SCHEMA_VERSION,
  type LabCheck,
  type LabDependencies,
  type LabErrorOutcome,
  type LabEvaluator,
  type LabObservation,
  type LabRunOptions,
  type LabRunManifest,
  type LabRunProvenance,
  type LabRunResult,
  type LabScenario,
  type LabTrialTrace,
} from "./types";

const DEFAULT_ITERATIONS = 1;
const DEFAULT_TIMEOUT_MS = 60_000;

function clone<T>(value: T): T {
  return structuredClone(value);
}

function errorDetail(error: unknown): { name: string; message: string } {
  if (error instanceof Error) {
    return { name: error.name, message: error.message };
  }
  return { name: "UnknownError", message: String(error) };
}

function createRunId(): string {
  return globalThis.crypto.randomUUID();
}

function createTrialSignal(
  timeoutMs: number,
  parentSignal?: AbortSignal,
): { signal: AbortSignal; didTimeOut: () => boolean; dispose: () => void } {
  const controller = new AbortController();
  let timedOut = false;
  const onParentAbort = (): void => controller.abort(parentSignal?.reason);
  parentSignal?.addEventListener("abort", onParentAbort, { once: true });
  if (parentSignal?.aborted) onParentAbort();

  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error(`Laboratory trial exceeded ${timeoutMs} ms.`));
  }, timeoutMs);

  return {
    signal: controller.signal,
    didTimeOut: () => timedOut,
    dispose: () => {
      clearTimeout(timer);
      parentSignal?.removeEventListener("abort", onParentAbort);
    },
  };
}

function evaluateOne(evaluator: LabEvaluator, observation: LabObservation): LabCheck {
  try {
    const result = evaluator.evaluate(observation);
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
      detail: `Evaluator failed with ${detail.name}: ${detail.message}`,
    };
  }
}

function transportCheck(outcome: LabErrorOutcome): LabCheck {
  return {
    id: "completion-succeeded",
    label: "The model completion succeeded",
    passed: false,
    required: true,
    detail: `${outcome.error.name}: ${outcome.error.message}`,
  };
}

function makeTrace(args: {
  runId: string;
  trial: number;
  startedAt: number;
  durationMs: number;
  timeoutMs: number;
  scenario: LabScenario;
  completion?: CompletionResult;
  error?: unknown;
  timedOut: boolean;
  provenance: LabRunProvenance;
}): LabTrialTrace {
  const request = clone(args.scenario.request);
  let outcome: LabTrialTrace["outcome"];
  let checks: LabCheck[];

  if (args.completion) {
    const response = clone(args.completion);
    outcome = { kind: "completion", response };
    const observation: LabObservation = {
      request,
      completion: response,
      durationMs: args.durationMs,
    };
    checks = args.scenario.evaluators.map((evaluator) => evaluateOne(evaluator, observation));
  } else {
    const detail = errorDetail(args.error);
    outcome = {
      kind: "error",
      error: { ...detail, timedOut: args.timedOut },
    };
    checks = [transportCheck(outcome)];
  }

  return {
    schemaVersion: LAB_TRACE_SCHEMA_VERSION,
    runId: args.runId,
    trial: args.trial,
    startedAt: new Date(args.startedAt).toISOString(),
    scenario: {
      id: args.scenario.id,
      version: args.scenario.version,
      title: args.scenario.title,
    },
    conditions: {
      modelId: args.scenario.modelId,
      samplingParams: clone(args.scenario.samplingParams),
      timeoutMs: args.timeoutMs,
    },
    provenance: clone(args.provenance),
    request,
    durationMs: args.durationMs,
    outcome,
    checks,
    passed: checks.every((check) => !check.required || check.passed),
  };
}

function makeManifest(args: {
  runId: string;
  startedAt: number;
  iterations: number;
  timeoutMs: number;
  scenario: LabScenario;
  provenance: LabRunProvenance;
}): LabRunManifest {
  return {
    schemaVersion: LAB_TRACE_SCHEMA_VERSION,
    runId: args.runId,
    startedAt: new Date(args.startedAt).toISOString(),
    scenario: {
      id: args.scenario.id,
      version: args.scenario.version,
      title: args.scenario.title,
      description: args.scenario.description,
    },
    conditions: {
      iterations: args.iterations,
      timeoutMs: args.timeoutMs,
      samplingParams: clone(args.scenario.samplingParams),
    },
    provenance: clone(args.provenance),
  };
}

export async function runLabScenario(
  dependencies: LabDependencies,
  scenario: LabScenario,
  options: LabRunOptions = {},
): Promise<LabRunResult> {
  const iterations = options.iterations ?? DEFAULT_ITERATIONS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(iterations) || iterations < 1) {
    throw new Error("Laboratory iterations must be a positive integer.");
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("Laboratory timeout must be greater than zero.");
  }

  const now = options.now ?? Date.now;
  const runId = (options.createRunId ?? createRunId)();
  const runStartedAt = now();
  const provenance: LabRunProvenance = clone(options.provenance ?? {
    sourceRevision: null,
    subject: {
      provider: "unspecified",
      modelId: scenario.modelId,
    },
  });
  if (provenance.subject.modelId !== scenario.modelId) {
    throw new Error("Laboratory provenance model ID must match the scenario model ID.");
  }
  const manifest = makeManifest({
    runId,
    startedAt: runStartedAt,
    iterations,
    timeoutMs,
    scenario,
    provenance,
  });
  const traces: LabTrialTrace[] = [];
  await options.artifactSink?.begin?.(clone(manifest));

  for (let index = 0; index < iterations; index++) {
    if (options.signal?.aborted) break;

    const startedAt = now();
    const trialSignal = createTrialSignal(timeoutMs, options.signal);
    let completion: CompletionResult | undefined;
    let trialError: unknown;
    try {
      completion = await dependencies.client.complete(
        clone(scenario.request),
        scenario.modelId,
        clone(scenario.samplingParams),
        trialSignal.signal,
      );
    } catch (error) {
      trialError = error;
    } finally {
      trialSignal.dispose();
    }

    const trace = makeTrace({
      runId,
      trial: index + 1,
      startedAt,
      durationMs: Math.max(0, now() - startedAt),
      timeoutMs,
      scenario,
      completion,
      error: trialError,
      timedOut: trialSignal.didTimeOut(),
      provenance,
    });
    traces.push(trace);
    await options.artifactSink?.write(clone(trace));
  }

  const result: LabRunResult = {
    runId,
    scenarioId: scenario.id,
    manifest,
    completedAt: new Date(now()).toISOString(),
    traces,
    passCount: traces.filter((trace) => trace.passed).length,
    totalCount: traces.length,
  };
  await options.artifactSink?.finish?.(clone(result));
  return result;
}
