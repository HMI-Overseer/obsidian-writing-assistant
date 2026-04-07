import { setIcon } from "obsidian";
import type { ConversationMessage } from "../../shared/types";
import type { BubbleActionCallbacks } from "./ChatTranscript";

type ActionDef = {
  action: string;
  icon: string;
  label: string;
};

const USER_ACTIONS: ActionDef[] = [
  { action: "branch", icon: "git-branch", label: "Branch after this" },
  { action: "copy", icon: "copy", label: "Copy message" },
  { action: "edit", icon: "pencil", label: "Edit message" },
  { action: "delete", icon: "trash-2", label: "Delete message" },
];

const ASSISTANT_ACTIONS: ActionDef[] = [
  { action: "branch", icon: "git-branch", label: "Branch after this" },
  { action: "copy", icon: "copy", label: "Copy message" },
  { action: "edit", icon: "pencil", label: "Edit message" },
  { action: "delete", icon: "trash-2", label: "Delete message" },
];

const REGENERATE_ACTION: ActionDef = {
  action: "regenerate",
  icon: "refresh-cw",
  label: "Regenerate response",
};

export class BubbleActionToolbar {
  static render(
    chromeEl: HTMLElement,
    message: ConversationMessage,
    options: {
      isLastAssistant: boolean;
      callbacks: BubbleActionCallbacks;
    }
  ): HTMLElement {
    const { isLastAssistant, callbacks } = options;

    const actionsEl = chromeEl.createDiv({ cls: "lmsa-chat-window-message-actions" });
    const actions = message.role === "user" ? USER_ACTIONS : [...ASSISTANT_ACTIONS];

    if (message.role === "assistant" && isLastAssistant) {
      actions.unshift(REGENERATE_ACTION);
    }

    for (const def of actions) {
      const btn = actionsEl.createEl("button", {
        cls: "lmsa-chat-window-action-btn",
        attr: {
          "data-action": def.action,
          "aria-label": def.label,
          type: "button",
        },
      });
      setIcon(btn, def.icon);

      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        this.handleAction(def.action, message.id, callbacks);
      });
    }

    return actionsEl;
  }

  private static handleAction(
    action: string,
    messageId: string,
    callbacks: BubbleActionCallbacks
  ): void {
    switch (action) {
      case "copy":
        callbacks.onCopy(messageId);
        break;
      case "edit":
        callbacks.onEdit(messageId);
        break;
      case "delete":
        callbacks.onDelete(messageId);
        break;
      case "branch":
        callbacks.onBranch(messageId);
        break;
      case "regenerate":
        callbacks.onRegenerate(messageId);
        break;
    }
  }
}
