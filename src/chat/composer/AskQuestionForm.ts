import type {
  AskAnswers,
  ValidatedAskQuestion,
  ValidatedAskRequest,
} from "../../tools/ask/types";
import { ASK_USER_LIMITS } from "../../tools/ask/validation";
import {
  buildAskAnswersFromState,
  createAskAnswerState,
  getAskAnswerCompleteness,
  reduceAskAnswerState,
} from "./askAnswerState";
import type { AskAnswerState } from "./askAnswerState";

export interface AskQuestionFormDependencies {
  interactionId: string;
  request: ValidatedAskRequest;
}

export interface AskQuestionFormRefs {
  containerEl: HTMLElement;
}

export interface AskQuestionFormCallbacks {
  onSubmit: (answers: AskAnswers) => void;
}

interface QuestionFormRefs {
  fieldsetEl: HTMLFieldSetElement;
  optionInputs: HTMLInputElement[];
  otherInput: HTMLInputElement;
  otherTextWrapEl: HTMLElement;
  otherTextEl: HTMLTextAreaElement;
  firstControl: HTMLInputElement;
}

interface ListenerRegistration {
  target: EventTarget;
  type: string;
  listener: EventListener;
}

let nextFormId = 0;

export class AskQuestionForm {
  private readonly formId: string;
  private readonly formEl: HTMLFormElement;
  private readonly errorEl: HTMLElement;
  private readonly submitButton: HTMLButtonElement;
  private readonly questionRefs: QuestionFormRefs[] = [];
  private readonly controls: Array<
    HTMLInputElement | HTMLTextAreaElement | HTMLButtonElement
  > = [];
  private readonly listeners: ListenerRegistration[] = [];
  private state: AskAnswerState;
  private disabled = false;
  private destroyed = false;
  private showValidation = false;

  constructor(
    private readonly dependencies: AskQuestionFormDependencies,
    private readonly refs: AskQuestionFormRefs,
    private readonly callbacks: AskQuestionFormCallbacks,
  ) {
    this.formId = `lmsa-ask-form-${++nextFormId}`;
    this.state = createAskAnswerState(dependencies.request);
    this.formEl = this.renderForm();
    this.errorEl = this.renderError();
    this.submitButton = this.renderSubmit();
    this.listen(this.formEl, "submit", (event) => this.onSubmit(event));
    this.refresh();
    this.questionRefs[0]?.firstControl.focus();
  }

  disable(): void {
    if (this.disabled) return;
    this.disabled = true;
    for (const control of this.controls) control.disabled = true;
    this.formEl.setAttribute("aria-busy", "true");
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.disable();
    for (const { target, type, listener } of this.listeners) {
      target.removeEventListener(type, listener);
    }
    this.listeners.length = 0;
    this.formEl.remove();
  }

  private renderForm(): HTMLFormElement {
    const formEl = this.refs.containerEl.createEl("form", {
      cls: "lmsa-ask-form",
      attr: {
        "aria-label": "Answer questions from the writing assistant",
        novalidate: "true",
      },
    });
    const headingEl = formEl.createDiv({ cls: "lmsa-ask-form-heading" });
    headingEl.createDiv({
      cls: "lmsa-ask-form-title",
      text: "Your guidance is needed",
    });
    headingEl.createDiv({
      cls: "lmsa-ask-form-intro",
      text: "Review every question, then submit all answers together.",
    });
    formEl.createDiv({
      cls: "lmsa-ask-form-secrets",
      text: "Do not enter passwords, API keys, payment details, or other secrets.",
      attr: { role: "note" },
    });

    const questionsEl = formEl.createDiv({ cls: "lmsa-ask-form-questions" });
    this.dependencies.request.questions.forEach((question, index) => {
      this.questionRefs.push(
        this.renderQuestion(
          questionsEl,
          question,
          index,
          this.dependencies.request.questions.length,
        ),
      );
    });
    return formEl;
  }

  private renderQuestion(
    containerEl: HTMLElement,
    question: ValidatedAskQuestion,
    questionIndex: number,
    questionCount: number,
  ): QuestionFormRefs {
    const fieldsetEl = containerEl.createEl("fieldset", {
      cls: "lmsa-ask-form-question",
    });
    const legendEl = fieldsetEl.createEl("legend", {
      cls: "lmsa-ask-form-legend",
    });
    const metaEl = legendEl.createSpan({ cls: "lmsa-ask-form-question-meta" });
    metaEl.createSpan({
      cls: "lmsa-ask-form-question-number",
      text: `Question ${questionIndex + 1} of ${questionCount}`,
    });
    metaEl.createSpan({
      cls: "lmsa-ask-form-question-header",
      text: question.header,
    });
    legendEl.createSpan({
      cls: "lmsa-ask-form-question-text",
      text: question.question,
    });

    const optionsEl = fieldsetEl.createDiv({
      cls: "lmsa-ask-form-options",
    });
    const optionInputs = question.options.map((option, optionIndex) =>
      this.renderOption(optionsEl, question, questionIndex, optionIndex),
    );
    const other = this.renderOther(optionsEl, question, questionIndex);
    return {
      fieldsetEl,
      optionInputs,
      otherInput: other.input,
      otherTextWrapEl: other.textWrap,
      otherTextEl: other.textarea,
      firstControl: optionInputs[0],
    };
  }

  private renderOption(
    containerEl: HTMLElement,
    question: ValidatedAskQuestion,
    questionIndex: number,
    optionIndex: number,
  ): HTMLInputElement {
    const option = question.options[optionIndex];
    const inputId = `${this.formId}-q${questionIndex}-o${optionIndex}`;
    const descriptionId = `${inputId}-description`;
    const rowEl = containerEl.createDiv({ cls: "lmsa-ask-form-option" });
    const input = rowEl.createEl("input", {
      cls: "lmsa-ask-form-option-input",
      attr: {
        type: question.multiSelect ? "checkbox" : "radio",
        id: inputId,
        name: `${this.formId}-q${questionIndex}`,
        "aria-describedby": descriptionId,
      },
    });
    const labelEl = rowEl.createEl("label", {
      cls: "lmsa-ask-form-option-label",
      attr: { for: inputId },
    });
    labelEl.createSpan({
      cls: "lmsa-ask-form-option-name",
      text: option.label,
    });
    labelEl.createSpan({
      cls: "lmsa-ask-form-option-description",
      text: option.description,
      attr: { id: descriptionId },
    });
    this.controls.push(input);
    this.listen(input, "change", () => {
      this.state = reduceAskAnswerState(
        this.dependencies.request,
        this.state,
        {
          type: "set-option",
          questionIndex,
          optionIndex,
          selected: input.checked,
        },
      );
      this.refresh();
    });
    return input;
  }

  private renderOther(
    containerEl: HTMLElement,
    question: ValidatedAskQuestion,
    questionIndex: number,
  ): {
    input: HTMLInputElement;
    textWrap: HTMLElement;
    textarea: HTMLTextAreaElement;
  } {
    const inputId = `${this.formId}-q${questionIndex}-other`;
    const descriptionId = `${inputId}-description`;
    const textId = `${inputId}-text`;
    const rowEl = containerEl.createDiv({
      cls: "lmsa-ask-form-option lmsa-ask-form-other-option",
    });
    const input = rowEl.createEl("input", {
      cls: "lmsa-ask-form-option-input",
      attr: {
        type: question.multiSelect ? "checkbox" : "radio",
        id: inputId,
        name: `${this.formId}-q${questionIndex}`,
        "aria-describedby": descriptionId,
      },
    });
    const labelEl = rowEl.createEl("label", {
      cls: "lmsa-ask-form-option-label",
      attr: { for: inputId },
    });
    labelEl.createSpan({
      cls: "lmsa-ask-form-option-name",
      text: "Other",
    });
    labelEl.createSpan({
      cls: "lmsa-ask-form-option-description",
      text: "Write a different answer in your own words.",
      attr: { id: descriptionId },
    });

    const textWrap = rowEl.createDiv({ cls: "lmsa-ask-form-other-text" });
    textWrap.hidden = true;
    textWrap.createEl("label", {
      cls: "lmsa-ask-form-other-label",
      text: "Your answer",
      attr: { for: textId },
    });
    const textarea = textWrap.createEl("textarea", {
      cls: "lmsa-ask-form-other-textarea",
      attr: {
        id: textId,
        rows: "3",
        maxlength: String(ASK_USER_LIMITS.otherText),
        placeholder: "Type your answer",
      },
    });
    this.controls.push(input, textarea);
    this.listen(input, "change", () => {
      this.state = reduceAskAnswerState(
        this.dependencies.request,
        this.state,
        {
          type: "set-other-selected",
          questionIndex,
          selected: input.checked,
        },
      );
      this.refresh();
      if (input.checked) textarea.focus();
    });
    this.listen(textarea, "input", () => {
      this.state = reduceAskAnswerState(
        this.dependencies.request,
        this.state,
        {
          type: "set-other-text",
          questionIndex,
          text: textarea.value,
        },
      );
      this.refresh();
    });
    return { input, textWrap, textarea };
  }

  private renderError(): HTMLElement {
    return this.formEl.createDiv({
      cls: "lmsa-ask-form-error lmsa-hidden",
      attr: {
        role: "alert",
        "aria-live": "assertive",
      },
    });
  }

  private renderSubmit(): HTMLButtonElement {
    const actionsEl = this.formEl.createDiv({
      cls: "lmsa-ask-form-actions",
    });
    const button = actionsEl.createEl("button", {
      cls: "lmsa-ui-btn lmsa-ui-btn-primary lmsa-ask-form-submit",
      text: "Submit answers",
      attr: { type: "submit" },
    });
    this.controls.push(button);
    return button;
  }

  private refresh(): void {
    const completeness = getAskAnswerCompleteness(
      this.dependencies.request,
      this.state,
    );
    this.questionRefs.forEach((refs, questionIndex) => {
      const questionState = this.state.questions[questionIndex];
      refs.optionInputs.forEach((input, optionIndex) => {
        input.checked =
          questionState?.selectedOptionIndexes.includes(optionIndex) ?? false;
      });
      refs.otherInput.checked = questionState?.otherSelected ?? false;
      refs.otherTextWrapEl.hidden = !questionState?.otherSelected;
      refs.otherTextEl.disabled =
        this.disabled || !(questionState?.otherSelected ?? false);
      const complete = completeness.questions[questionIndex];
      refs.fieldsetEl.toggleClass("is-complete", complete);
      refs.fieldsetEl.toggleClass(
        "is-incomplete",
        this.showValidation && !complete,
      );
    });
    this.submitButton.disabled = this.disabled || !completeness.isComplete;
    if (completeness.isComplete) this.hideError();
  }

  private onSubmit(event: Event): void {
    event.preventDefault();
    if (this.disabled) return;
    const result = buildAskAnswersFromState(
      this.dependencies.request,
      this.state,
    );
    if (!result.ok) {
      this.showValidation = true;
      this.errorEl.setText(result.message);
      this.errorEl.removeClass("lmsa-hidden");
      this.refresh();
      this.focusFirstIncomplete();
      return;
    }
    this.disable();
    this.callbacks.onSubmit(result.value);
  }

  private focusFirstIncomplete(): void {
    const completeness = getAskAnswerCompleteness(
      this.dependencies.request,
      this.state,
    );
    const questionIndex = completeness.firstIncompleteQuestionIndex;
    if (questionIndex === null) return;
    this.questionRefs[questionIndex]?.firstControl.focus();
  }

  private hideError(): void {
    this.showValidation = false;
    this.errorEl.setText("");
    this.errorEl.addClass("lmsa-hidden");
  }

  private listen(
    target: EventTarget,
    type: string,
    listener: EventListener,
  ): void {
    target.addEventListener(type, listener);
    this.listeners.push({ target, type, listener });
  }
}
