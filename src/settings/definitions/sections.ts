import type { SettingDefinitionGroup, SettingDefinitionRender } from "obsidian";
import { setIcon } from "obsidian";
import { SettingItem } from "../ui";

/**
 * One section card, the same anatomy `createSettingsSection` builds imperatively.
 *
 * `name` and `desc` are the card's own search entry as well as its heading and lead paragraph.
 */
export interface SettingsSection {
  name: string;
  desc: string;
  /** Lucide icon drawn in the card's badge. */
  icon: string;
  /**
   * Extra classes for this card alone, on top of the four every card carries. For a card with its
   * own skin, the way `createSettingsSection` callers used to reach for `sectionEl.addClass`.
   */
  cls?: string;
  rows: SettingDefinitionRender[];
  /**
   * Hides the whole card, heading and rows alike, and drops its rows from settings search while it
   * is hidden. Re-evaluated on every render and by `refreshDomState()`, which toggles the card in
   * place rather than rebuilding it.
   */
  visible?: boolean | (() => boolean);
}

/**
 * A row that draws its own block DOM.
 *
 * Obsidian builds the `.setting-item` host and seeds its own name and description into it before
 * calling `render`, so a row that owns its markup clears the host first. `name` and `desc` stay on
 * the definition, which is what settings search indexes.
 */
export function blockRow(
  name: string,
  desc: string,
  cls: string,
  build: (el: HTMLElement) => void | (() => void)
): SettingDefinitionRender {
  return {
    name,
    desc,
    render: (setting) => {
      setting.settingEl.empty();
      setting.settingEl.addClasses(cls.split(" "));
      return build(setting.settingEl);
    },
  };
}

/**
 * A name / description / control row, drawn as the {@link SettingItem} every other tab draws.
 *
 * `build` may return a cleanup, which Obsidian runs before the row is torn down or re-rendered.
 * A row that only wires an `onChange` returns nothing; a row that mounts something owning a
 * document listener or a service subscription returns the teardown for it.
 */
export function settingRow(
  name: string,
  desc: string,
  build: (item: SettingItem) => void | (() => void)
): SettingDefinitionRender {
  return {
    name,
    desc,
    render: (setting) =>
      build(new SettingItem(setting.settingEl, { adopt: true }).setName(name).setDesc(desc)),
  };
}

/**
 * The card headline is always a row, where the lead paragraph used to be optional. A card with no
 * description therefore draws its title alone, and the row under it draws no divider: the paragraph
 * is what stood between them on an imperative page.
 */
function headCls(desc: string): string {
  return desc ? "lmsa-settings-section-head" : "lmsa-settings-section-head is-title-only";
}

/**
 * Builds one group per section card, for a page that renders its own `items` rather than handing a
 * subtree to an imperative renderer.
 *
 * `cls` is the only styling hook a definition carries, and a converted page renders into a settings
 * page element the API gives us no access to, so the group is the outermost element we own: it
 * carries the card class, the design tokens, and the tab's accent all three.
 */
export function settingsSections(
  slug: string,
  sections: SettingsSection[]
): SettingDefinitionGroup[] {
  return sections.map((section) => ({
    type: "group",
    cls: `lmsa-ui-card lmsa-settings-section lmsa-settings-root lmsa-tab-${slug}${
      section.cls ? ` ${section.cls}` : ""
    }`,
    visible: section.visible,
    items: [
      blockRow(section.name, section.desc, headCls(section.desc), (el) => {
        const headerEl = el.createDiv({ cls: "lmsa-settings-section-header" });
        const headingEl = headerEl.createDiv({ cls: "lmsa-settings-section-heading" });
        setIcon(headingEl.createDiv({ cls: "lmsa-settings-section-icon" }), section.icon);
        headingEl.createEl("h3", { cls: "lmsa-settings-section-title", text: section.name });
        headerEl.createDiv({ cls: "lmsa-settings-section-actions" });
        if (section.desc) {
          el.createEl("p", { cls: "lmsa-settings-section-desc", text: section.desc });
        }
      }),
      ...section.rows,
    ],
  }));
}
