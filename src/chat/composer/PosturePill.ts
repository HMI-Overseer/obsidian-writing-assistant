import { setIcon } from "obsidian";
import type { ApprovalPosture } from "../../shared/types";
import type { ChatLayoutRefs } from "../types";
import { renderMenuItem, type MenuItemSpec } from "./menuItem";

export const POSTURE_OPTIONS: { posture: ApprovalPosture; label: string; icon: string }[] = [
  { posture: "ask", icon: "hand", label: "Ask before edits" },
  { posture: "auto", icon: "zap", label: "Edit automatically" },
];

export type PosturePillCallbacks = {
  getPosture: () => ApprovalPosture;
  onPostureChange: (posture: ApprovalPosture) => void;
  onBeforeOpen?: () => void;
};

/**
 * Builds the posture rows, one shared shape for the pill's own menu and the
 * overflow menu's edit-approval section.
 */
export function buildPostureItemSpecs(
  current: ApprovalPosture,
  onSelect: (posture: ApprovalPosture) => void,
): MenuItemSpec[] {
  return POSTURE_OPTIONS.map((option) => ({
    label: option.label,
    icon: option.icon,
    selected: option.posture === current,
    onSelect: () => onSelect(option.posture),
  }));
}

/**
 * The composer footer's approval-posture pill: shows the current posture at a
 * glance, one click opens a compact menu of the two postures. Same visual
 * language and behavior as the reasoning pill (label + chevron that flips
 * while the menu is open); replaces the former two-segment slider toggle so
 * the footer carries one label instead of both.
 */
export class PosturePill {
  private menuOpen = false;
  private readonly onPillClick: (event: MouseEvent) => void;
  private readonly onMenuClick: (event: MouseEvent) => void;

  constructor(
    private readonly refs: Pick<ChatLayoutRefs, "posturePillEl" | "postureMenuEl">,
    private readonly callbacks: PosturePillCallbacks,
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

    this.refs.posturePillEl.addEventListener("click", this.onPillClick);
    this.refs.postureMenuEl.addEventListener("click", this.onMenuClick);
    this.refresh();
  }

  open(): void {
    this.callbacks.onBeforeOpen?.();
    this.menuOpen = true;
    this.refs.postureMenuEl.removeClass("lmsa-hidden");
    this.setChevron(true);
    this.renderMenu();
  }

  close(): void {
    this.menuOpen = false;
    this.refs.postureMenuEl.addClass("lmsa-hidden");
    this.setChevron(false);
  }

  isOpen(): boolean {
    return this.menuOpen;
  }

  /** Re-sync the pill icon and label with the current posture (call on posture change). */
  refresh(): void {
    const current = this.currentOption();
    const iconEl = this.refs.posturePillEl.querySelector(".lmsa-chat-composer-posture-pill-icon");
    if (iconEl instanceof HTMLElement) setIcon(iconEl, current.icon);
    const labelEl = this.refs.posturePillEl.querySelector(".lmsa-chat-composer-posture-pill-label");
    if (labelEl) labelEl.textContent = current.label;
    this.refs.posturePillEl.setAttribute("aria-label", `Edit approval: ${current.label}`);

    if (this.menuOpen) this.renderMenu();
  }

  destroy(): void {
    this.close();
    this.refs.posturePillEl.removeEventListener("click", this.onPillClick);
    this.refs.postureMenuEl.removeEventListener("click", this.onMenuClick);
  }

  /** Closed points up (the menu opens above the pill); open flips down, like the reasoning pill. */
  private setChevron(open: boolean): void {
    const chevronEl = this.refs.posturePillEl.querySelector(
      ".lmsa-chat-composer-posture-pill-chevron",
    );
    if (chevronEl instanceof HTMLElement) setIcon(chevronEl, open ? "chevron-down" : "chevron-up");
  }

  private currentOption(): (typeof POSTURE_OPTIONS)[number] {
    const posture = this.callbacks.getPosture();
    return POSTURE_OPTIONS.find((o) => o.posture === posture) ?? POSTURE_OPTIONS[0];
  }

  private renderMenu(): void {
    const el = this.refs.postureMenuEl;
    el.empty();

    const specs = buildPostureItemSpecs(this.callbacks.getPosture(), (posture) => {
      this.callbacks.onPostureChange(posture);
      this.close();
      this.refresh();
    });
    for (const spec of specs) {
      renderMenuItem(el, spec);
    }
  }
}
