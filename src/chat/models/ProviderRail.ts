import { setIcon } from "obsidian";
import type { ProviderOption } from "../../shared/types";
import { PROVIDER_DESCRIPTORS, PROVIDER_ICONS } from "../../providers/descriptors";

/**
 * The vertical icon rail shared by the model dropdown ({@link ModelDropdownView})
 * and the profile settings popover: groups of entries separated by dividers,
 * disabled entries grayed out and non-interactive, the active entry shown as a
 * chip. Callers own the rail container element (`lmsa-provider-rail`).
 */
export type RailEntry<K extends string> = {
  key: K;
  icon: string;
  label: string;
  enabled: boolean;
  /** Provider key for brand tinting; omit for neutral entries like favorites. */
  tint?: ProviderOption;
};

/** The standard provider entry; neutral entries (favorites) are built inline. */
export function providerRailEntry(
  provider: ProviderOption,
  enabled: boolean
): RailEntry<ProviderOption> {
  return {
    key: provider,
    icon: PROVIDER_ICONS[provider],
    label: PROVIDER_DESCRIPTORS[provider].label,
    enabled,
    tint: provider,
  };
}

export function renderProviderRail<K extends string>(
  railEl: HTMLElement,
  groups: ReadonlyArray<ReadonlyArray<RailEntry<K>>>,
  activeKey: K,
  onSelect: (key: K) => void
): void {
  railEl.empty();
  let rendered = false;
  for (const group of groups) {
    if (group.length === 0) continue;
    if (rendered) railEl.createDiv({ cls: "lmsa-provider-rail-divider" });
    rendered = true;
    for (const entry of group) {
      const el = railEl.createDiv({ cls: "lmsa-provider-rail-item" });
      if (entry.tint) el.addClass(`lmsa-brand-tint-${entry.tint}`);
      setIcon(el, entry.icon);
      el.setAttr("title", entry.label);
      if (!entry.enabled) {
        el.addClass("is-disabled");
        continue;
      }
      if (entry.key === activeKey) el.addClass("is-active");
      el.addEventListener("click", () => {
        if (entry.key === activeKey) return;
        onSelect(entry.key);
      });
    }
  }
}
