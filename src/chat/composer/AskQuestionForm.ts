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
  panelEl: HTMLElement;
  tabEl: HTMLButtonElement;
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

interface RenderedForm {
  formEl: HTMLFormElement;
  errorEl: HTMLElement;
  submitButton: HTMLButtonElement;
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
  private activeQuestionIndex = 0;

  constructor(
    private readonly dependencies: AskQuestionFormDependencies,
    private readonly refs: AskQuestionFormRefs,
    private readonly callbacks: AskQuestionFormCallbacks,
  ) {
    this.formId = `lmsa-ask-form-${++nextFormId}`;
    this.state = createAskAnswerState(dependencies.request);
    const rendered = this.renderForm();
    this.formEl = rendered.formEl;
    this.errorEl = rendered.errorEl;
    this.submitButton = rendered.submitButton;
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

  private renderForm(): RenderedForm {
    const formEl = this.refs.containerEl.createEl("form", {
      cls: "lmsa-ask-form",
      attr: {
        "aria-label": "Answer questions from the writing assistant",
        novalidate: "true",
      },
    });
    const tabsEl = formEl.createDiv({
      cls: "lmsa-ask-form-tabs",
      attr: {
        role: "tablist",
        "aria-label": "Questions",
      },
    });
    const questionsEl = formEl.createDiv({ cls: "lmsa-ask-form-questions" });
    const tabs = this.dependencies.request.questions.map((question, index) =>
      this.renderTab(tabsEl, question, index),
    );
    this.dependencies.request.questions.forEach((question, index) => {
      this.questionRefs.push(
        this.renderQuestion(
          questionsEl,
          question,
          index,
          this.dependencies.request.questions.length,
          tabs[index],
        ),
      );
    });
    const errorEl = this.renderError(formEl);
    const submitButton = this.renderSubmit(formEl);
    return {
      formEl,
      errorEl,
      submitButton,
    };
  }

  private renderTab(
    containerEl: HTMLElement,
    question: ValidatedAskQuestion,
    questionIndex: number,
  ): HTMLButtonElement {
    const tabId = `${this.formId}-tab-${questionIndex}`;
    const panelId = `${this.formId}-panel-${questionIndex}`;
    const tabEl = containerEl.createEl("button", {
      cls: "lmsa-ask-form-tab",
      attr: {
        type: "button",
        id: tabId,
        role: "tab",
        "aria-controls": panelId,
        "aria-selected": "false",
        tabindex: "-1",
      },
    });
    tabEl.createSpan({
      cls: "lmsa-ask-form-tab-number",
      text: String(questionIndex + 1),
      attr: { "aria-hidden": "true" },
    });
    tabEl.createSpan({
      cls: "lmsa-ask-form-tab-label",
      text: question.header,
      attr: { "aria-hidden": "true" },
    });
    tabEl.createSpan({
      cls: "lmsa-ask-form-tab-status",
      attr: { "aria-hidden": "true" },
    });
    this.controls.push(tabEl);
    this.listen(tabEl, "click", () => this.showQuestion(questionIndex));
    this.listen(tabEl, "keydown", (event) => {
      this.onTabKeydown(event as KeyboardEvent, questionIndex);
    });
    return tabEl;
  }

  private renderQuestion(
    containerEl: HTMLElement,
    question: ValidatedAskQuestion,
    questionIndex: number,
    questionCount: number,
    tabEl: HTMLButtonElement,
  ): QuestionFormRefs {
    const panelEl = containerEl.createDiv({
      cls: "lmsa-ask-form-question-panel",
      attr: {
        id: `${this.formId}-panel-${questionIndex}`,
        role: "tabpanel",
        "aria-labelledby": `${this.formId}-tab-${questionIndex}`,
      },
    });
    const fieldsetEl = panelEl.createEl("fieldset", {
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
      panelEl,
      tabEl,
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

    const textWrap = rowEl.createDiv({ cls: "lmsa-ask-form-other-text" });
    textWrap.hidden = true;
    const textarea = textWrap.createEl("textarea", {
      cls: "lmsa-ask-form-other-textarea",
      attr: {
        id: textId,
        "aria-label": "Other answer",
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

  private renderError(formEl: HTMLFormElement): HTMLElement {
    return formEl.createDiv({
      cls: "lmsa-ask-form-error lmsa-hidden",
      attr: {
        role: "alert",
        "aria-live": "assertive",
      },
    });
  }

  private renderSubmit(formEl: HTMLFormElement): HTMLButtonElement {
    const actionsEl = formEl.createDiv({
      cls: "lmsa-ask-form-actions",
    });
    const submitButton = actionsEl.createEl("button", {
      cls: "lmsa-ui-btn lmsa-ui-btn-primary lmsa-ask-form-submit",
      text: "Submit answers",
      attr: { type: "submit" },
    });
    this.controls.push(submitButton);
    return submitButton;
  }

  private refresh(): void {
    const completeness = getAskAnswerCompleteness(
      this.dependencies.request,
      this.state,
    );
    const questionCount = this.questionRefs.length;
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
      const active = questionIndex === this.activeQuestionIndex;
      refs.panelEl.hidden = !active;
      refs.tabEl.toggleClass("is-active", active);
      refs.tabEl.toggleClass("is-complete", complete);
      refs.tabEl.setAttribute("aria-selected", active ? "true" : "false");
      refs.tabEl.setAttribute("tabindex", active ? "0" : "-1");
      refs.tabEl.setAttribute(
        "aria-label",
        `Question ${questionIndex + 1} of ${questionCount}: ${
          this.dependencies.request.questions[questionIndex].header
        }. ${complete ? "Answered" : "Unanswered"}`,
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
    this.showQuestion(questionIndex, true);
  }

  private showQuestion(questionIndex: number, focusControl = false): void {
    if (
      this.disabled ||
      questionIndex < 0 ||
      questionIndex >= this.questionRefs.length
    ) {
      return;
    }
    this.activeQuestionIndex = questionIndex;
    this.refresh();
    if (focusControl) {
      this.questionRefs[questionIndex]?.firstControl.focus();
    }
  }

  private onTabKeydown(event: KeyboardEvent, questionIndex: number): void {
    let nextIndex: number | null = null;
    if (event.key === "ArrowLeft") {
      nextIndex =
        (questionIndex - 1 + this.questionRefs.length) %
        this.questionRefs.length;
    } else if (event.key === "ArrowRight") {
      nextIndex = (questionIndex + 1) % this.questionRefs.length;
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = this.questionRefs.length - 1;
    }
    if (nextIndex === null) return;
    event.preventDefault();
    this.showQuestion(nextIndex);
    this.questionRefs[nextIndex]?.tabEl.focus();
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
