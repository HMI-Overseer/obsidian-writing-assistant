import type { CompletionModel, ProviderOption } from "../../shared/types";
import { PROVIDER_DESCRIPTORS } from "../../providers/descriptors";
import { Toggle } from "../../settings/ui";
import type { ChatLayoutRefs } from "../types";

export type ToolUsePopoverCallbacks = {
  getAgenticMode: () => boolean;
  getActiveModel: () => CompletionModel | null;
  getTrainedForToolUse: (modelId: string) => boolean | undefined;
  onAgenticToggle: (enabled: boolean) => Promise<void>;
  onBeforeOpen?: () => void;
};

interface SectionRefs {
  agenticToggle: Toggle;
  agenticStatusEl: HTMLElement;
}

type ToolUseReason = "active" | "disabled" | "model-unsupported" | "no-model";

/**
 * Resolves whether the model technically supports tool/function calling.
 */
function modelCanUseTools(
  model: CompletionModel | null,
  trainedForToolUse: boolean | undefined,
): { capable: boolean; reason: ToolUseReason } {
  if (!model) return { capable: false, reason: "no-model" };

  if (model.provider === "lmstudio") {
    const trained = model.trainedForToolUse ?? trainedForToolUse;
    if (trained !== true) return { capable: false, reason: "model-unsupported" };
    return { capable: true, reason: "active" };
  }

  const descriptor = PROVIDER_DESCRIPTORS[model.provider as ProviderOption];
  if (!descriptor?.supportsToolUse) return { capable: false, reason: "model-unsupported" };
  return { capable: true, reason: "active" };
}

const AGENTIC_STATUS_TEXT: Record<string, string> = {
  active: "Vault search and edit tools available",
  disabled: "Agentic mode off, no tools used",
  "model-unsupported": "Current model does not support tool use",
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
    this.syncContent(this.sectionRefs);
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

    this.sectionRefs = this.renderSections(body);
    this.syncContent(this.sectionRefs);
  }

  private renderSections(container: HTMLElement): SectionRefs {
    // --- Agentic mode ---
    const agenticSection = container.createDiv({ cls: "lmsa-tool-popover-section" });

    const agenticRow = agenticSection.createDiv({ cls: "lmsa-tool-popover-row" });
    agenticRow.createEl("span", { cls: "lmsa-tool-popover-label", text: "Agentic mode" });
    const agenticToggleWrap = agenticRow.createDiv({ cls: "lmsa-tool-popover-control" });
    const agenticToggle = new Toggle(agenticToggleWrap);
    agenticToggle.onChange((value) => {
      void this.callbacks.onAgenticToggle(value);
      if (this.sectionRefs) this.syncContent(this.sectionRefs);
    });

    const agenticStatusEl = agenticSection.createEl("span", { cls: "lmsa-tool-popover-status" });

    return { agenticToggle, agenticStatusEl };
  }

  // ---------------------------------------------------------------------------
  // Sync
  // ---------------------------------------------------------------------------

  private syncContent(refs: SectionRefs): void {
    const agenticMode = this.callbacks.getAgenticMode();
    const model = this.callbacks.getActiveModel();
    const trained = model
      ? this.callbacks.getTrainedForToolUse(model.modelId)
      : undefined;

    const { capable, reason: capabilityReason } = modelCanUseTools(model, trained);

    refs.agenticToggle.setValue(agenticMode);

    let agenticReason: ToolUseReason;
    if (!agenticMode) {
      agenticReason = "disabled";
    } else if (!capable) {
      agenticReason = capabilityReason;
    } else {
      agenticReason = "active";
    }
    refs.agenticStatusEl.textContent = AGENTIC_STATUS_TEXT[agenticReason];
    refs.agenticStatusEl.toggleClass("is-warning", agenticReason === "model-unsupported");
  }
}
