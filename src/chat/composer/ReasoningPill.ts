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
import { renderMenuItem, type MenuItemSpec } from "./menuItem";

export type ReasoningPillCallbacks = {
  getActiveModel: () => CompletionModel | null;
  getReasoningByModelKey: () => Record<string, ReasoningLevel>;
  /** Live per-model capability source (the availability service). */
  getReasoningDiscovery: () => ReasoningDiscovery;
  /** Writes the model's `reasoningByModelKey` entry (null clears it). */
  onReasoningChange: (modelKey: string, level: ReasoningLevel | null) => Promise<void>;
  onBeforeOpen?: () => void;
};

/** The read-side callbacks a reasoning menu needs, shared with the overflow menu. */
export type ReasoningMenuContext = Pick<
  ReasoningPillCallbacks,
  "getActiveModel" | "getReasoningByModelKey" | "getReasoningDiscovery"
>;

/** Active model + its resolved levels + clamped current value. */
export type ReasoningMenuState = {
  model: CompletionModel;
  levels: ReasoningLevel[];
  current: ReasoningLevel | null;
  discoveredDefault: ReasoningLevel | null;
};

/** Resolves the menu's full state from live callbacks; null means no menu (no model or no levels). */
export function resolveReasoningMenuState(context: ReasoningMenuContext): ReasoningMenuState | null {
  const model = context.getActiveModel();
  if (!model) return null;
  const discovery = context.getReasoningDiscovery();
  const levels = resolveReasoningLevels(model, discovery);
  if (levels.length === 0) return null;
  const current = resolveModelReasoning(context.getReasoningByModelKey(), model, discovery);
  const discoveredDefault = discovery.getReasoningCapability(model.modelId)?.default ?? null;
  return { model, levels, current, discoveredDefault };
}

/**
 * Builds the level rows for a reasoning menu, one shared shape for the pill's
 * own menu and the overflow menu's reasoning section. Null first: defaults are
 * displayed, never fabricated, the model's own default is not assumed to be
 * any particular level (section 3.3).
 */
export function buildReasoningItemSpecs(
  state: ReasoningMenuState,
  onSelect: (modelKey: string, level: ReasoningLevel | null) => void,
): MenuItemSpec[] {
  const defaultLabel =
    state.discoveredDefault !== null
      ? `${REASONING_DEFAULT_LABEL} (${REASONING_LEVEL_LABELS[state.discoveredDefault]})`
      : REASONING_DEFAULT_LABEL;
  return [null, ...state.levels].map((level) => ({
    label: level !== null ? REASONING_LEVEL_LABELS[level] : defaultLabel,
    selected: level === state.current,
    onSelect: () => onSelect(state.model.id, level),
  }));
}

/**
 * The composer footer's reasoning pill: reads the active model's current level
 * at a glance, one click opens a compact menu of the model's resolved level set
 * (composer-reasoning-effort-selector section 3.3). Same visual language as the
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
    this.setChevron(true);
    this.renderMenu();
  }

  close(): void {
    this.menuOpen = false;
    this.refs.reasoningMenuEl.addClass("lmsa-hidden");
    this.setChevron(false);
  }

  /** Closed points up (the menu opens above the pill); open flips down, like the model selector. */
  private setChevron(open: boolean): void {
    const chevronEl = this.refs.reasoningPillEl.querySelector(
      ".lmsa-chat-composer-reasoning-pill-chevron",
    );
    if (chevronEl instanceof HTMLElement) setIcon(chevronEl, open ? "chevron-down" : "chevron-up");
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
    // "Default" (section 3.3).
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
  private resolveState(): ReasoningMenuState | null {
    return resolveReasoningMenuState(this.callbacks);
  }

  private renderMenu(): void {
    const state = this.resolveState();
    if (state === null) return;

    const el = this.refs.reasoningMenuEl;
    el.empty();

    const specs = buildReasoningItemSpecs(state, (modelKey, level) => {
      void this.callbacks.onReasoningChange(modelKey, level).then(() => {
        this.close();
        this.refresh();
      });
    });
    for (const spec of specs) {
      renderMenuItem(el, spec);
    }
  }
}
