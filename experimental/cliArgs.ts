export interface LabCliOptions {
  scenarioId: string;
  episodeId: string | null;
  iterations: number;
  timeoutMs: number;
  maxRounds: number;
  maxToolCalls: number;
  maxRepeatedToolCalls: number;
  maxTotalTokens: number;
  maxOutputChars: number;
  responseNormalizerId: string | null;
  compatibilityPolicyId: string | null;
  comparisonRunIds: string[] | null;
  profileRunIds: string[] | null;
  differentialProfileIds: [string, string] | null;
  help: boolean;
  listScenarios: boolean;
  listEpisodes: boolean;
  listBehaviorMappings: boolean;
}

const DEFAULT_SCENARIO = "basic-instruction";
const DEFAULT_ITERATIONS = 1;
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_ROUNDS = 5;
const DEFAULT_MAX_TOOL_CALLS = 10;
const DEFAULT_MAX_REPEATED_TOOL_CALLS = 3;
const DEFAULT_MAX_TOTAL_TOKENS = 100_000;
const DEFAULT_MAX_OUTPUT_CHARS = 100_000;

function positiveInteger(name: string, raw: string | undefined): number {
  if (!raw) throw new Error(`${name} requires a value.`);
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
}

export function parseLabCliArgs(argv: string[]): LabCliOptions {
  let scenarioSpecified = false;
  let episodeSpecified = false;
  let comparisonSpecified = false;
  let profileSpecified = false;
  let differentialSpecified = false;
  const options: LabCliOptions = {
    scenarioId: DEFAULT_SCENARIO,
    episodeId: null,
    iterations: DEFAULT_ITERATIONS,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    maxRounds: DEFAULT_MAX_ROUNDS,
    maxToolCalls: DEFAULT_MAX_TOOL_CALLS,
    maxRepeatedToolCalls: DEFAULT_MAX_REPEATED_TOOL_CALLS,
    maxTotalTokens: DEFAULT_MAX_TOTAL_TOKENS,
    maxOutputChars: DEFAULT_MAX_OUTPUT_CHARS,
    responseNormalizerId: null,
    compatibilityPolicyId: null,
    comparisonRunIds: null,
    profileRunIds: null,
    differentialProfileIds: null,
    help: false,
    listScenarios: false,
    listEpisodes: false,
    listBehaviorMappings: false,
  };

  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    switch (argument) {
      case "--scenario":
        if (!argv[index + 1]) throw new Error("--scenario requires a value.");
        if (episodeSpecified) {
          throw new Error("--scenario and --episode cannot be used together.");
        }
        if (comparisonSpecified || profileSpecified || differentialSpecified) {
          throw new Error("--scenario cannot be combined with a derived-artifact command.");
        }
        options.scenarioId = argv[++index];
        scenarioSpecified = true;
        break;
      case "--episode":
        if (!argv[index + 1]) throw new Error("--episode requires a value.");
        if (scenarioSpecified) {
          throw new Error("--scenario and --episode cannot be used together.");
        }
        if (comparisonSpecified || profileSpecified || differentialSpecified) {
          throw new Error("--episode cannot be combined with a derived-artifact command.");
        }
        options.episodeId = argv[++index];
        episodeSpecified = true;
        break;
      case "--iterations":
        options.iterations = positiveInteger("--iterations", argv[++index]);
        break;
      case "--timeout-ms":
        options.timeoutMs = positiveInteger("--timeout-ms", argv[++index]);
        break;
      case "--max-rounds":
        options.maxRounds = positiveInteger("--max-rounds", argv[++index]);
        break;
      case "--max-tool-calls":
        options.maxToolCalls = positiveInteger("--max-tool-calls", argv[++index]);
        break;
      case "--max-repeated-tool-calls":
        options.maxRepeatedToolCalls = positiveInteger("--max-repeated-tool-calls", argv[++index]);
        break;
      case "--max-total-tokens":
        options.maxTotalTokens = positiveInteger("--max-total-tokens", argv[++index]);
        break;
      case "--max-output-chars":
        options.maxOutputChars = positiveInteger("--max-output-chars", argv[++index]);
        break;
      case "--response-normalizer":
        if (!argv[index + 1]) throw new Error("--response-normalizer requires a value.");
        if (options.compatibilityPolicyId !== null) {
          throw new Error("--response-normalizer and --compatibility-policy cannot be used together.");
        }
        options.responseNormalizerId = argv[++index];
        break;
      case "--compatibility-policy":
        if (!argv[index + 1]) throw new Error("--compatibility-policy requires a value.");
        if (options.responseNormalizerId !== null) {
          throw new Error("--response-normalizer and --compatibility-policy cannot be used together.");
        }
        options.compatibilityPolicyId = argv[++index];
        break;
      case "--compare-runs": {
        const raw = argv[index + 1];
        if (!raw) throw new Error("--compare-runs requires a value.");
        if (scenarioSpecified || episodeSpecified || profileSpecified || differentialSpecified) {
          throw new Error("--compare-runs cannot be combined with --scenario or --episode.");
        }
        const runIds = raw.split(",").map((entry) => entry.trim()).filter(Boolean);
        if (runIds.length !== 4) {
          throw new Error("--compare-runs requires four comma-separated run IDs.");
        }
        options.comparisonRunIds = runIds;
        comparisonSpecified = true;
        index++;
        break;
      }
      case "--profile-runs": {
        const raw = argv[index + 1];
        if (!raw) throw new Error("--profile-runs requires a value.");
        if (scenarioSpecified || episodeSpecified || comparisonSpecified || differentialSpecified) {
          throw new Error("--profile-runs cannot be combined with another run command.");
        }
        const runIds = raw.split(",").map((entry) => entry.trim()).filter(Boolean);
        if (runIds.length === 0) throw new Error("--profile-runs requires at least one run ID.");
        options.profileRunIds = runIds;
        profileSpecified = true;
        index++;
        break;
      }
      case "--compare-profiles": {
        const raw = argv[index + 1];
        if (!raw) throw new Error("--compare-profiles requires a value.");
        if (scenarioSpecified || episodeSpecified || comparisonSpecified || profileSpecified) {
          throw new Error("--compare-profiles cannot be combined with another run command.");
        }
        const profileIds = raw.split(",").map((entry) => entry.trim()).filter(Boolean);
        if (profileIds.length !== 2) {
          throw new Error("--compare-profiles requires two comma-separated profile IDs.");
        }
        options.differentialProfileIds = [profileIds[0], profileIds[1]];
        differentialSpecified = true;
        index++;
        break;
      }
      case "--list-scenarios":
        options.listScenarios = true;
        break;
      case "--list-episodes":
        options.listEpisodes = true;
        break;
      case "--list-behavior-mappings":
        options.listBehaviorMappings = true;
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      default:
        throw new Error(`Unknown laboratory argument ${JSON.stringify(argument)}.`);
    }
  }

  return options;
}
