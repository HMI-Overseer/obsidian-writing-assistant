import type { CompletionModel, ProviderOption } from "../../shared/types";
import { PROVIDER_DESCRIPTORS } from "../../providers/descriptors";
import { Toggle } from "../../settings/ui";
import type { ChatLayoutRefs } from "../types";

export type ToolUsePopoverCallbacks = {
  getPreferToolUse: () => boolean;
  getActiveModel: () => CompletionModel | null;
  getTrainedForToolUse: (modelId: string) => boolean | undefined;
  onToggle: (enabled: boolean) => Promise<void>;
  onBeforeOpen?: () => void;
};

interface SectionRefs {
  toggle: Toggle;
  statusEl: HTMLElement;
  hintEl: HTMLElement;
}

/**
 * Resolves whether tool use is effectively available for the given model,
 * mirroring the logic in `shouldUseToolCall` but returning granular info.
 */
function resolveToolUseStatus(
  preferToolUse: boolean,
  model: CompletionModel | null,
  trainedForToolUse: boolean | undefined,
): { effective: boolean; reason: "active" | "disabled" | "model-unsupported" | "no-model" } {
  if (!model) return { effective: false, reason: "no-model" };
  if (!preferToolUse) return { effective: false, reason: "disabled" };

  if (model.provider === "lmstudio") {
    const trained = model.trainedForToolUse ?? trainedForToolUse;
    if (trained !== true) return { effective: false, reason: "model-unsupported" };
    return { effective: true, reason: "active" };
  }

  const descriptor = PROVIDER_DESCRIPTORS[model.provider as ProviderOption];
  if (!descriptor?.supportsToolUse) return { effective: false, reason: "model-unsupported" };
  return { effective: true, reason: "active" };
}

const STATUS_TEXT: Record<string, string> = {
  active: "Edit mode uses structured tool calls",
  disabled: "All models use SEARCH/REPLACE text edits",
  "model-unsupported": "Current model is not trained for tool use \u2014 falling back to text edits",
  "no-model": "No model selected",
};

export class ToolUsePopover {
  private popoverOpen = false;
  private sectionRefs: SectionRefs | null = null;
  private readonly onIndicatorClick: (event: MouseEvent) => void;
  private readonly onPopoverClick: (event: MouseEvent) => void;

  constructor(
    private readonly refs: Pick<
      ChatLayoutRefs,
      "toolUseIndicatorEl" | "toolUsePopoverEl"
    >,
    private readonly callbacks: ToolUsePopoverCallbacks
  ) {
    this.onIndicatorClick = (event: MouseEvent) => {
      event.stopPropagation();
      if (this.popoverOpen) {
        this.close();
      } else {
        this.open();
      }
    };

    this.onPopoverClick = (event: MouseEvent) => {
      event.stopPropagation();
    };

    this.refs.toolUseIndicatorEl.addEventListener("click", this.onIndicatorClick);
    this.refs.toolUsePopoverEl.addEventListener("click", this.onPopoverClick);
  }

  open(): void {
    this.callbacks.onBeforeOpen?.();
    this.popoverOpen = true;
    this.refs.toolUsePopoverEl.removeClass("lmsa-hidden");
    this.renderContent();
  }

  close(): void {
    this.popoverOpen = false;
    this.refs.toolUsePopoverEl.addClass("lmsa-hidden");
    this.sectionRefs = null;
  }

  isOpen(): boolean {
    return this.popoverOpen;
  }

  /** Re-sync the popover UI with current state (e.g. after model change). */
  refresh(): void {
    if (!this.popoverOpen || !this.sectionRefs) return;
    this.syncSection(this.sectionRefs);
  }

  destroy(): void {
    this.close();
    this.refs.toolUseIndicatorEl.removeEventListener("click", this.onIndicatorClick);
    this.refs.toolUsePopoverEl.removeEventListener("click", this.onPopoverClick);
  }

  // ---------------------------------------------------------------------------
  // Content rendering
  // ---------------------------------------------------------------------------

  private renderContent(): void {
    const el = this.refs.toolUsePopoverEl;
    el.empty();

    el.createDiv({ cls: "lmsa-tool-popover-title", text: "Tool use" });
    const body = el.createDiv({ cls: "lmsa-tool-popover-body" });

    this.sectionRefs = this.renderSection(body);
    this.syncSection(this.sectionRefs);
  }

  private renderSection(container: HTMLElement): SectionRefs {
    const section = container.createDiv({ cls: "lmsa-tool-popover-section" });

    // Toggle row
    const headerRow = section.createDiv({ cls: "lmsa-tool-popover-row" });
    headerRow.createEl("span", { cls: "lmsa-tool-popover-label", text: "Prefer tool calling" });
    const toggleWrap = headerRow.createDiv({ cls: "lmsa-tool-popover-control" });
    const toggle = new Toggle(toggleWrap);
    toggle.onChange((value) => {
      void this.callbacks.onToggle(value);
      if (this.sectionRefs) this.syncSection(this.sectionRefs);
    });

    // Status text
    const statusEl = section.createEl("span", { cls: "lmsa-tool-popover-status" });

    // Hint
    const hintEl = section.createEl("span", {
      cls: "lmsa-tool-popover-hint",
      text: "Configure edit mode prompts in plugin settings.",
    });

    return { toggle, statusEl, hintEl };
  }

  // ---------------------------------------------------------------------------
  // Refresh
  // ---------------------------------------------------------------------------

  private syncSection(refs: SectionRefs): void {
    const preferToolUse = this.callbacks.getPreferToolUse();
    const model = this.callbacks.getActiveModel();
    const trained = model
      ? this.callbacks.getTrainedForToolUse(model.modelId)
      : undefined;

    refs.toggle.setValue(preferToolUse);

    const { reason } = resolveToolUseStatus(preferToolUse, model, trained);
    refs.statusEl.textContent = STATUS_TEXT[reason];

    // Add warning styling when enabled but model can't use it
    refs.statusEl.toggleClass("is-warning", reason === "model-unsupported");
  }
}
