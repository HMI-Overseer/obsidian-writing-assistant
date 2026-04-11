import type { AnthropicCacheSettings, CacheTtl } from "../../../shared/types";

export interface CacheSettingsControlOptions {
  settings: AnthropicCacheSettings;
  onChange: (settings: AnthropicCacheSettings) => void;
}

/**
 * Anthropic prompt caching toggle + TTL selector.
 */
export class CacheSettingsControl {
  private toggleEl: HTMLInputElement | null = null;
  private ttlSelectEl: HTMLSelectElement | null = null;

  constructor(
    private readonly container: HTMLElement,
    private readonly opts: CacheSettingsControlOptions,
  ) {
    this.render();
  }

  private render(): void {
    const section = this.container.createDiv({ cls: "lmsa-profile-popover-section" });
    section.createEl("div", {
      cls: "lmsa-profile-popover-section-title",
      text: "Prompt caching",
    });

    // Toggle row
    const toggleRow = section.createDiv({ cls: "lmsa-profile-popover-row" });
    toggleRow.createEl("span", {
      cls: "lmsa-profile-popover-label",
      text: "Enable caching",
    });

    const toggleWrapper = toggleRow.createDiv({ cls: "lmsa-profile-popover-control" });
    this.toggleEl = toggleWrapper.createEl("input", {
      attr: { type: "checkbox" },
      cls: "lmsa-profile-toggle",
    }) as HTMLInputElement;
    this.toggleEl.checked = this.opts.settings.enabled;

    // TTL row
    const ttlRow = section.createDiv({ cls: "lmsa-profile-popover-row" });
    ttlRow.createEl("span", {
      cls: "lmsa-profile-popover-label",
      text: "Cache TTL",
    });

    const ttlWrapper = ttlRow.createDiv({ cls: "lmsa-profile-popover-control" });
    this.ttlSelectEl = ttlWrapper.createEl("select", {
      cls: "lmsa-profile-ttl-select",
    }) as HTMLSelectElement;
    this.ttlSelectEl.createEl("option", { text: "5 min (default)", attr: { value: "default" } });
    this.ttlSelectEl.createEl("option", { text: "1 hour (2x write cost)", attr: { value: "1h" } });
    this.ttlSelectEl.value = this.opts.settings.ttl;
    this.ttlSelectEl.disabled = !this.opts.settings.enabled;

    this.toggleEl.addEventListener("change", () => {
      if (!this.toggleEl || !this.ttlSelectEl) return;
      const enabled = this.toggleEl.checked;
      this.ttlSelectEl.disabled = !enabled;
      this.opts.onChange({
        enabled,
        ttl: this.ttlSelectEl.value as CacheTtl,
      });
    });

    this.ttlSelectEl.addEventListener("change", () => {
      if (!this.toggleEl || !this.ttlSelectEl) return;
      this.opts.onChange({
        enabled: this.toggleEl.checked,
        ttl: this.ttlSelectEl.value as CacheTtl,
      });
    });
  }

  setDisabled(disabled: boolean): void {
    if (this.toggleEl) this.toggleEl.disabled = disabled;
    if (this.ttlSelectEl) this.ttlSelectEl.disabled = disabled;
  }
}
