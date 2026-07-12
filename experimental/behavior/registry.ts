import type { BehaviorDimension, BehaviorMapping } from "./types";
import { BEHAVIOR_MAPPING_SCHEMA_VERSION } from "./types";

const COMMON_CHECK_DIMENSIONS: Record<string, BehaviorDimension[]> = {
  "completion-succeeded": ["protocol-reliability"],
  "episode-completed": ["protocol-reliability", "efficiency"],
  "read-only-state-unchanged": ["safety-scope"],
  "state-transitions-replay": ["safety-scope", "state-awareness"],
};

const mapping = (
  scenarioId: string,
  version: number,
  family: BehaviorMapping["family"],
  checks: Record<string, BehaviorDimension[]>,
  metamorphicGroup?: BehaviorMapping["metamorphicGroup"],
): BehaviorMapping => ({
  schemaVersion: BEHAVIOR_MAPPING_SCHEMA_VERSION,
  scenario: { id: scenarioId, version },
  family,
  checks,
  ...(metamorphicGroup ? { metamorphicGroup } : {}),
});

const GROUNDED_READ_GROUP = {
  id: "grounded-read-path-and-noun-substitution",
  transformation: "Rename the target path, subject, carried object, and relationship.",
};

const MAPPINGS: BehaviorMapping[] = [
  mapping("basic-instruction", 1, "control", {
    "contains-sentinel": ["correctness", "protocol-reliability"],
  }),
  mapping("structured-output", 1, "protocol", {
    "valid-exact-json": ["correctness", "protocol-reliability"],
  }),
  mapping("conversation-memory", 1, "state-memory", {
    "exact-memory-recall": ["correctness", "state-awareness"],
  }),
  mapping("voice-preservation", 1, "writing", {
    "voice-constraints-preserved": ["correctness", "voice-preservation"],
  }),
  mapping("voice-preservation", 2, "writing", {
    "voice-constraints-preserved": ["correctness", "voice-preservation"],
  }),
  mapping("accessibility-rewrite", 1, "writing", {
    "plain-language-constraints": ["correctness", "writing-quality"],
  }),
  mapping("tool-surface-no-call", 1, "protocol", {
    "no-tool-call": ["safety-scope", "protocol-reliability"],
    "exact-sentinel": ["correctness"],
    "no-control-token-leak": ["protocol-reliability"],
  }),
  mapping("read-mara", 2, "agentic", {
    "read-target-note": ["protocol-reliability"],
    "grounded-answer": ["correctness", "state-awareness"],
    "no-control-token-leak": ["protocol-reliability"],
    "target-path-first-attempt": ["efficiency"],
  }),
  mapping("read-mara-explicit-path", 1, "agentic", {
    "read-target-note": ["protocol-reliability"],
    "grounded-answer": ["correctness", "state-awareness"],
    "no-control-token-leak": ["protocol-reliability"],
    "target-path-first-attempt": ["efficiency"],
  }, GROUNDED_READ_GROUP),
  mapping("read-mara-recovery", 1, "agentic", {
    "read-target-note": ["protocol-reliability"],
    "grounded-answer": ["correctness", "state-awareness"],
    "no-control-token-leak": ["protocol-reliability"],
    "target-path-first-attempt": ["efficiency"],
    "recovered-after-not-found": ["recovery", "state-awareness"],
  }),
  mapping("read-metamorphic-variant", 1, "agentic", {
    "read-variant-target": ["protocol-reliability"],
    "grounded-variant-answer": ["correctness", "state-awareness"],
    "no-control-token-leak": ["protocol-reliability"],
  }, GROUNDED_READ_GROUP),
  mapping("read-clean-canary", 1, "protocol", {
    "read-canary-note": ["protocol-reliability"],
    "exact-clean-sentinel": ["correctness"],
    "normalizer-preserved-clean-text": ["robustness"],
  }),
  mapping("reviewed-write", 1, "agentic", {
    "lighthouse-final-content": ["correctness", "state-awareness"],
    "read-before-reviewed-write": ["protocol-reliability", "state-awareness"],
    "reviewed-write-applied": ["safety-scope", "state-awareness"],
  }),
  mapping("reviewed-write", 2, "agentic", {
    "lighthouse-final-content": ["correctness", "state-awareness"],
    "read-before-reviewed-write": ["protocol-reliability", "state-awareness"],
    "reviewed-write-applied": ["safety-scope", "state-awareness"],
    "no-control-token-leak": ["protocol-reliability"],
  }),
];

const BY_KEY = new Map(MAPPINGS.map((entry) => [
  `${entry.scenario.id}@${entry.scenario.version}`,
  entry,
]));

export function listBehaviorMappings(): BehaviorMapping[] {
  return structuredClone(MAPPINGS);
}

export function resolveBehaviorMapping(scenarioId: string, version: number): BehaviorMapping {
  const result = BY_KEY.get(`${scenarioId}@${version}`);
  if (!result) {
    throw new Error(`No behavior mapping for ${JSON.stringify(`${scenarioId}@${version}`)}.`);
  }
  return structuredClone(result);
}

export function resolveBehaviorCheckDimensions(
  scenarioId: string,
  version: number,
  checkId: string,
): BehaviorDimension[] {
  const mapping = resolveBehaviorMapping(scenarioId, version);
  return structuredClone(mapping.checks[checkId] ?? COMMON_CHECK_DIMENSIONS[checkId] ?? []);
}
