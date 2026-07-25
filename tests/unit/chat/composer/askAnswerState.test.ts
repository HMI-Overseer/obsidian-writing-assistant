import { describe, expect, it } from "vitest";
import type { ValidatedAskRequest } from "../../../../src/tools/ask/types";
import {
  buildAskAnswersFromState,
  createAskAnswerState,
  getAskAnswerCompleteness,
  reduceAskAnswerState,
} from "../../../../src/chat/composer/askAnswerState";

const REQUEST: ValidatedAskRequest = {
  questions: [
    {
      question: "Which output shape should I optimize for?",
      header: "Output",
      options: [
        { label: "Concise", description: "Keep the result brief." },
        { label: "Detailed", description: "Include rationale and examples." },
      ],
      multiSelect: false,
    },
    {
      question: "Which areas should I cover?",
      header: "Coverage",
      options: [
        { label: "Testing", description: "Cover test design." },
        { label: "Migration", description: "Cover migration concerns." },
        { label: "Accessibility", description: "Cover accessible interaction." },
      ],
      multiSelect: true,
    },
  ],
};

describe("ask answer state", () => {
  it("starts empty and reports the first incomplete question", () => {
    const state = createAskAnswerState(REQUEST);

    expect(state.questions).toEqual([
      { selectedOptionIndexes: [], otherSelected: false, otherText: "" },
      { selectedOptionIndexes: [], otherSelected: false, otherText: "" },
    ]);
    expect(getAskAnswerCompleteness(REQUEST, state)).toEqual({
      isComplete: false,
      firstIncompleteQuestionIndex: 0,
      questions: [false, false],
    });
  });

  it("applies single-select transitions without mutating the prior state", () => {
    const initial = createAskAnswerState(REQUEST);
    const concise = reduceAskAnswerState(REQUEST, initial, {
      type: "set-option",
      questionIndex: 0,
      optionIndex: 0,
      selected: true,
    });
    const detailed = reduceAskAnswerState(REQUEST, concise, {
      type: "set-option",
      questionIndex: 0,
      optionIndex: 1,
      selected: true,
    });

    expect(initial.questions[0].selectedOptionIndexes).toEqual([]);
    expect(concise.questions[0].selectedOptionIndexes).toEqual([0]);
    expect(detailed.questions[0].selectedOptionIndexes).toEqual([1]);
  });

  it("makes selected Other text required and trims it in the submitted answer", () => {
    let state = createAskAnswerState(REQUEST);
    state = reduceAskAnswerState(REQUEST, state, {
      type: "set-option",
      questionIndex: 0,
      optionIndex: 0,
      selected: true,
    });
    state = reduceAskAnswerState(REQUEST, state, {
      type: "set-other-selected",
      questionIndex: 0,
      selected: true,
    });

    expect(state.questions[0].selectedOptionIndexes).toEqual([]);
    expect(getAskAnswerCompleteness(REQUEST, state).questions[0]).toBe(false);

    state = reduceAskAnswerState(REQUEST, state, {
      type: "set-other-text",
      questionIndex: 0,
      text: "  A comparison table  ",
    });
    expect(getAskAnswerCompleteness(REQUEST, state).questions[0]).toBe(true);

    state = reduceAskAnswerState(REQUEST, state, {
      type: "set-option",
      questionIndex: 1,
      optionIndex: 0,
      selected: true,
    });
    expect(buildAskAnswersFromState(REQUEST, state)).toEqual({
      ok: true,
      value: {
        "Which output shape should I optimize for?": "A comparison table",
        "Which areas should I cover?": ["Testing"],
      },
    });
  });

  it("orders multi-select output by authored option order with Other last", () => {
    let state = createAskAnswerState(REQUEST);
    state = reduceAskAnswerState(REQUEST, state, {
      type: "set-option",
      questionIndex: 0,
      optionIndex: 1,
      selected: true,
    });
    state = reduceAskAnswerState(REQUEST, state, {
      type: "set-option",
      questionIndex: 1,
      optionIndex: 2,
      selected: true,
    });
    state = reduceAskAnswerState(REQUEST, state, {
      type: "set-option",
      questionIndex: 1,
      optionIndex: 0,
      selected: true,
    });
    state = reduceAskAnswerState(REQUEST, state, {
      type: "set-other-selected",
      questionIndex: 1,
      selected: true,
    });
    state = reduceAskAnswerState(REQUEST, state, {
      type: "set-other-text",
      questionIndex: 1,
      text: "  Include keyboard-only failure modes  ",
    });

    expect(getAskAnswerCompleteness(REQUEST, state).isComplete).toBe(true);
    expect(buildAskAnswersFromState(REQUEST, state)).toEqual({
      ok: true,
      value: {
        "Which output shape should I optimize for?": "Detailed",
        "Which areas should I cover?": [
          "Testing",
          "Accessibility",
          "Include keyboard-only failure modes",
        ],
      },
    });
  });

  it("retains draft Other text when deselected but omits it from output", () => {
    let state = createAskAnswerState(REQUEST);
    state = reduceAskAnswerState(REQUEST, state, {
      type: "set-option",
      questionIndex: 0,
      optionIndex: 0,
      selected: true,
    });
    state = reduceAskAnswerState(REQUEST, state, {
      type: "set-option",
      questionIndex: 1,
      optionIndex: 1,
      selected: true,
    });
    state = reduceAskAnswerState(REQUEST, state, {
      type: "set-other-selected",
      questionIndex: 1,
      selected: true,
    });
    state = reduceAskAnswerState(REQUEST, state, {
      type: "set-other-text",
      questionIndex: 1,
      text: "Keep this local draft",
    });
    state = reduceAskAnswerState(REQUEST, state, {
      type: "set-other-selected",
      questionIndex: 1,
      selected: false,
    });

    expect(state.questions[1].otherText).toBe("Keep this local draft");
    expect(buildAskAnswersFromState(REQUEST, state)).toEqual({
      ok: true,
      value: {
        "Which output shape should I optimize for?": "Concise",
        "Which areas should I cover?": ["Migration"],
      },
    });
  });
});
