import { describe, test, expect } from "vitest";
import { buildSamplingParams } from "../../../../src/chat/finalization/buildSamplingParams";
import type { ProviderProfile } from "../../../../src/shared/types";
import { makeDefaultProfile } from "../../../../src/constants";

/** Creates a profile with optional overrides. */
function makeProfile(overrides: Partial<ProviderProfile> = {}): ProviderProfile {
  return {
    ...makeDefaultProfile("lmstudio"),
    ...overrides,
  };
}

describe("buildSamplingParams", () => {
  test("maps default profile to SamplingParams with nulls", () => {
    const result = buildSamplingParams(makeProfile());

    expect(result).toEqual({
      temperature: 0.7,
      maxTokens: null,
      topP: null,
      topK: null,
      minP: null,
      repeatPenalty: null,
      reasoning: null,
    });
  });

  test("maps all populated profile fields", () => {
    const result = buildSamplingParams(
      makeProfile({
        temperature: 0.3,
        maxTokens: 2048,
        topP: 0.9,
        topK: 40,
        minP: 0.05,
        repeatPenalty: 1.1,
        reasoning: "high",
      }),
    );

    expect(result).toEqual({
      temperature: 0.3,
      maxTokens: 2048,
      topP: 0.9,
      topK: 40,
      minP: 0.05,
      repeatPenalty: 1.1,
      reasoning: "high",
    });
  });

  test("preserves zero values (not treated as null)", () => {
    const result = buildSamplingParams(
      makeProfile({ temperature: 0, maxTokens: 0 }),
    );

    expect(result.temperature).toBe(0);
    expect(result.maxTokens).toBe(0);
  });

  test("anthropic default profile has maxTokens set", () => {
    const result = buildSamplingParams(makeDefaultProfile("anthropic"));

    expect(result.maxTokens).toBe(2000);
  });
});
