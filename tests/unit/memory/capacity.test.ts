import { describe, it, expect } from "vitest";
import { computeMemoryCapacity, MEMORY_INDEX_TOKEN_BUDGET } from "../../../src/memory/capacity";
import { CONTEXT_DANGER_THRESHOLD, CONTEXT_WARNING_THRESHOLD } from "../../../src/constants";
import { formatTokens } from "../../../src/shared/tokenEstimation";

describe("formatTokens", () => {
  it("keeps small counts exact and abbreviates larger ones", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(999)).toBe("999");
    expect(formatTokens(1_000)).toBe("1.0k");
    expect(formatTokens(3_000)).toBe("3.0k");
    expect(formatTokens(1_500_000)).toBe("1.5M");
  });
});

describe("computeMemoryCapacity", () => {
  it("defaults to the advisory 3k index budget", () => {
    expect(MEMORY_INDEX_TOKEN_BUDGET).toBe(3000);
    expect(computeMemoryCapacity(300).budget).toBe(MEMORY_INDEX_TOKEN_BUDGET);
  });

  it("reports an empty index as fully free", () => {
    const capacity = computeMemoryCapacity(0);
    expect(capacity.ratio).toBe(0);
    expect(capacity.percent).toBe(0);
    expect(capacity.barPercent).toBe(0);
    expect(capacity.state).toBe("normal");
    expect(capacity.label).toBe("~0 of 3.0k tokens (0%)");
  });

  it("formats the occupancy label with both figures and the percentage", () => {
    expect(computeMemoryCapacity(1_200).label).toBe("~1.2k of 3.0k tokens (40%)");
    expect(computeMemoryCapacity(180).label).toBe("~180 of 3.0k tokens (6%)");
  });

  it("stays normal below the shared warning threshold", () => {
    const belowWarning = Math.floor(MEMORY_INDEX_TOKEN_BUDGET * CONTEXT_WARNING_THRESHOLD) - 1;
    expect(computeMemoryCapacity(belowWarning).state).toBe("normal");
  });

  it("warns at the shared warning threshold", () => {
    const atWarning = Math.ceil(MEMORY_INDEX_TOKEN_BUDGET * CONTEXT_WARNING_THRESHOLD);
    expect(computeMemoryCapacity(atWarning).state).toBe("warning");
    expect(computeMemoryCapacity(MEMORY_INDEX_TOKEN_BUDGET * 0.9).state).toBe("warning");
  });

  it("escalates to danger at the shared danger threshold", () => {
    const atDanger = Math.ceil(MEMORY_INDEX_TOKEN_BUDGET * CONTEXT_DANGER_THRESHOLD);
    expect(computeMemoryCapacity(atDanger).state).toBe("danger");
    expect(computeMemoryCapacity(MEMORY_INDEX_TOKEN_BUDGET).state).toBe("danger");
  });

  it("reports honest overflow while clamping only the bar width", () => {
    const capacity = computeMemoryCapacity(6_000);
    expect(capacity.percent).toBe(200);
    expect(capacity.barPercent).toBe(100);
    expect(capacity.state).toBe("danger");
    expect(capacity.label).toBe("~6.0k of 3.0k tokens (200%)");
  });

  it("accepts an explicit budget for evaluation-driven retuning", () => {
    const capacity = computeMemoryCapacity(500, 1_000);
    expect(capacity.budget).toBe(1_000);
    expect(capacity.percent).toBe(50);
    expect(capacity.state).toBe("normal");
  });
});
