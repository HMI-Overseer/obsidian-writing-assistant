import { describe, expect, it } from "vitest";
import {
  applyCompatibilityPolicy,
  type ExperimentalCompatibilityPolicy,
} from "../../../experimental/candidates/compatibilityPolicy";
import { resolveCompatibilityPolicy } from "../../../experimental/candidates/compatibilityRegistry";
import { TOOL_RESULT_CONTROL_TOKEN_PREFIX_NORMALIZER } from "../../../experimental/candidates/toolResultControlTokenPrefix";
import type { LabRunProvenance } from "../../../experimental/lab/types";

const MODEL_ID = "gemma4-26b-a4b-uncensored-hauhaucs-balanced";

function provenance(modelId: string, chatTemplate?: string): LabRunProvenance {
  return {
    sourceRevision: "test",
    subject: {
      provider: "lmstudio",
      modelId,
      ...(chatTemplate ? { runtime: { chatTemplate } } : {}),
    },
  };
}

describe("experimental compatibility policy", () => {
  it("applies the registered policy only to the exact recorded model ID", () => {
    const applied = applyCompatibilityPolicy(
      resolveCompatibilityPolicy("gemma4-tool-result-control-token-prefix-v1"),
      provenance(MODEL_ID),
    );

    expect(applied.responseNormalizer).toBe(TOOL_RESULT_CONTROL_TOKEN_PREFIX_NORMALIZER);
    expect(applied.evidence).toEqual({
      id: "gemma4-tool-result-control-token-prefix",
      version: 1,
      matchedBy: { kind: "model-id", value: MODEL_ID },
    });
  });

  it("refuses an unrecorded model identity", () => {
    expect(() => applyCompatibilityPolicy(
      resolveCompatibilityPolicy("gemma4-tool-result-control-token-prefix-v1"),
      provenance("different-model"),
    )).toThrow("does not match recorded model or chat-template provenance");
  });

  it("supports an exact recorded chat-template identity", () => {
    const policy: ExperimentalCompatibilityPolicy = {
      id: "template-test",
      version: 1,
      match: { modelIds: [], chatTemplates: ["confirmed-template"] },
      responseNormalizer: TOOL_RESULT_CONTROL_TOKEN_PREFIX_NORMALIZER,
    };

    expect(applyCompatibilityPolicy(
      policy,
      provenance("unlisted-model", "confirmed-template"),
    ).evidence.matchedBy).toEqual({ kind: "chat-template", value: "confirmed-template" });
    expect(() => applyCompatibilityPolicy(
      policy,
      provenance("unlisted-model", "near-match-template"),
    )).toThrow("does not match");
  });
});
