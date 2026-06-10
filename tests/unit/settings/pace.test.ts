import { describe, it, expect } from "vitest";
import {
  assessPace,
  SLOW_AVG_ITERATION_MS,
  SLOW_SINGLE_ITERATION_MS,
} from "../../../src/settings/benchmark/pace";

describe("assessPace", () => {
  it("is not slow with no samples", () => {
    expect(assessPace([]).slow).toBe(false);
  });

  it("is not slow for fast iterations", () => {
    const pace = assessPace([2_000, 3_000, 2_500]);
    expect(pace.slow).toBe(false);
    expect(pace.avgMs).toBe(2_500);
  });

  it("does not flag a single slow-ish warm-up iteration", () => {
    // One sample above the average threshold but below the single-iteration cap.
    expect(assessPace([SLOW_AVG_ITERATION_MS + 5_000]).slow).toBe(false);
  });

  it("flags a slow average after two samples", () => {
    const pace = assessPace([22_000, 26_000]);
    expect(pace.slow).toBe(true);
    expect(pace.avgMs).toBe(24_000);
  });

  it("flags immediately when a single iteration exceeds the hard cap", () => {
    expect(assessPace([SLOW_SINGLE_ITERATION_MS + 1]).slow).toBe(true);
  });

  it("does not flag a fast average", () => {
    expect(assessPace([5_000, 6_000, 7_000]).slow).toBe(false);
  });
});
