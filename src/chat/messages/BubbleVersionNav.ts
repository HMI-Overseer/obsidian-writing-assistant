import { setIcon } from "obsidian";
import type { ConversationMessage } from "../../shared/types";

export interface VersionNavigationState {
  activeIndex: number;
  total: number;
}

export function getVersionNavigationState(
  message: ConversationMessage,
): VersionNavigationState | null {
  if (message.revisions) {
    if (message.revisions.length <= 1 || !message.activeRevisionId) return null;
    const activeIndex = message.revisions.findIndex(
      (revision) => revision.revisionId === message.activeRevisionId,
    );
    return activeIndex < 0
      ? null
      : { activeIndex, total: message.revisions.length };
  }
  if (!message.versions || message.versions.length <= 1) return null;
  const activeIndex =
    message.activeVersionIndex ?? message.versions.length - 1;
  return activeIndex < 0 || activeIndex >= message.versions.length
    ? null
    : { activeIndex, total: message.versions.length };
}

export class BubbleVersionNav {
  static render(
    chromeEl: HTMLElement,
    message: ConversationMessage,
    onVersionChange: (messageId: string, newIndex: number) => void
  ): HTMLElement | null {
    const state = getVersionNavigationState(message);
    if (!state) return null;
    const { activeIndex, total } = state;

    const navEl = chromeEl.createDiv({ cls: "lmsa-chat-window-version-nav" });

    const prevBtn = navEl.createEl("button", {
      cls: "lmsa-chat-window-version-prev",
      attr: { "aria-label": "Previous version", type: "button" },
    });
    setIcon(prevBtn, "chevron-left");
    if (activeIndex <= 0) prevBtn.disabled = true;

    navEl.createSpan({
      cls: "lmsa-chat-window-version-indicator",
      text: `${activeIndex + 1}/${total}`,
    });

    const nextBtn = navEl.createEl("button", {
      cls: "lmsa-chat-window-version-next",
      attr: { "aria-label": "Next version", type: "button" },
    });
    setIcon(nextBtn, "chevron-right");
    if (activeIndex >= total - 1) nextBtn.disabled = true;

    prevBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (activeIndex > 0) {
        onVersionChange(message.id, activeIndex - 1);
      }
    });

    nextBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (activeIndex < total - 1) {
        onVersionChange(message.id, activeIndex + 1);
      }
    });

    return navEl;
  }
}
