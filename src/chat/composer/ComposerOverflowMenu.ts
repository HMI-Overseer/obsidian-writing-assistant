import { setIcon } from "obsidian";
import type { ApprovalPosture } from "../../shared/types";
import type { ChatLayoutRefs } from "../types";
import { renderMenuItem } from "./menuItem";
import {
  buildReasoningItemSpecs,
  resolveReasoningMenuState,
  type ReasoningMenuContext,
  type ReasoningPillCallbacks,
} from "./ReasoningPill";
import { buildPostureItemSpecs } from "./PosturePill";

export type ComposerOverflowMenuCallbacks = ReasoningMenuContext & {
  onReasoningChange: ReasoningPillCallbacks["onReasoningChange"];
  getPosture: () => ApprovalPosture;
  onPostureChange: (posture: ApprovalPosture) => void;
  /** Vision capability of the active model; null means no model selected. */
  getVisionSupported: () => boolean | null;
  /** Opens the tool-use popover (its row shows only while the tool chip is hidden). */
  onOpenTools: () => void;
  /** Opens the knowledge popover (its row shows only while the knowledge chip is hidden). */
  onOpenKnowledge: () => void;
  onBeforeOpen?: () => void;
};

/**
 * The composer footer's narrow-width overflow menu (the "..." button). As the
 * footer narrows, controls leave the row entirely instead of degrading to
 * bare icons, and each one's section here is gated by the same
 * container-query breakpoint that hides its footer counterpart
 * (ComposerOverflowMenu.css), so at any width the menu carries exactly the
 * controls the row cannot show and nothing appears twice. The send button and
 * the capacity ring never enter the overflow.
 */
export class ComposerOverflowMenu {
  private menuOpen = false;
  private readonly onButtonClick: (event: MouseEvent) => void;
  private readonly onMenuClick: (event: MouseEvent) => void;

  constructor(
    private readonly refs: Pick<ChatLayoutRefs, "overflowBtnEl" | "overflowMenuEl">,
    private readonly callbacks: ComposerOverflowMenuCallbacks,
  ) {
    this.onButtonClick = (event: MouseEvent) => {
      event.stopPropagation();
      if (this.menuOpen) {
        this.close();
      } else {
        this.open();
      }
    };

    this.onMenuClick = (event: MouseEvent) => {
      event.stopPropagation();
    };

    this.refs.overflowBtnEl.addEventListener("click", this.onButtonClick);
    this.refs.overflowMenuEl.addEventListener("click", this.onMenuClick);
  }

  open(): void {
    this.callbacks.onBeforeOpen?.();
    this.menuOpen = true;
    this.refs.overflowMenuEl.removeClass("lmsa-hidden");
    this.renderMenu();
  }

  close(): void {
    this.menuOpen = false;
    this.refs.overflowMenuEl.addClass("lmsa-hidden");
  }

  isOpen(): boolean {
    return this.menuOpen;
  }

  /** Re-render the open menu after external state changes (model, posture, reasoning). */
  refresh(): void {
    if (this.menuOpen) this.renderMenu();
  }

  destroy(): void {
    this.close();
    this.refs.overflowBtnEl.removeEventListener("click", this.onButtonClick);
    this.refs.overflowMenuEl.removeEventListener("click", this.onMenuClick);
  }

  /**
   * All sections render every time; CSS decides which are visible at the
   * current footer width. They render in descending breakpoint order
   * (reasoning 521 > vision 479 > knowledge 439 > tools 399 > posture 359),
   * so the hidden ones always form a trailing run and the between-sections
   * divider rule never strands a divider above the first visible section.
   */
  private renderMenu(): void {
    const el = this.refs.overflowMenuEl;
    el.empty();

    const reasoningState = resolveReasoningMenuState(this.callbacks);
    if (reasoningState !== null) {
      const section = this.createSection(el, "reasoning", "Reasoning");
      const specs = buildReasoningItemSpecs(reasoningState, (modelKey, level) => {
        void this.callbacks.onReasoningChange(modelKey, level).then(() => this.close());
      });
      for (const spec of specs) {
        renderMenuItem(section, spec);
      }
    }

    this.renderVisionSection(el);

    const knowledgeSection = this.createSection(el, "knowledge");
    renderMenuItem(knowledgeSection, {
      label: "Knowledge…",
      icon: "database",
      selected: false,
      onSelect: () => {
        this.close();
        this.callbacks.onOpenKnowledge();
      },
    });

    const toolsSection = this.createSection(el, "tools");
    renderMenuItem(toolsSection, {
      label: "Tools…",
      icon: "wrench",
      selected: false,
      onSelect: () => {
        this.close();
        this.callbacks.onOpenTools();
      },
    });

    const postureSection = this.createSection(el, "posture", "Edit approval");
    const postureSpecs = buildPostureItemSpecs(this.callbacks.getPosture(), (posture) => {
      this.callbacks.onPostureChange(posture);
      this.close();
    });
    for (const spec of postureSpecs) {
      renderMenuItem(postureSection, spec);
    }
  }

  private createSection(el: HTMLElement, key: string, heading?: string): HTMLElement {
    const section = el.createDiv({
      cls: `lmsa-overflow-menu-section lmsa-overflow-section-${key}`,
    });
    if (heading !== undefined) {
      section.createDiv({ cls: "lmsa-overflow-menu-heading", text: heading });
    }
    return section;
  }

  /** Status-only row mirroring the footer's vision indicator (never interactive). */
  private renderVisionSection(el: HTMLElement): void {
    const supported = this.callbacks.getVisionSupported();
    const section = this.createSection(el, "vision");
    const row = section.createDiv({ cls: "lmsa-overflow-menu-status" });
    row.toggleClass("is-active", supported === true);
    const iconEl = row.createSpan({ cls: "lmsa-overflow-menu-status-icon" });
    setIcon(iconEl, "eye");
    row.createSpan({
      cls: "lmsa-overflow-menu-status-label",
      text:
        supported === null
          ? "No model selected"
          : supported
            ? "Vision supported"
            : "Vision not available",
    });
  }
}
