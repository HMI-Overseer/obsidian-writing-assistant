import { describe, it, expect } from "vitest";
import {
  resolveModelReasoning,
  resolveReasoningLevels,
  supportsReasoning,
  type ReasoningDiscovery,
} from "../../../src/providers/reasoningLevels";
import type { ReasoningCapability } from "../../../src/shared/reasoning";
import type { CompletionModel, ProviderOption } from "../../../src/shared/types";

function model(provider: ProviderOption, modelId = "m1"): CompletionModel {
  return { id: `${provider}:${modelId}`, name: modelId, modelId, provider };
}

function discovery(byModelId: Record<string, ReasoningCapability>): ReasoningDiscovery {
  return { getReasoningCapability: (modelId) => byModelId[modelId] };
}

describe("resolveReasoningLevels", () => {
  it("offers the five effort tiers for Claude Code (no off/on, they don't map to effort)", () => {
    expect(resolveReasoningLevels(model("claudecode"))).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
  });

  it("resolves Anthropic levels per model (xhigh only where the API honors it)", () => {
    // Opus 4.7+ / Sonnet 5 / Fable: full effort range.
    expect(resolveReasoningLevels(model("anthropic", "claude-opus-4-8"))).toEqual([
      "off",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    // 4.6 family: adaptive + max, but xhigh silently downgrades → not offered.
    expect(resolveReasoningLevels(model("anthropic", "claude-opus-4-6"))).toEqual([
      "off",
      "low",
      "medium",
      "high",
      "max",
    ]);
    expect(resolveReasoningLevels(model("anthropic", "claude-sonnet-4-6"))).toEqual([
      "off",
      "low",
      "medium",
      "high",
      "max",
    ]);
    // Non-adaptive / unknown ids: descriptor fallback (payload emits no thinking anyway).
    expect(resolveReasoningLevels(model("anthropic", "claude-haiku-4-5"))).toEqual([
      "off",
      "low",
      "medium",
      "high",
    ]);
    expect(resolveReasoningLevels(model("anthropic"))).toEqual(["off", "low", "medium", "high"]);
  });

  it("keeps the historical off..on vocabulary for OpenAI", () => {
    expect(resolveReasoningLevels(model("openai"))).toEqual(["off", "low", "medium", "high", "on"]);
  });

  // The gemma4 jinja incident (2026-07-06): a model whose discovery payload has
  // no capabilities.reasoning field hard-failed at template render when a
  // reasoning value was forwarded. LM Studio therefore offers NOTHING without a
  // discovered per-model capability, never a guessed vocabulary.
  it("offers nothing for an LM Studio model without a discovered reasoning capability", () => {
    const m = model("lmstudio", "gemma4-26b-a4b");
    expect(resolveReasoningLevels(m)).toEqual([]);
    expect(resolveReasoningLevels(m, discovery({}))).toEqual([]);
    expect(supportsReasoning(m, discovery({}))).toBe(false);
  });

  it("offers exactly the discovered allowed_options for an LM Studio model", () => {
    const m = model("lmstudio", "qwen3.5");
    const d = discovery({ "qwen3.5": { allowedOptions: ["off", "on"], default: "on" } });
    expect(resolveReasoningLevels(m, d)).toEqual(["off", "on"]);
    expect(supportsReasoning(m, d)).toBe(true);
  });

  it("lets a discovered capability win over the descriptor fallback", () => {
    // Hypothetical: discovery narrowing a cloud-style provider would also win;
    // the layering is uniform, not an LM Studio special case.
    const m = model("anthropic");
    const d = discovery({ m1: { allowedOptions: ["low", "high"] } });
    expect(resolveReasoningLevels(m, d)).toEqual(["low", "high"]);
  });
});

describe("resolveModelReasoning", () => {
  it("returns the stored level when the model's resolved set offers it", () => {
    const m = model("claudecode");
    expect(resolveModelReasoning({ [m.id]: "xhigh" }, m)).toBe("xhigh");
  });

  it("returns null when nothing is stored (model default, nothing sent)", () => {
    expect(resolveModelReasoning({}, model("claudecode"))).toBeNull();
  });

  it("clamps a stored level outside the resolved set to null", () => {
    // A level from another provider's vocabulary: "on" is not an effort tier...
    const claude = model("claudecode");
    expect(resolveModelReasoning({ [claude.id]: "on" }, claude)).toBeNull();
    // ...and xhigh is not in Anthropic's phase-1 set.
    const anthropic = model("anthropic");
    expect(resolveModelReasoning({ [anthropic.id]: "xhigh" }, anthropic)).toBeNull();
  });

  it("clamps a stored level for an LM Studio model that reports no reasoning support", () => {
    const m = model("lmstudio", "gemma4-26b-a4b");
    // Even with an explicit (stale) user entry, nothing is sent: forwarding it
    // is what broke the request in the field.
    expect(resolveModelReasoning({ [m.id]: "high" }, m, discovery({}))).toBeNull();
  });

  it("clamps against the discovered set, not the descriptor", () => {
    const m = model("lmstudio", "qwen3.5");
    const d = discovery({ "qwen3.5": { allowedOptions: ["off", "on"], default: "on" } });
    expect(resolveModelReasoning({ [m.id]: "high" }, m, d)).toBeNull();
    expect(resolveModelReasoning({ [m.id]: "on" }, m, d)).toBe("on");
  });

  it("keys entries by the composed model key, not the bare model id", () => {
    const m = model("claudecode", "opus");
    // An entry under the bare id must not leak into a different provider's model.
    expect(resolveModelReasoning({ opus: "high" }, m)).toBeNull();
    expect(resolveModelReasoning({ "claudecode:opus": "high" }, m)).toBe("high");
  });
});
