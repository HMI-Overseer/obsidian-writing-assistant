import type { CanonicalToolDefinition } from "../types";
import type { VaultOpPolicy, Gate } from "../../vault-ops/gateway";
import type { ApprovalPosture } from "../../shared/types";

export const RECALL_MEMORY_TOOL: CanonicalToolDefinition = {
  name: "recall_memory",
  description:
    "Recall the full current records for up to 16 named standing memories. " +
    "Returns each name independently as a hit, not_found, disabled, or oversized result.",
  strategyHint:
    "recall context bodies when their index descriptions are relevant, and recall rules when their " +
    "exact wording needs to return to recent context.",
  errorGuidance:
    "not_found means the name is absent, check the standing-memory index before retrying. " +
    "disabled means the user must enable that memory. oversized means retry with a smaller batch. " +
    "A batch may contain at most 16 names.",
  annotations: { readOnlyHint: true },
  parameters: {
    type: "object",
    properties: {
      names: {
        type: "array",
        items: { type: "string" },
        description:
          "One to 16 canonical kebab-case memory names from the standing-memory index.",
      },
    },
    required: ["names"],
  },
};

export const ADD_MEMORY_TOOL: CanonicalToolDefinition = {
  name: "add_memory",
  description:
    "Propose a new persistent standing memory for explicit review. " +
    "A rule puts its complete constraint in description. A context record puts a routing teaser in " +
    "description and its detailed substance in content.",
  strategyHint:
    "propose a durable user preference or project fact only when it will help future sessions. " +
    "For a refinement, add the replacement before proposing forget_memory for the old record.",
  errorGuidance:
    "name_invalid requires canonical lowercase kebab-case up to 64 characters. " +
    "name_exists requires a different name, add_memory never overwrites. " +
    "description_empty and description_multiline require one non-empty line. " +
    "description_too_long requires at most 200 Unicode code points. " +
    "content_too_long requires at most 4000 Unicode code points.",
  parameters: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "Unique canonical lowercase kebab-case name, up to 64 characters.",
      },
      type: {
        type: "string",
        enum: ["rule", "context"],
        description:
          "rule for an always-governing constraint, context for detailed information recalled on demand.",
      },
      description: {
        type: "string",
        description:
          "One non-empty line, up to 200 Unicode code points. For context, say what it contains and when to recall it.",
      },
      content: {
        type: "string",
        description:
          "Optional detailed body, up to 4000 Unicode code points. Rules often need no body.",
      },
      explanation: {
        type: "string",
        description: "Optional reason this memory will help future sessions.",
      },
    },
    required: ["name", "type", "description"],
  },
};

export const FORGET_MEMORY_TOOL: CanonicalToolDefinition = {
  name: "forget_memory",
  description:
    "Propose permanently removing one named standing memory for explicit review. " +
    "Use only for a genuine retraction, not as the first half of an unsafe replacement.",
  strategyHint:
    "retract a memory that no longer applies. When refining one, add the replacement before forgetting the old record.",
  errorGuidance:
    "name_invalid requires the canonical kebab-case name. not_found means the record no longer exists, " +
    "check the standing-memory index or call recall_memory with the intended name.",
  annotations: { destructiveHint: true },
  parameters: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "Canonical kebab-case name of the memory to remove.",
      },
      explanation: {
        type: "string",
        description: "Optional reason the memory no longer applies.",
      },
    },
    required: ["name"],
  },
};

export const ALL_MEMORY_TOOLS: CanonicalToolDefinition[] = [
  RECALL_MEMORY_TOOL,
  ADD_MEMORY_TOOL,
  FORGET_MEMORY_TOOL,
];

export const MEMORY_TOOL_NAMES: ReadonlySet<string> = new Set(
  ALL_MEMORY_TOOLS.map((tool) => tool.name),
);

export const MEMORY_MUTATION_TOOL_NAMES: ReadonlySet<string> = new Set([
  ADD_MEMORY_TOOL.name,
  FORGET_MEMORY_TOOL.name,
]);

/**
 * Memory mutations gate like any other class: the session posture wins first, then
 * the per-class policy, exactly as {@link resolveGate} and {@link resolveEditGate}
 * do. `scopes` and `maxAutoOps` have nothing to bite on here, a memory mutation has
 * no path to confine and spends no vault write budget, so this resolver is short
 * rather than special.
 */
export function resolveMemoryGate(policy: VaultOpPolicy, posture: ApprovalPosture): Gate {
  if (posture === "auto") return "auto";
  return policy.memory;
}

/**
 * Recall is a read and is never gated. `deny` removes both mutation tools, unless
 * the `auto` posture overrules the per-class policy and re-offers them, which is
 * what {@link resolveWriteTools} already does for every write class.
 */
export function allowedMemoryTools(
  policy: VaultOpPolicy,
  posture: ApprovalPosture,
): CanonicalToolDefinition[] {
  if (posture === "auto") return ALL_MEMORY_TOOLS;
  return policy.memory === "deny" ? [RECALL_MEMORY_TOOL] : ALL_MEMORY_TOOLS;
}
