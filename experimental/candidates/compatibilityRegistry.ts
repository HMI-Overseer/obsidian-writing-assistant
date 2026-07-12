import type { ExperimentalCompatibilityPolicy } from "./compatibilityPolicy";
import { TOOL_RESULT_CONTROL_TOKEN_PREFIX_NORMALIZER } from "./toolResultControlTokenPrefix";

const GEMMA4_MODEL_ID = "gemma4-26b-a4b-uncensored-hauhaucs-balanced";

const POLICIES: Readonly<Record<string, ExperimentalCompatibilityPolicy>> = {
  "gemma4-tool-result-control-token-prefix-v1": {
    id: "gemma4-tool-result-control-token-prefix",
    version: 1,
    match: {
      modelIds: [GEMMA4_MODEL_ID],
      chatTemplates: [],
    },
    responseNormalizer: TOOL_RESULT_CONTROL_TOKEN_PREFIX_NORMALIZER,
  },
};

export function listCompatibilityPolicyIds(): string[] {
  return Object.keys(POLICIES).sort();
}

export function resolveCompatibilityPolicy(id: string): ExperimentalCompatibilityPolicy {
  const policy = POLICIES[id];
  if (!policy) {
    throw new Error(
      `Unknown compatibility policy ${JSON.stringify(id)}. Available policies: ` +
      `${listCompatibilityPolicyIds().join(", ")}.`,
    );
  }
  return policy;
}
