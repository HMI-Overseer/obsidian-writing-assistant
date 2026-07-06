import { setIcon } from "obsidian";
import type { CompletionModel, ReasoningLevel } from "../../shared/types";
import {
  REASONING_DEFAULT_LABEL,
  REASONING_LEVEL_LABELS,
} from "../../shared/reasoning";
import {
  resolveModelReasoning,
  resolveReasoningLevels,
  type ReasoningDiscovery,
} from "../../providers/reasoningLevels";
import type { ChatLayoutRefs } from "../types";

export type ReasoningPillCallbacks = {
  getActiveModel: () => CompletionModel | null;
  getReasoningByModelKey: () => Record<string, ReasoningLevel>;
  /** Live per-model capability source (the availability service). */
  getReasoningDiscovery: () => ReasoningDiscovery;
  /** Writes the model's `reasoningByModelKey` entry (null clears it). */
  onReasoningChange: (modelKey: string, level: ReasoningLevel | null) => Promise<void>;
  onBeforeOpen?: () => void;
};

/**
 * The composer footer's reasoning pill: reads the active model's current level
 * at a glance, one click opens a compact menu of the model's resolved level set
 * (composer-reasoning-effort-selector §3.3). Same visual language as the
 * posture toggle; hidden entirely for models with an empty resolved set. Writes
 * the same per-model entry as the profile popover's reasoning control.
 */
export class ReasoningPill {
  private menuOpen = false;
  private readonly onPillClick: (event: MouseEvent) => void;
  private readonly onMenuClick: (event: MouseEvent) => void;

  constructor(
    private readonly refs: Pick<ChatLayoutRefs, "reasoningPillEl" | "reasoningMenuEl">,
    private readonly callbacks: ReasoningPillCallbacks,
  ) {
    this.onPillClick = (event: MouseEvent) => {
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

    this.refs.reasoningPillEl.addEventListener("click", this.onPillClick);
    this.refs.reasoningMenuEl.addEventListener("click", this.onMenuClick);
  }

  open(): void {
    if (this.resolveState() === null) return;
    this.callbacks.onBeforeOpen?.();
    this.menuOpen = true;
    this.refs.reasoningMenuEl.removeClass("lmsa-hidden");
    this.renderMenu();
  }

  close(): void {
    this.menuOpen = false;
    this.refs.reasoningMenuEl.addClass("lmsa-hidden");
  }

  isOpen(): boolean {
    return this.menuOpen;
  }

  /** Re-sync the pill label and visibility with the active model (call on model change). */
  refresh(): void {
    const state = this.resolveState();
    if (state === null) {
      this.refs.reasoningPillEl.addClass("lmsa-hidden");
      if (this.menuOpen) this.close();
      return;
    }

    this.refs.reasoningPillEl.removeClass("lmsa-hidden");
    const labelEl = this.refs.reasoningPillEl.querySelector(
      ".lmsa-chat-composer-reasoning-pill-label",
    );
    // Defaults are displayed, never fabricated: where discovery reports one
    // (LM Studio) the null state names it ("On · default"); otherwise plain
    // "Default" (§3.3).
    const label =
      state.current !== null
        ? REASONING_LEVEL_LABELS[state.current]
        : state.discoveredDefault !== null
          ? `${REASONING_LEVEL_LABELS[state.discoveredDefault]} · default`
          : REASONING_DEFAULT_LABEL;
    if (labelEl) labelEl.textContent = label;
    this.refs.reasoningPillEl.toggleClass("is-default", state.current === null);
    this.refs.reasoningPillEl.setAttribute("aria-label", `Reasoning effort: ${label}`);

    if (this.menuOpen) this.renderMenu();
  }

  destroy(): void {
    this.close();
    this.refs.reasoningPillEl.removeEventListener("click", this.onPillClick);
    this.refs.reasoningMenuEl.removeEventListener("click", this.onMenuClick);
  }

  /** Active model + its resolved levels + clamped current value; null = no pill. */
  private resolveState(): {
    model: CompletionModel;
    levels: ReasoningLevel[];
    current: ReasoningLevel | null;
    discoveredDefault: ReasoningLevel | null;
  } | null {
    const model = this.callbacks.getActiveModel();
    if (!model) return null;
    const discovery = this.callbacks.getReasoningDiscovery();
    const levels = resolveReasoningLevels(model, discovery);
    if (levels.length === 0) return null;
    const current = resolveModelReasoning(
      this.callbacks.getReasoningByModelKey(),
      model,
      discovery,
    );
    const discoveredDefault = discovery.getReasoningCapability(model.modelId)?.default ?? null;
    return { model, levels, current, discoveredDefault };
  }

  private renderMenu(): void {
    const state = this.resolveState();
    if (state === null) return;

    const el = this.refs.reasoningMenuEl;
    el.empty();

    // Null first: defaults are displayed, never fabricated, the model's own
    // default is not assumed to be any particular level (§3.3).
    this.renderItem(el, null, state);
    for (const level of state.levels) {
      this.renderItem(el, level, state);
    }
  }

  private renderItem(
    el: HTMLElement,
    level: ReasoningLevel | null,
    state: {
      model: CompletionModel;
      current: ReasoningLevel | null;
      discoveredDefault: ReasoningLevel | null;
    },
  ): void {
    const item = el.createDiv({ cls: "lmsa-reasoning-menu-item" });
    const isCurrent = level === state.current;
    item.toggleClass("is-selected", isCurrent);
    const defaultLabel =
      state.discoveredDefault !== null
        ? `${REASONING_DEFAULT_LABEL} (${REASONING_LEVEL_LABELS[state.discoveredDefault]})`
        : REASONING_DEFAULT_LABEL;
    item.createEl("span", {
      cls: "lmsa-reasoning-menu-item-label",
      text: level !== null ? REASONING_LEVEL_LABELS[level] : defaultLabel,
    });
    if (isCurrent) {
      const check = item.createEl("span", { cls: "lmsa-reasoning-menu-item-check" });
      setIcon(check, "check");
    }
    item.addEventListener("click", () => {
      void this.callbacks.onReasoningChange(state.model.id, level).then(() => {
        this.close();
        this.refresh();
      });
    });
  }
}
