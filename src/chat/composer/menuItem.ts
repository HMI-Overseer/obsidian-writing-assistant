import { setIcon } from "obsidian";

/** One selectable row in a composer footer menu (reasoning level, posture, launcher). */
export type MenuItemSpec = {
  label: string;
  /** Optional leading icon (lucide name). */
  icon?: string;
  /** Renders the accent check mark and the selected text weight. */
  selected: boolean;
  onSelect: () => void;
};

/**
 * Renders one `lmsa-footer-menu-item` row. The reasoning menu, the posture
 * menu, and the overflow menu all render their rows through this helper, so
 * the footer menus stay one visual and behavioral path (menuItem.css holds
 * the shared row styles).
 */
export function renderMenuItem(el: HTMLElement, spec: MenuItemSpec): void {
  const item = el.createDiv({ cls: "lmsa-footer-menu-item" });
  item.toggleClass("is-selected", spec.selected);
  if (spec.icon !== undefined) {
    const iconEl = item.createEl("span", { cls: "lmsa-footer-menu-item-icon" });
    setIcon(iconEl, spec.icon);
  }
  item.createEl("span", { cls: "lmsa-footer-menu-item-label", text: spec.label });
  if (spec.selected) {
    const check = item.createEl("span", { cls: "lmsa-footer-menu-item-check" });
    setIcon(check, "check");
  }
  item.addEventListener("click", spec.onSelect);
}
