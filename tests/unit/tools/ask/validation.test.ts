import { describe, expect, it } from "vitest";
import {
  ASK_USER_LIMITS,
  validateAskAnswers,
  validateAskRequest,
} from "../../../../src/tools/ask/validation";
import type { ValidatedAskRequest } from "../../../../src/tools/ask/types";

function rawQuestion(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    question: "Which output shape should I optimize for?",
    header: "Output",
    options: [
      { label: "Concise", description: "Keep the answer brief." },
      { label: "Detailed", description: "Include rationale and examples." },
    ],
    multiSelect: false,
    ...overrides,
  };
}

function validRequest(overrides: Record<string, unknown> = {}): ValidatedAskRequest {
  const result = validateAskRequest({ questions: [rawQuestion(overrides)] });
  if (!result.ok) throw new Error(result.message);
  return result.value;
}

function expectRequestCode(input: unknown, code: string): void {
  const result = validateAskRequest(input);
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.code).toBe(code);
}

function expectAnswerCode(
  request: ValidatedAskRequest,
  input: unknown,
  code: string,
): void {
  const result = validateAskAnswers(request, input);
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.code).toBe(code);
}

describe("validateAskRequest", () => {
  it("accepts one through four questions and rejects other counts", () => {
    for (const count of [1, 2, 3, 4]) {
      expect(validateAskRequest({ questions: Array.from({ length: count }, (_, i) =>
        rawQuestion({ question: `Question ${i + 1}?` }),
      ) }).ok).toBe(true);
    }
    expectRequestCode({ questions: [] }, "questions_count");
    expectRequestCode({ questions: Array.from({ length: 5 }, (_, i) =>
      rawQuestion({ question: `Question ${i + 1}?` }),
    ) }, "questions_count");
    expectRequestCode({}, "questions_count");
  });

  it("trims boundary whitespace without rewriting authored copy", () => {
    const result = validateAskRequest({
      questions: [
        rawQuestion({
          question: "  Keep  internal   spacing?  ",
          header: "  Shape ",
          options: [
            { label: "  First choice ", description: "  Preserve  this spacing.  " },
            { label: "Second", description: " Another choice. " },
          ],
        }),
      ],
    });
    expect(result).toMatchObject({
      ok: true,
      value: {
        questions: [{
          question: "Keep  internal   spacing?",
          header: "Shape",
          options: [
            { label: "First choice", description: "Preserve  this spacing." },
            { label: "Second", description: "Another choice." },
          ],
        }],
      },
    });
  });

  it("rejects empty, multiline, duplicate, and oversized questions", () => {
    expectRequestCode({ questions: [rawQuestion({ question: "  " })] }, "question_empty");
    expectRequestCode({ questions: [rawQuestion({ question: "Line one\nLine two" })] }, "question_multiline");
    expectRequestCode({
      questions: [
        rawQuestion({ question: "Choose a shape?" }),
        rawQuestion({ question: "  choose A SHAPE?  " }),
      ],
    }, "question_duplicate");
    expectRequestCode({
      questions: [rawQuestion({ question: "😀".repeat(ASK_USER_LIMITS.question + 1) })],
    }, "field_too_long");
    expect(validateAskRequest({
      questions: [rawQuestion({ question: "😀".repeat(ASK_USER_LIMITS.question) })],
    }).ok).toBe(true);
  });

  it("rejects invalid and oversized headers", () => {
    for (const header of ["", "  ", "Line\nbreak", 42]) {
      expectRequestCode({ questions: [rawQuestion({ header })] }, "header_invalid");
    }
    expectRequestCode({
      questions: [rawQuestion({ header: "😀".repeat(ASK_USER_LIMITS.header + 1) })],
    }, "field_too_long");
    expect(validateAskRequest({
      questions: [rawQuestion({ header: "😀".repeat(ASK_USER_LIMITS.header) })],
    }).ok).toBe(true);
  });

  it("accepts two through four options and rejects other counts", () => {
    const option = (i: number) => ({ label: `Choice ${i}`, description: `Choice ${i}.` });
    for (const count of [2, 3, 4]) {
      expect(validateAskRequest({
        questions: [rawQuestion({ options: Array.from({ length: count }, (_, i) => option(i)) })],
      }).ok).toBe(true);
    }
    expectRequestCode({ questions: [rawQuestion({ options: [option(1)] })] }, "options_count");
    expectRequestCode({
      questions: [rawQuestion({ options: Array.from({ length: 5 }, (_, i) => option(i)) })],
    }, "options_count");
  });

  it("validates labels, descriptions, duplicate normalization, and reserved Other", () => {
    expectRequestCode({
      questions: [rawQuestion({
        options: [
          { label: "", description: "Blank label." },
          { label: "Second", description: "Valid." },
        ],
      })],
    }, "option_label_invalid");
    expectRequestCode({
      questions: [rawQuestion({
        options: [
          { label: "Line\nbreak", description: "Multiline label." },
          { label: "Second", description: "Valid." },
        ],
      })],
    }, "option_label_invalid");
    expectRequestCode({
      questions: [rawQuestion({
        options: [
          { label: "Detailed", description: "First." },
          { label: " detailed ", description: "Duplicate." },
        ],
      })],
    }, "option_label_duplicate");
    expectRequestCode({
      questions: [rawQuestion({
        options: [
          { label: "Other", description: "Reserved." },
          { label: "Second", description: "Valid." },
        ],
      })],
    }, "option_label_reserved");
    expectRequestCode({
      questions: [rawQuestion({
        options: [
          { label: "First", description: "" },
          { label: "Second", description: "Valid." },
        ],
      })],
    }, "option_description_invalid");
    expectRequestCode({
      questions: [rawQuestion({
        options: [
          { label: "x".repeat(ASK_USER_LIMITS.optionLabel + 1), description: "Too long." },
          { label: "Second", description: "Valid." },
        ],
      })],
    }, "field_too_long");
    expectRequestCode({
      questions: [rawQuestion({
        options: [
          { label: "First", description: "😀".repeat(ASK_USER_LIMITS.optionDescription + 1) },
          { label: "Second", description: "Valid." },
        ],
      })],
    }, "field_too_long");
  });

  it("requires multiSelect to be a boolean", () => {
    expectRequestCode({
      questions: [rawQuestion({ multiSelect: "false" })],
    }, "multi_select_invalid");
  });
});

describe("validateAskAnswers", () => {
  it("accepts and orders single-select option and Other-only answers", () => {
    const request = validRequest();
    expect(validateAskAnswers(request, {
      "Which output shape should I optimize for?": " Detailed ",
    })).toEqual({
      ok: true,
      value: { "Which output shape should I optimize for?": "Detailed" },
    });
    expect(validateAskAnswers(request, {
      "Which output shape should I optimize for?": "  A custom\nanswer  ",
    })).toEqual({
      ok: true,
      value: { "Which output shape should I optimize for?": "A custom\nanswer" },
    });
  });

  it("accepts multi-select option-only, Other-only, and mixed answers", () => {
    const request = validRequest({ multiSelect: true });
    const key = "Which output shape should I optimize for?";
    for (const answer of [
      ["Concise", "Detailed"],
      ["Something else"],
      ["Concise", "Also include migration risks"],
    ]) {
      expect(validateAskAnswers(request, { [key]: answer })).toMatchObject({
        ok: true,
        value: { [key]: answer },
      });
    }
  });

  it("requires exactly one complete answer per question with the right value shape", () => {
    const single = validRequest();
    const multi = validRequest({ multiSelect: true });
    const key = "Which output shape should I optimize for?";
    expectAnswerCode(single, {}, "answer_incomplete");
    expectAnswerCode(single, { [key]: "" }, "answer_incomplete");
    expectAnswerCode(single, { [key]: ["Concise"] }, "answer_invalid");
    expectAnswerCode(multi, { [key]: "Concise" }, "answer_invalid");
    expectAnswerCode(multi, { [key]: [] }, "answer_incomplete");
    expectAnswerCode(single, { [key]: "Concise", Extra: "value" }, "answer_invalid");
  });

  it("rejects duplicate selections, multiple custom values, and the Other sentinel", () => {
    const request = validRequest({ multiSelect: true });
    const key = "Which output shape should I optimize for?";
    expectAnswerCode(request, { [key]: ["Concise", " concise "] }, "answer_invalid");
    expectAnswerCode(request, { [key]: ["Custom one", "Custom two"] }, "answer_invalid");
    expectAnswerCode(request, { [key]: ["Other"] }, "answer_incomplete");
  });

  it("enforces the per-question and aggregate custom-text limits by Unicode code point", () => {
    const key = "Which output shape should I optimize for?";
    const request = validRequest();
    expect(validateAskAnswers(request, {
      [key]: "😀".repeat(ASK_USER_LIMITS.otherText),
    }).ok).toBe(true);
    expectAnswerCode(request, {
      [key]: "😀".repeat(ASK_USER_LIMITS.otherText + 1),
    }, "answer_other_too_long");

    const manyResult = validateAskRequest({
      questions: Array.from({ length: 4 }, (_, i) =>
        rawQuestion({ question: `Question ${i + 1}?` })),
    });
    if (!manyResult.ok) throw new Error(manyResult.message);
    const answers = Object.fromEntries(
      manyResult.value.questions.map((question) => [
        question.question,
        "😀".repeat(ASK_USER_LIMITS.otherText),
      ]),
    );
    expect(validateAskAnswers(manyResult.value, answers).ok).toBe(true);
  });
});
