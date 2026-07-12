import { describe, expect, it } from "vitest";
import { parseLabCliArgs } from "../../../experimental/cliArgs";
import { listScenarioIds, resolveScenario } from "../../../experimental/scenarios/registry";

describe("parseLabCliArgs", () => {
  it("uses safe control-run defaults", () => {
    expect(parseLabCliArgs([])).toEqual({
      scenarioId: "basic-instruction",
      episodeId: null,
      iterations: 1,
      timeoutMs: 60_000,
      maxRounds: 5,
      maxToolCalls: 10,
      maxRepeatedToolCalls: 3,
      maxTotalTokens: 100_000,
      maxOutputChars: 100_000,
      responseNormalizerId: null,
      compatibilityPolicyId: null,
      comparisonRunIds: null,
      profileRunIds: null,
      differentialProfileIds: null,
      help: false,
      listScenarios: false,
      listEpisodes: false,
      listBehaviorMappings: false,
    });
  });

  it("selects a sandbox episode", () => {
    expect(parseLabCliArgs([
      "--episode", "read-mara", "--max-rounds", "4", "--max-tool-calls", "6",
    ])).toMatchObject({
      episodeId: "read-mara",
      maxRounds: 4,
      maxToolCalls: 6,
    });
    expect(() => parseLabCliArgs([
      "--scenario", "basic-instruction", "--episode", "read-mara",
    ])).toThrow("cannot be used together");
  });

  it("parses explicit bounded run options", () => {
    expect(parseLabCliArgs([
      "--scenario", "basic-instruction",
      "--iterations", "3",
      "--timeout-ms", "5000",
    ])).toMatchObject({
      scenarioId: "basic-instruction",
      iterations: 3,
      timeoutMs: 5_000,
    });
  });

  it("selects an experimental response normalizer", () => {
    expect(parseLabCliArgs([
      "--episode", "read-mara-explicit-path",
      "--response-normalizer", "tool-result-control-token-prefix-v1",
    ])).toMatchObject({
      episodeId: "read-mara-explicit-path",
      responseNormalizerId: "tool-result-control-token-prefix-v1",
    });
  });

  it("selects one opt-in compatibility policy", () => {
    expect(parseLabCliArgs([
      "--episode", "read-mara-explicit-path",
      "--compatibility-policy", "gemma4-tool-result-control-token-prefix-v1",
    ])).toMatchObject({
      compatibilityPolicyId: "gemma4-tool-result-control-token-prefix-v1",
      responseNormalizerId: null,
    });
    expect(() => parseLabCliArgs([
      "--response-normalizer", "tool-result-control-token-prefix-v1",
      "--compatibility-policy", "gemma4-tool-result-control-token-prefix-v1",
    ])).toThrow("cannot be used together");
  });

  it("rejects unknown arguments and invalid bounds", () => {
    expect(() => parseLabCliArgs(["--unknown"])).toThrow("Unknown laboratory argument");
    expect(() => parseLabCliArgs(["--iterations", "0"])).toThrow("positive integer");
  });

  it("selects exactly four frozen comparison runs", () => {
    expect(parseLabCliArgs([
      "--compare-runs", "baseline,direct,policy,canary",
    ])).toMatchObject({ comparisonRunIds: ["baseline", "direct", "policy", "canary"] });
    expect(() => parseLabCliArgs(["--compare-runs", "one,two"])).toThrow(
      "four comma-separated",
    );
    expect(() => parseLabCliArgs([
      "--episode", "read-mara", "--compare-runs", "a,b,c,d",
    ])).toThrow("cannot be combined");
  });

  it("selects profile and differential derived-artifact modes", () => {
    expect(parseLabCliArgs(["--profile-runs", "run-a,run-b"])).toMatchObject({
      profileRunIds: ["run-a", "run-b"],
    });
    expect(parseLabCliArgs(["--compare-profiles", "profile-a,profile-b"])).toMatchObject({
      differentialProfileIds: ["profile-a", "profile-b"],
    });
    expect(() => parseLabCliArgs([
      "--scenario", "basic-instruction", "--profile-runs", "run-a",
    ])).toThrow("cannot be combined");
  });
});

describe("scenario registry", () => {
  it("resolves only registered scenarios with the selected model", () => {
    expect(listScenarioIds()).toEqual([
      "accessibility-rewrite",
      "basic-instruction",
      "conversation-memory",
      "structured-output",
      "voice-preservation",
    ]);
    expect(resolveScenario("basic-instruction", "selected-model").modelId).toBe("selected-model");
    expect(() => resolveScenario("unknown", "selected-model")).toThrow("Unknown laboratory scenario");
  });
});
