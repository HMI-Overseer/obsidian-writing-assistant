import { setIcon } from "obsidian";
import type { ApprovalPosture } from "../../shared/types";
import type { ChatLayoutRefs } from "../types";

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
    const current = this.callbacks.getPosture();

    for (const option of POSTURE_OPTIONS) {
      const item = el.createDiv({ cls: "lmsa-posture-menu-item" });
      const isCurrent = option.posture === current;
      item.toggleClass("is-selected", isCurrent);
      const iconEl = item.createEl("span", { cls: "lmsa-posture-menu-item-icon" });
      setIcon(iconEl, option.icon);
      item.createEl("span", { cls: "lmsa-posture-menu-item-label", text: option.label });
      if (isCurrent) {
        const check = item.createEl("span", { cls: "lmsa-posture-menu-item-check" });
        setIcon(check, "check");
      }
      item.addEventListener("click", () => {
        this.callbacks.onPostureChange(option.posture);
        this.close();
        this.refresh();
      });
    }
  }
}
