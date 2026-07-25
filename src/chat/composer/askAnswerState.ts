import type {
  AskAnswerValidationResult,
  AskAnswers,
  ValidatedAskRequest,
} from "../../tools/ask/types";
import {
  ASK_USER_LIMITS,
  validateAskAnswers,
} from "../../tools/ask/validation";

export interface AskQuestionAnswerState {
  selectedOptionIndexes: number[];
  otherSelected: boolean;
  otherText: string;
}

export interface AskAnswerState {
  questions: AskQuestionAnswerState[];
}

export type AskAnswerAction =
  | {
      type: "set-option";
      questionIndex: number;
      optionIndex: number;
      selected: boolean;
    }
  | {
      type: "set-other-selected";
      questionIndex: number;
      selected: boolean;
    }
  | {
      type: "set-other-text";
      questionIndex: number;
      text: string;
    };

export interface AskAnswerCompleteness {
  isComplete: boolean;
  firstIncompleteQuestionIndex: number | null;
  questions: boolean[];
}

export function createAskAnswerState(request: ValidatedAskRequest): AskAnswerState {
  return {
    questions: request.questions.map(() => ({
      selectedOptionIndexes: [],
      otherSelected: false,
      otherText: "",
    })),
  };
}

export function reduceAskAnswerState(
  request: ValidatedAskRequest,
  state: AskAnswerState,
  action: AskAnswerAction,
): AskAnswerState {
  const question = request.questions[action.questionIndex];
  const current = state.questions[action.questionIndex];
  if (!question || !current) return state;

  if (action.type === "set-option") {
    if (action.optionIndex < 0 || action.optionIndex >= question.options.length) {
      return state;
    }
    const selectedOptionIndexes = question.multiSelect
      ? toggleOption(current.selectedOptionIndexes, action.optionIndex, action.selected)
      : action.selected
        ? [action.optionIndex]
        : current.selectedOptionIndexes.filter((index) => index !== action.optionIndex);
    return updateQuestion(state, action.questionIndex, {
      ...current,
      selectedOptionIndexes,
      otherSelected: question.multiSelect ? current.otherSelected : false,
    });
  }

  if (action.type === "set-other-selected") {
    return updateQuestion(state, action.questionIndex, {
      ...current,
      otherSelected: action.selected,
      selectedOptionIndexes:
        action.selected && !question.multiSelect
          ? []
          : current.selectedOptionIndexes,
    });
  }

  return updateQuestion(state, action.questionIndex, {
    ...current,
    otherText: action.text,
  });
}

export function getAskAnswerCompleteness(
  request: ValidatedAskRequest,
  state: AskAnswerState,
): AskAnswerCompleteness {
  const questions = request.questions.map((question, index) =>
    isQuestionComplete(question.multiSelect, state.questions[index]),
  );
  const firstIncompleteQuestionIndex = questions.findIndex((complete) => !complete);
  return {
    isComplete: firstIncompleteQuestionIndex === -1,
    firstIncompleteQuestionIndex:
      firstIncompleteQuestionIndex === -1 ? null : firstIncompleteQuestionIndex,
    questions,
  };
}

export function buildAskAnswersFromState(
  request: ValidatedAskRequest,
  state: AskAnswerState,
): AskAnswerValidationResult {
  const answers: AskAnswers = {};
  for (let index = 0; index < request.questions.length; index++) {
    const question = request.questions[index];
    const questionState = state.questions[index];
    if (!questionState) continue;

    const authored = question.options
      .filter((_, optionIndex) =>
        questionState.selectedOptionIndexes.includes(optionIndex),
      )
      .map((option) => option.label);
    const custom = questionState.otherText.trim();
    answers[question.question] = question.multiSelect
      ? [
          ...authored,
          ...(questionState.otherSelected ? [custom] : []),
        ]
      : questionState.otherSelected
        ? custom
        : authored[0] ?? "";
  }
  return validateAskAnswers(request, answers);
}

function isQuestionComplete(
  multiSelect: boolean,
  state: AskQuestionAnswerState | undefined,
): boolean {
  if (!state) return false;
  const customTextLength = [...state.otherText.trim()].length;
  const hasValidOther =
    state.otherSelected &&
    customTextLength > 0 &&
    customTextLength <= ASK_USER_LIMITS.otherText;
  if (state.otherSelected && !hasValidOther) return false;
  if (multiSelect) {
    return state.selectedOptionIndexes.length > 0 || hasValidOther;
  }
  return state.selectedOptionIndexes.length === 1 || hasValidOther;
}

function toggleOption(
  indexes: number[],
  optionIndex: number,
  selected: boolean,
): number[] {
  const withoutOption = indexes.filter((index) => index !== optionIndex);
  return selected ? [...withoutOption, optionIndex] : withoutOption;
}

function updateQuestion(
  state: AskAnswerState,
  questionIndex: number,
  questionState: AskQuestionAnswerState,
): AskAnswerState {
  return {
    questions: state.questions.map((current, index) =>
      index === questionIndex ? questionState : current,
    ),
  };
}
