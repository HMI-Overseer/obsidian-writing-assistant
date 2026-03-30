import type { CompletionModel, AnthropicCacheSettings, CacheTtl } from "../../shared/types";
import type { ChatLayoutRefs } from "../types";

type CacheSettingsPopoverOptions = {
  getActiveModel: () => CompletionModel | null;
  onSettingsChange: (modelId: string, settings: AnthropicCacheSettings) => Promise<void>;
};

export class CacheSettingsPopover {
  private popoverOpen = false;

  constructor(
    private readonly refs: Pick<ChatLayoutRefs, "cacheSettingsBtn" | "cacheSettingsPopoverEl">,
    private readonly options: CacheSettingsPopoverOptions
  ) {
    this.refs.cacheSettingsBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      if (this.popoverOpen) {
        this.close();
      } else {
        this.open();
      }
    });

    this.refs.cacheSettingsPopoverEl.addEventListener("click", (event) => {
      event.stopPropagation();
    });
  }

  syncVisibility(): void {
    const model = this.options.getActiveModel();
    const isAnthropic = model?.provider === "anthropic";
    this.refs.cacheSettingsBtn.style.display = isAnthropic ? "" : "none";

    if (!isAnthropic && this.popoverOpen) {
      this.close();
    }
  }

  open(): void {
    const model = this.options.getActiveModel();
    if (!model || model.provider !== "anthropic") return;

    this.popoverOpen = true;
    this.refs.cacheSettingsPopoverEl.style.display = "block";
    this.renderContent(model);
  }

  close(): void {
    this.popoverOpen = false;
    this.refs.cacheSettingsPopoverEl.style.display = "none";
  }

  isOpen(): boolean {
    return this.popoverOpen;
  }

  destroy(): void {
    this.close();
  }

  private renderContent(model: CompletionModel): void {
    const el = this.refs.cacheSettingsPopoverEl;
    el.empty();

    const settings: AnthropicCacheSettings = model.anthropicCacheSettings ?? {
      enabled: false,
      ttl: "default",
    };

    const title = el.createDiv({ cls: "lmsa-cache-popover-title", text: "Prompt Caching" });
    title.createEl("span", {
      cls: "lmsa-cache-popover-subtitle",
      text: "Cache the system prompt to reduce latency and cost.",
    });

    // Toggle row
    const toggleRow = el.createDiv({ cls: "lmsa-cache-popover-row" });
    toggleRow.createEl("span", { cls: "lmsa-cache-popover-label", text: "Enable caching" });

    const toggleWrapper = toggleRow.createDiv({ cls: "lmsa-cache-popover-control" });
    const checkbox = toggleWrapper.createEl("input", {
      attr: { type: "checkbox" },
      cls: "lmsa-cache-toggle",
    }) as HTMLInputElement;
    checkbox.checked = settings.enabled;

    // TTL row
    const ttlRow = el.createDiv({ cls: "lmsa-cache-popover-row" });
    ttlRow.createEl("span", { cls: "lmsa-cache-popover-label", text: "Cache TTL" });

    const ttlWrapper = ttlRow.createDiv({ cls: "lmsa-cache-popover-control" });
    const ttlSelect = ttlWrapper.createEl("select", {
      cls: "lmsa-cache-ttl-select",
    }) as HTMLSelectElement;
    ttlSelect.createEl("option", { text: "5 min (default)", attr: { value: "default" } });
    ttlSelect.createEl("option", { text: "1 hour (2x write cost)", attr: { value: "1h" } });
    ttlSelect.value = settings.ttl;
    ttlSelect.disabled = !settings.enabled;

    // Event handlers
    const emitChange = async (updated: Partial<AnthropicCacheSettings>): Promise<void> => {
      const current: AnthropicCacheSettings = {
        enabled: checkbox.checked,
        ttl: ttlSelect.value as CacheTtl,
        ...updated,
      };
      ttlSelect.disabled = !current.enabled;
      await this.options.onSettingsChange(model.id, current);
    };

    checkbox.addEventListener("change", () => {
      void emitChange({ enabled: checkbox.checked });
    });

    ttlSelect.addEventListener("change", () => {
      void emitChange({ ttl: ttlSelect.value as CacheTtl });
    });
  }
}
