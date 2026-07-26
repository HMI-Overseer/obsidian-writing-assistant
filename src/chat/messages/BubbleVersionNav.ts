import { setIcon } from "obsidian";
import type { ConversationMessage } from "../../shared/types";

export interface VersionNavigationState {
  activeIndex: number;
  total: number;
  previousRevisionId?: string;
  nextRevisionId?: string;
}

export function getVersionNavigationState(
  message: ConversationMessage,
): VersionNavigationState | null {
  if (
    !message.revisions ||
    message.revisions.length <= 1 ||
    !message.activeRevisionId
  ) {
    return null;
  }
  const activeIndex = message.revisions.findIndex(
    (revision) => revision.revisionId === message.activeRevisionId,
  );
  if (activeIndex < 0) return null;
  return {
    activeIndex,
    total: message.revisions.length,
    ...(activeIndex > 0
      ? {
          previousRevisionId:
            message.revisions[activeIndex - 1].revisionId,
        }
      : {}),
    ...(activeIndex < message.revisions.length - 1
      ? {
          nextRevisionId:
            message.revisions[activeIndex + 1].revisionId,
        }
      : {}),
  };
}

export class BubbleVersionNav {
  static render(
    chromeEl: HTMLElement,
    message: ConversationMessage,
    onVersionChange: (messageId: string, revisionId: string) => void
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
      if (state.previousRevisionId) {
        onVersionChange(message.id, state.previousRevisionId);
      }
    });

    nextBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (state.nextRevisionId) {
        onVersionChange(message.id, state.nextRevisionId);
      }
    });

    return navEl;
  }
}
