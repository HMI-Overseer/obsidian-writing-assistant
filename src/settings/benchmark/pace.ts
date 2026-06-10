/**
 * Pace assessment for benchmark runs.
 *
 * Local models that respond slowly are often better served by a smaller
 * model or a lower-bit quantization; these heuristics decide when to say so.
 */

/** Average iteration duration above which a run counts as slow. */
export const SLOW_AVG_ITERATION_MS = 20_000;

/** A single iteration above this duration flags the run immediately. */
export const SLOW_SINGLE_ITERATION_MS = 45_000;

export interface PaceAssessment {
  slow: boolean;
  avgMs: number;
  maxMs: number;
  sampleCount: number;
}

/**
 * Assesses completed iteration durations of a run.
 * The average only triggers after 2+ samples so a single warm-up
 * iteration doesn't cause a false alarm.
 */
export function assessPace(durationsMs: number[]): PaceAssessment {
  if (durationsMs.length === 0) {
    return { slow: false, avgMs: 0, maxMs: 0, sampleCount: 0 };
  }

  const avgMs = durationsMs.reduce((sum, d) => sum + d, 0) / durationsMs.length;
  const maxMs = Math.max(...durationsMs);
  const slow =
    (durationsMs.length >= 2 && avgMs > SLOW_AVG_ITERATION_MS) ||
    maxMs > SLOW_SINGLE_ITERATION_MS;

  return { slow, avgMs, maxMs, sampleCount: durationsMs.length };
}

/** Advice shown alongside pace warnings in the UI and exported reports. */
export const PACE_ADVICE =
  "If this model feels too slow for everyday use, consider a smaller model or a lower-bit quantization.";
