import type { ReasoningLevel } from "../../shared/types";
import { isEffortLevel } from "../../shared/reasoning";
import type { ModelInfo } from "./claudeAgentSdk";

/**
 * Normalizes a Claude Code handshake model list (`Query.supportedModels()` /
 * `initializationResult().models`) into per-model effort-level lists, the
 * §3.1 layer-2 harvest of the effort-selector design. After one session the
 * offered levels are the harness's own report, never our belief, and it
 * self-heals across model renames (a renamed model is just a new entry).
 *
 * E2-verified quirks handled here (2026-07-06): the reported `value` strings
 * are picker ALIASES, not full model ids, so keys are normalized to match the
 * plugin's claudecode catalog ids — `[1m]` context-variant suffixes are
 * stripped, the `default` pseudo-entry is skipped, and when both `opus` and
 * `opus[1m]` appear the bare entry wins. `supportsEffort: false` records an
 * empty list (a known no-effort model hides the pill); an entry with no
 * effort fields at all is skipped as unknown rather than recorded as empty.
 */
export function harvestEffortLevels(models: ModelInfo[]): Record<string, ReasoningLevel[]> {
  const result: Record<string, ReasoningLevel[]> = {};
  const fromBare = new Set<string>();

  for (const model of models) {
    const key = model.value.replace(/\[1m\]$/, "");
    if (!key || key === "default") continue;
    const isBare = model.value === key;
    // A bare entry is authoritative for its key; a [1m] variant only fills in
    // when no bare sibling has (or will have) spoken.
    if (!isBare && fromBare.has(key)) continue;

    if (model.supportsEffort === false) {
      if (isBare || result[key] === undefined) result[key] = [];
      if (isBare) fromBare.add(key);
      continue;
    }

    const levels = (model.supportedEffortLevels ?? []).filter(isEffortLevel);
    if (levels.length === 0) continue;
    if (isBare || result[key] === undefined) result[key] = levels;
    if (isBare) fromBare.add(key);
  }

  return result;
}
