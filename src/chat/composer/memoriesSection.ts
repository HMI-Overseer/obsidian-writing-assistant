/**
 * The memories section of the composer knowledge popover: its snapshot shape, its
 * status wording, and the two callbacks {@link ChatView} supplies. Kept beside the
 * popover but free of DOM so the status wording and the toggle's
 * persist-then-invalidate order are directly testable.
 *
 * The composer knowledge indicator dot stays a two-source signal (retrieval and
 * graph). Memories are visible through this section's own toggle and status line,
 * never through the dot (plan decision 11).
 */

import type { PluginSettings } from "../../shared/types";
import type { MemoryService } from "../../memory/MemoryService";
import { commitMemoryFeatureToggle } from "../../memory/settingsEdits";
import { formatTokens } from "../../shared/tokenEstimation";

export type MemoriesSnapshot = {
  /** The master feature switch. */
  enabled: boolean;
  enabledCount: number;
  totalCount: number;
  /** Estimated tokens the rendered index would cost. */
  indexTokens: number;
};

/**
 * The status line under the section toggle. The token figure appears only while
 * the feature is on: with it off no index is delivered, so quoting a cost would
 * describe tokens nobody is spending.
 */
export function formatMemoriesStatus(snap: MemoriesSnapshot): string {
  if (snap.totalCount === 0) return "No memories yet";
  const counts = `${snap.enabledCount} enabled of ${snap.totalCount}`;
  return snap.enabled ? `${counts}, ~${formatTokens(snap.indexTokens)} tokens` : `Off, ${counts}`;
}

/** The section's live elements, structurally typed so a test needs no DOM. */
export interface MemoriesSectionRefs {
  toggle: { setValue: (on: boolean) => unknown };
  statusEl: { textContent: string | null };
}

export function syncMemoriesSection(refs: MemoriesSectionRefs, snap: MemoriesSnapshot): void {
  refs.toggle.setValue(snap.enabled);
  refs.statusEl.textContent = formatMemoriesStatus(snap);
}

export interface MemoriesSectionDeps {
  getSettings: () => Pick<PluginSettings, "memoriesEnabled" | "memories">;
  saveSettings: () => Promise<void>;
  getMemoryService: () => Pick<MemoryService, "invalidateAll" | "estimateIndexTokens">;
}

export interface MemoriesSectionCallbacks {
  getMemoriesSnapshot: () => MemoriesSnapshot;
  onMemoriesToggle: (enabled: boolean) => Promise<void>;
}

/**
 * Build the popover's memory callbacks over live settings. The snapshot reads the
 * store on every call, so a change made in the Memories tab shows up the next
 * time the popover opens or refreshes.
 */
export function createMemoriesSectionCallbacks(
  deps: MemoriesSectionDeps,
): MemoriesSectionCallbacks {
  return {
    getMemoriesSnapshot: () => {
      const settings = deps.getSettings();
      return {
        enabled: settings.memoriesEnabled,
        enabledCount: settings.memories.filter((record) => record.enabled).length,
        totalCount: settings.memories.length,
        indexTokens: deps.getMemoryService().estimateIndexTokens(),
      };
    },
    onMemoriesToggle: (enabled) => {
      const settings = deps.getSettings();
      return commitMemoryFeatureToggle(
        {
          getEnabled: () => settings.memoriesEnabled,
          setEnabled: (value) => {
            settings.memoriesEnabled = value;
          },
          save: deps.saveSettings,
          invalidateAll: () => deps.getMemoryService().invalidateAll(),
        },
        enabled,
      );
    },
  };
}
