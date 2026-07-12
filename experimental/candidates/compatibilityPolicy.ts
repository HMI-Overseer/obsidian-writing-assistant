import type { LabRunProvenance } from "../lab/types";
import type { SandboxResponseNormalizer } from "../sandbox/types";

export interface ExperimentalCompatibilityPolicy {
  id: string;
  version: number;
  match: {
    modelIds: readonly string[];
    chatTemplates: readonly string[];
  };
  responseNormalizer: SandboxResponseNormalizer;
}

export interface AppliedCompatibilityPolicy {
  evidence: {
    id: string;
    version: number;
    matchedBy: { kind: "model-id" | "chat-template"; value: string };
  };
  responseNormalizer: SandboxResponseNormalizer;
}

export function applyCompatibilityPolicy(
  policy: ExperimentalCompatibilityPolicy,
  provenance: LabRunProvenance,
): AppliedCompatibilityPolicy {
  const chatTemplate = provenance.subject.runtime?.chatTemplate;
  if (typeof chatTemplate === "string" && policy.match.chatTemplates.includes(chatTemplate)) {
    return {
      evidence: {
        id: policy.id,
        version: policy.version,
        matchedBy: { kind: "chat-template", value: chatTemplate },
      },
      responseNormalizer: policy.responseNormalizer,
    };
  }

  const modelId = provenance.subject.modelId;
  if (policy.match.modelIds.includes(modelId)) {
    return {
      evidence: {
        id: policy.id,
        version: policy.version,
        matchedBy: { kind: "model-id", value: modelId },
      },
      responseNormalizer: policy.responseNormalizer,
    };
  }

  throw new Error(
    `Compatibility policy ${JSON.stringify(policy.id)} does not match recorded model or ` +
    "chat-template provenance.",
  );
}
