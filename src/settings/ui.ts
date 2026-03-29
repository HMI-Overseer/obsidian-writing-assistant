import { setIcon } from "obsidian";

export type SettingsSectionRefs = {
  sectionEl: HTMLElement;
  headerEl: HTMLElement;
  headerActionsEl: HTMLElement;
  bodyEl: HTMLElement;
  footerEl: HTMLElement;
};

export interface SectionOptions {
  /** Lucide icon name rendered as a colored badge in the section header. */
  icon?: string;
}

export function createSettingsSection(
  container: HTMLElement,
  title: string,
  description?: string,
  options?: SectionOptions
): SettingsSectionRefs {
  const sectionEl = container.createDiv({ cls: "lmsa-settings-section lmsa-ui-card" });
  const headerEl = sectionEl.createDiv({ cls: "lmsa-settings-section-header" });
  const headingEl = headerEl.createDiv({ cls: "lmsa-settings-section-heading" });
  const headerActionsEl = headerEl.createDiv({ cls: "lmsa-settings-section-actions" });

  if (options?.icon) {
    const badge = headingEl.createDiv({ cls: "lmsa-settings-section-icon" });
    setIcon(badge, options.icon);
  }

  headingEl.createEl("h3", {
    cls: "lmsa-settings-section-title",
    text: title,
  });

  const bodyEl = sectionEl.createDiv({ cls: "lmsa-settings-section-body" });

  if (description) {
    bodyEl.createEl("p", {
      cls: "lmsa-settings-section-desc",
      text: description,
    });
  }
  const footerEl = sectionEl.createDiv({ cls: "lmsa-settings-section-footer" });

  return { sectionEl, headerEl, headerActionsEl, bodyEl, footerEl };
}
