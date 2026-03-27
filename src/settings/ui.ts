export type SettingsSectionRefs = {
  sectionEl: HTMLElement;
  bodyEl: HTMLElement;
  footerEl: HTMLElement;
};

export function createSettingsSection(
  container: HTMLElement,
  title: string,
  description?: string
): SettingsSectionRefs {
  const sectionEl = container.createDiv({ cls: "lmsa-settings-section lmsa-ui-card" });
  const headerEl = sectionEl.createDiv({ cls: "lmsa-settings-section-header" });

  headerEl.createEl("h3", {
    cls: "lmsa-settings-section-title",
    text: title,
  });

  if (description) {
    headerEl.createEl("p", {
      cls: "lmsa-settings-section-desc",
      text: description,
    });
  }

  const bodyEl = sectionEl.createDiv({ cls: "lmsa-settings-section-body" });
  const footerEl = sectionEl.createDiv({ cls: "lmsa-settings-section-footer" });

  return { sectionEl, bodyEl, footerEl };
}
