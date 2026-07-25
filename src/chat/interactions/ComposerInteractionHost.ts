import type {
  AskAnswers,
  ValidatedAskRequest,
} from "../../tools/ask/types";
import { AskQuestionForm } from "../composer/AskQuestionForm";
import type { ChatLayoutRefs } from "../types";

export type ComposerInteraction = {
  kind: "ask";
  interactionId: string;
  request: ValidatedAskRequest;
  onSubmit: (answers: AskAnswers) => void;
  onCancel: () => void;
};

export interface ComposerInteractionHostPort {
  mount(interaction: ComposerInteraction): boolean;
  clearIfOwner(interactionId: string): void;
  isActive(interactionId?: string): boolean;
  destroy(): void;
}

type ComposerInteractionHostRefs = Pick<
  ChatLayoutRefs,
  | "composerPanelEl"
  | "composerNormalBodyEl"
  | "composerInteractionEl"
  | "composerFooterEl"
  | "textareaEl"
  | "actionBtn"
>;

interface ActiveInteraction {
  interaction: ComposerInteraction;
  form: AskQuestionForm;
}

export class ComposerInteractionHost implements ComposerInteractionHostPort {
  private active: ActiveInteraction | null = null;
  private destroyed = false;

  constructor(private readonly refs: ComposerInteractionHostRefs) {
    this.setInteractionVisible(false);
  }

  mount(interaction: ComposerInteraction): boolean {
    if (this.destroyed || this.active) return false;

    this.setInteractionVisible(true);
    try {
      const form = new AskQuestionForm(
        {
          interactionId: interaction.interactionId,
          request: interaction.request,
        },
        {
          containerEl: this.refs.composerInteractionEl,
        },
        {
          onSubmit: interaction.onSubmit,
        },
      );
      this.active = { interaction, form };
      return true;
    } catch (error) {
      this.setInteractionVisible(false);
      this.refs.composerInteractionEl.empty();
      throw error;
    }
  }

  clearIfOwner(interactionId: string): void {
    if (this.active?.interaction.interactionId !== interactionId) return;
    this.clearActive();
  }

  isActive(interactionId?: string): boolean {
    if (!this.active) return false;
    return (
      interactionId === undefined ||
      this.active.interaction.interactionId === interactionId
    );
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    const active = this.active;
    this.clearActive();
    active?.interaction.onCancel();
  }

  private clearActive(): void {
    const active = this.active;
    if (!active) {
      this.setInteractionVisible(false);
      return;
    }
    this.active = null;
    active.form.disable();
    active.form.destroy();
    this.refs.composerInteractionEl.empty();
    this.setInteractionVisible(false);
    if (this.refs.actionBtn.isConnected) {
      this.refs.actionBtn.focus();
    } else if (this.refs.textareaEl.isConnected) {
      this.refs.textareaEl.focus();
    }
  }

  private setInteractionVisible(visible: boolean): void {
    this.refs.composerPanelEl.toggleClass("is-interacting", visible);
    this.refs.composerPanelEl.toggleClass("is-ask-interaction", visible);
    this.refs.composerFooterEl.toggleClass("is-interacting", visible);

    this.refs.composerNormalBodyEl.hidden = false;
    this.refs.composerNormalBodyEl.setAttribute(
      "aria-hidden",
      visible ? "true" : "false",
    );
    if (visible) {
      this.refs.composerNormalBodyEl.setAttribute("inert", "");
    } else {
      this.refs.composerNormalBodyEl.removeAttribute("inert");
    }
    this.refs.composerInteractionEl.hidden = !visible;
    this.refs.composerInteractionEl.setAttribute(
      "aria-hidden",
      visible ? "false" : "true",
    );
  }
}
