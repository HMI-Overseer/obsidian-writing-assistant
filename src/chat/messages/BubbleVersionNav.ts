import { setIcon } from "obsidian";
import type { ConversationMessage } from "../../shared/types";

export class BubbleVersionNav {
  static render(
    chromeEl: HTMLElement,
    message: ConversationMessage,
    onVersionChange: (messageId: string, newIndex: number) => void
  ): HTMLElement | null {
    if (!message.versions || message.versions.length <= 1) return null;

    const activeIndex = message.activeVersionIndex ?? message.versions.length - 1;
    const total = message.versions.length;

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
