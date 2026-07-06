import type { ReasoningLevel } from "./types";

/**
 * Shared vocabulary helpers for {@link ReasoningLevel}. Kept in `shared/` (no
 * obsidian, no provider imports) so UI, request builders, and the Claude Code
 * session layer all read one source per fact.
 */

/** Canonical display order for level menus (weakest to strongest, `on` last). */
export const REASONING_LEVEL_ORDER: readonly ReasoningLevel[] = [
  "off",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "on",
];

/** One label per level so "xhigh" renders as "Extra high" everywhere (sentence case). */
export const REASONING_LEVEL_LABELS: Record<ReasoningLevel, string> = {
  off: "Off",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
  on: "On",
};

/** Shown for the null (no entry stored) state: the model runs on its own default. */
export const REASONING_DEFAULT_LABEL = "Default";

/** Type guard for untrusted level strings (settings blobs, discovery payloads). */
export function isReasoningLevel(value: unknown): value is ReasoningLevel {
  return typeof value === "string" && value in REASONING_LEVEL_LABELS;
}

/**
 * A model's discovered reasoning capability (LM Studio `/api/v1/models`
 * `capabilities.reasoning`): the exact request values the model accepts, plus
 * the server-chosen default used when the param is omitted. Models without
 * reasoning support omit the field entirely, which the plugin represents as an
 * absent capability (empty resolved set, no UI, nothing sent).
 */
export interface ReasoningCapability {
  allowedOptions: ReasoningLevel[];
  default?: ReasoningLevel;
}

/** The Claude effort tiers (Agent SDK `Options.effort` / CLI `--effort`). */
export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;

export type EffortLevel = (typeof EFFORT_LEVELS)[number];

/** Whether a reasoning level is one of the five Claude effort tiers. */
export function isEffortLevel(level: ReasoningLevel | null): level is EffortLevel {
  return level !== null && (EFFORT_LEVELS as readonly string[]).includes(level);
}

/**
 * Effort tiers expressible through the SDK's mid-session flag-settings layer
 * (`applyFlagSettings({ effortLevel })`). `max` is session-start only
 * (`Options.effort`), so a flip to or from it takes the rebuild path.
 */
export type FlagSettableEffort = Exclude<EffortLevel, "max">;

/** Whether a level can be set mid-session via `applyFlagSettings`. */
export function isFlagSettableEffort(
  level: ReasoningLevel | null,
): level is FlagSettableEffort {
  return isEffortLevel(level) && level !== "max";
}
