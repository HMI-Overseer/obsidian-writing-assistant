import process from "node:process";
import { parseLabCliArgs } from "./cliArgs";
import { createFileArtifactSink, labRunArtifactDirectory } from "./lab/fileArtifactSink";
import { runLabScenario } from "./lab/runner";
import {
  LMStudioPreflightError,
  preflightLMStudioLabSubject,
  readLMStudioLabConfig,
} from "./local/lmStudio";
import { listScenarioIds, resolveScenario } from "./scenarios/registry";
import { listEpisodeIds, resolveEpisode } from "./episodes/registry";
import { runSandboxEpisodeExperiment } from "./sandbox/episodeRun";
import { createSandboxEpisodeArtifactSink } from "./sandbox/episodeArtifactSink";
import { resolveResponseNormalizer } from "./candidates/registry";
import { applyCompatibilityPolicy } from "./candidates/compatibilityPolicy";
import { resolveCompatibilityPolicy } from "./candidates/compatibilityRegistry";
import {
  compareSandboxEpisodeRuns,
  loadSandboxComparisonInput,
  SANDBOX_COMPARISON_ROLES,
} from "./sandbox/comparison";
import {
  createSandboxComparisonSink,
  sandboxComparisonDirectory,
} from "./sandbox/comparisonArtifacts";
import { listBehaviorMappings } from "./behavior/registry";
import {
  createBehaviorDifferential,
  createBehaviorProfile,
  loadBehaviorRunInput,
} from "./behavior/profile";
import {
  behaviorDifferentialDirectory,
  behaviorProfileDirectory,
  createBehaviorDifferentialSink,
  createBehaviorProfileSink,
  loadBehaviorProfile,
} from "./behavior/artifacts";

const HELP = `Model behavior laboratory

Usage:
  npm run lab:run -- [options]

Options:
  --scenario <id>       Scenario to run (default: basic-instruction)
  --episode <id>        Run a sandbox episode instead of a completion scenario
  --iterations <count>  Repeated trials (default: 1)
  --timeout-ms <ms>     Per-trial timeout (default: 60000)
  --max-rounds <count>  Sandbox episode model rounds (default: 5)
  --max-tool-calls <count>
                        Sandbox tool calls per episode (default: 10)
  --max-repeated-tool-calls <count>
                        Identical sandbox calls per episode (default: 3)
  --max-total-tokens <count>
                        Recorded input plus output tokens per episode (default: 100000)
  --max-output-chars <count>
                        Raw response characters per round (default: 100000)
  --response-normalizer <id>
                        Apply a registered experimental normalizer to an episode
  --compatibility-policy <id>
                        Apply an opt-in policy after matching recorded provenance
  --compare-runs <baseline,direct,policy,canary>
                        Compare four existing append-only episode runs
  --profile-runs <run-id,...>
                        Derive one multidimensional profile from existing runs
  --compare-profiles <left-id,right-id>
                        Derive a paired-scenario differential between profiles
  --list-scenarios      List registered scenarios
  --list-episodes       List registered sandbox episodes
  --list-behavior-mappings
                        List versioned Phase 4 scenario mappings
  --help, -h            Show this help

Required environment:
  LAB_MODEL_ID

Optional environment:
  LAB_LMSTUDIO_URL              Default: http://127.0.0.1:1234/v1
  LAB_LMSTUDIO_BYPASS_CORS      true or false, default: true
  LAB_SOURCE_REVISION
  LAB_MODEL_ARTIFACT
  LAB_MODEL_QUANTIZATION
  LAB_INFERENCE_ENGINE_VERSION
  LAB_CHAT_TEMPLATE
`;

export async function runLabCli(
  argv: string[],
  env: Record<string, string | undefined>,
): Promise<number> {
  let options;
  try {
    options = parseLabCliArgs(argv);
  } catch (error) {
    process.stderr.write(`Configuration error: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }

  if (options.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (options.listScenarios) {
    process.stdout.write(`${listScenarioIds().join("\n")}\n`);
    return 0;
  }
  if (options.listEpisodes) {
    process.stdout.write(`${listEpisodeIds().join("\n")}\n`);
    return 0;
  }
  if (options.listBehaviorMappings) {
    process.stdout.write(`${listBehaviorMappings().map((entry) =>
      `${entry.scenario.id}@${entry.scenario.version}\t${entry.family}`).join("\n")}\n`);
    return 0;
  }

  if (options.comparisonRunIds) {
    try {
      const inputs = await Promise.all(options.comparisonRunIds.map((runId, index) =>
        loadSandboxComparisonInput(SANDBOX_COMPARISON_ROLES[index], runId)));
      const result = await compareSandboxEpisodeRuns(inputs, {
        sink: createSandboxComparisonSink(),
      });
      process.stdout.write(
        `Comparison ${result.manifest.comparisonId}: ${result.passed ? "passed" : "failed"}.\n` +
        `Artifacts: ${sandboxComparisonDirectory(result.manifest.comparisonId)}\n`,
      );
      return result.passed ? 0 : 1;
    } catch (error) {
      process.stderr.write(
        `Comparison failed: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      return 1;
    }
  }

  if (options.profileRunIds) {
    try {
      const inputs = await Promise.all(options.profileRunIds.map(loadBehaviorRunInput));
      const result = await createBehaviorProfile(inputs, { sink: createBehaviorProfileSink() });
      process.stdout.write(
        `Profile ${result.manifest.profileId}: ${result.passed ? "valid" : "invalid"}.\n` +
        `Artifacts: ${behaviorProfileDirectory(result.manifest.profileId)}\n`,
      );
      return result.passed ? 0 : 1;
    } catch (error) {
      process.stderr.write(`Profile failed: ${error instanceof Error ? error.message : String(error)}\n`);
      return 1;
    }
  }

  if (options.differentialProfileIds) {
    try {
      const [left, right] = await Promise.all(
        options.differentialProfileIds.map(loadBehaviorProfile),
      );
      const result = await createBehaviorDifferential(left, right, {
        sink: createBehaviorDifferentialSink(),
      });
      process.stdout.write(
        `Differential ${result.manifest.differentialId}: derived.\n` +
        `Artifacts: ${behaviorDifferentialDirectory(result.manifest.differentialId)}\n`,
      );
      return 0;
    } catch (error) {
      process.stderr.write(
        `Differential failed: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      return 1;
    }
  }

  try {
    const config = readLMStudioLabConfig(env);
    const subject = await preflightLMStudioLabSubject(config);
    if (options.episodeId !== null) {
      const episode = resolveEpisode(options.episodeId, config.modelId);
      const responseNormalizer = options.responseNormalizerId
        ? resolveResponseNormalizer(options.responseNormalizerId)
        : undefined;
      const appliedPolicy = options.compatibilityPolicyId
        ? applyCompatibilityPolicy(
          resolveCompatibilityPolicy(options.compatibilityPolicyId),
          subject.provenance,
        )
        : undefined;
      const result = await runSandboxEpisodeExperiment(subject.dependencies.client, episode, {
        iterations: options.iterations,
        timeoutMs: options.timeoutMs,
        maxRounds: options.maxRounds,
        maxToolCalls: options.maxToolCalls,
        maxRepeatedToolCalls: options.maxRepeatedToolCalls,
        maxTotalTokens: options.maxTotalTokens,
        maxOutputChars: options.maxOutputChars,
        provenance: subject.provenance,
        artifactSink: createSandboxEpisodeArtifactSink(),
        ...(responseNormalizer ? { responseNormalizer } : {}),
        ...(appliedPolicy
          ? {
            responseNormalizer: appliedPolicy.responseNormalizer,
            compatibilityPolicy: appliedPolicy.evidence,
          }
          : {}),
      });
      const artifactDirectory = labRunArtifactDirectory(result.runId);
      process.stdout.write(
        `Episode run ${result.runId}: ${result.summary.passCount}/` +
        `${result.summary.completedCount} episodes passed.\n` +
        `Artifacts: ${artifactDirectory}\n`,
      );
      return result.summary.passCount === result.summary.completedCount ? 0 : 1;
    }

    const scenario = resolveScenario(options.scenarioId, config.modelId);
    const result = await runLabScenario(subject.dependencies, scenario, {
      iterations: options.iterations,
      timeoutMs: options.timeoutMs,
      provenance: subject.provenance,
      artifactSink: createFileArtifactSink(),
    });
    process.stdout.write(
      `Run ${result.runId}: ${result.passCount}/${result.totalCount} trials passed.\n` +
      `Artifacts: ${labRunArtifactDirectory(result.runId)}\n`,
    );
    return result.passCount === result.totalCount ? 0 : 1;
  } catch (error) {
    if (error instanceof LMStudioPreflightError) {
      process.stderr.write(`Preflight failed (${error.kind}): ${error.message}\n`);
      return 3;
    }
    process.stderr.write(`Laboratory run failed: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

const exitCode = await runLabCli(process.argv.slice(2), process.env);
process.exitCode = exitCode;
