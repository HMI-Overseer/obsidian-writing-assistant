import { describe, it, expect } from "vitest";
import { harvestEffortLevels } from "../../../src/api/sdk/effortHarvest";
import type { ModelInfo } from "../../../src/api/sdk/claudeAgentSdk";

function info(overrides: Partial<ModelInfo> & { value: string }): ModelInfo {
  return {
    displayName: overrides.value,
    description: "",
    ...overrides,
  };
}

const FIVE = ["low", "medium", "high", "xhigh", "max"] as const;

describe("harvestEffortLevels", () => {
  it("keys by picker alias, populated from supportedEffortLevels", () => {
    const result = harvestEffortLevels([
      info({ value: "opus", supportsEffort: true, supportedEffortLevels: [...FIVE] }),
      info({ value: "sonnet", supportsEffort: true, supportedEffortLevels: ["low", "medium", "high"] }),
    ]);
    expect(result).toEqual({
      opus: ["low", "medium", "high", "xhigh", "max"],
      sonnet: ["low", "medium", "high"],
    });
  });

  it("strips [1m] variants and skips the default pseudo-entry (E2 quirks)", () => {
    const result = harvestEffortLevels([
      info({ value: "default", supportsEffort: true, supportedEffortLevels: [...FIVE] }),
      info({ value: "opus[1m]", supportsEffort: true, supportedEffortLevels: [...FIVE] }),
    ]);
    expect(result).toEqual({ opus: ["low", "medium", "high", "xhigh", "max"] });
  });

  it("prefers the bare entry over a [1m] variant regardless of order", () => {
    const variantFirst = harvestEffortLevels([
      info({ value: "opus[1m]", supportsEffort: true, supportedEffortLevels: ["low"] }),
      info({ value: "opus", supportsEffort: true, supportedEffortLevels: [...FIVE] }),
    ]);
    expect(variantFirst.opus).toEqual(["low", "medium", "high", "xhigh", "max"]);

    const bareFirst = harvestEffortLevels([
      info({ value: "opus", supportsEffort: true, supportedEffortLevels: [...FIVE] }),
      info({ value: "opus[1m]", supportsEffort: true, supportedEffortLevels: ["low"] }),
    ]);
    expect(bareFirst.opus).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });

  it("records an empty list for a known no-effort model (hides the pill)", () => {
    expect(harvestEffortLevels([info({ value: "haiku", supportsEffort: false })])).toEqual({
      haiku: [],
    });
  });

  it("skips entries with no effort information (unknown, keep the fallback)", () => {
    expect(harvestEffortLevels([info({ value: "opus" })])).toEqual({});
    expect(
      harvestEffortLevels([info({ value: "opus", supportsEffort: true, supportedEffortLevels: [] })]),
    ).toEqual({});
  });

  it("filters junk level strings (type-level guarantee, defended at runtime)", () => {
    const result = harvestEffortLevels([
      info({
        value: "opus",
        supportsEffort: true,
        supportedEffortLevels: ["high", "ultracode"] as unknown as ModelInfo["supportedEffortLevels"],
      }),
    ]);
    expect(result.opus).toEqual(["high"]);
  });
});
