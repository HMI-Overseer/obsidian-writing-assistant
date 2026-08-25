import { describe, expect, it } from "vitest";
import {
  ASK_USER_LIMITS,
  enforceAskQuestionLimit,
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
  it("accepts any question count above the floor and rejects an empty call", () => {
    // No ceiling here on purpose: the ceiling is the user's setting, applied by
    // enforceAskQuestionLimit at the live boundary, so replay stays parseable.
    for (const count of [1, 2, 4, 5, 40]) {
      expect(validateAskRequest({ questions: Array.from({ length: count }, (_, i) =>
        rawQuestion({ question: `Question ${i + 1}?` }),
      ) }).ok).toBe(true);
    }
    expectRequestCode({ questions: [] }, "questions_count");
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

  it("rejects empty, multiline, and duplicate questions, at any length", () => {
    expectRequestCode({ questions: [rawQuestion({ question: "  " })] }, "question_empty");
    expectRequestCode({ questions: [rawQuestion({ question: "Line one\nLine two" })] }, "question_multiline");
    expectRequestCode({
      questions: [
        rawQuestion({ question: "Choose a shape?" }),
        rawQuestion({ question: "  choose A SHAPE?  " }),
      ],
    }, "question_duplicate");
    expect(validateAskRequest({
      questions: [rawQuestion({ question: `Why?${"😀".repeat(5_000)}` })],
    }).ok).toBe(true);
  });

  it("rejects a blank or multiline header, at any length", () => {
    for (const header of ["", "  ", "Line\nbreak", 42]) {
      expectRequestCode({ questions: [rawQuestion({ header })] }, "header_invalid");
    }
    // A header this long makes for an absurd tab, and that is the model's business.
    expect(validateAskRequest({
      questions: [rawQuestion({ header: "😀".repeat(500) })],
    }).ok).toBe(true);
  });

  it("accepts any option count at or above the floor of two", () => {
    const option = (i: number) => ({ label: `Choice ${i}`, description: `Choice ${i}.` });
    for (const count of [2, 3, 4, 5, 12]) {
      expect(validateAskRequest({
        questions: [rawQuestion({ options: Array.from({ length: count }, (_, i) => option(i)) })],
      }).ok).toBe(true);
    }
    // The floor stays: one choice is not a choice, it is the rhetorical confirmation
    // the tool's guidance forbids.
    expectRequestCode({ questions: [rawQuestion({ options: [option(1)] })] }, "options_count");
    expectRequestCode({ questions: [rawQuestion({ options: [] })] }, "options_count");
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
    // Long is not invalid. A label or description may run as long as the model needs.
    expect(validateAskRequest({
      questions: [rawQuestion({
        options: [
          { label: `First ${"x".repeat(2_000)}`, description: "😀".repeat(5_000) },
          { label: "Second", description: "Valid." },
        ],
      })],
    }).ok).toBe(true);
  });

  it("requires multiSelect to be a boolean", () => {
    expectRequestCode({
      questions: [rawQuestion({ multiSelect: "false" })],
    }, "multi_select_invalid");
  });

  it("accepts a deliberately enormous request in full", () => {
    const glyph = "\u{1F9ED}";
    const result = validateAskRequest({
      questions: Array.from({ length: 12 }, (_, questionIndex) => ({
        // Zero-padded so every question is the same length and the assertions below
        // can be exact rather than approximate.
        question: `q${String(questionIndex).padStart(2, "0")}${glyph.repeat(2_000)}`,
        header: `h${String(questionIndex).padStart(2, "0")}${glyph.repeat(200)}`,
        options: Array.from({ length: 8 }, (_, optionIndex) => ({
          label: `l${String(questionIndex).padStart(2, "0")}${optionIndex}${glyph.repeat(400)}`,
          description: `d${String(questionIndex).padStart(2, "0")}${optionIndex}${glyph.repeat(3_000)}`,
        })),
        multiSelect: questionIndex % 2 === 1,
      })),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.questions).toHaveLength(12);
    for (const question of result.value.questions) {
      expect(question.options).toHaveLength(8);
      expect([...question.question]).toHaveLength(2_003);
      expect([...question.header]).toHaveLength(203);
      for (const option of question.options) {
        expect([...option.label]).toHaveLength(404);
        expect([...option.description]).toHaveLength(3_004);
      }
    }
  });
});

describe("enforceAskQuestionLimit", () => {
  function requestOf(count: number): ValidatedAskRequest {
    const result = validateAskRequest({
      questions: Array.from({ length: count }, (_, i) =>
        rawQuestion({ question: `Question ${i + 1}?` })),
    });
    if (!result.ok) throw new Error(result.message);
    return result.value;
  }

  it("passes a request at or under the configured ceiling", () => {
    expect(enforceAskQuestionLimit(requestOf(1), 4)).toBeNull();
    expect(enforceAskQuestionLimit(requestOf(4), 4)).toBeNull();
    expect(enforceAskQuestionLimit(requestOf(9), 12)).toBeNull();
    // A raised ceiling is honoured, which is the point of making it a setting.
    expect(enforceAskQuestionLimit(requestOf(20), 20)).toBeNull();
  });

  it("refuses a request over the ceiling and names both numbers", () => {
    const failure = enforceAskQuestionLimit(requestOf(5), 4);
    expect(failure?.code).toBe("questions_count");
    expect(failure?.message).toContain("at most 4 entries");
    expect(failure?.message).toContain("carried 5");

    const singular = enforceAskQuestionLimit(requestOf(2), 1);
    expect(singular?.message).toContain("at most 1 entry");
  });

  it("is absent from validateAskRequest, so replay survives a lowered ceiling", () => {
    // The regression this guards: a conversation answered under a ceiling of 10 must
    // still parse after the user drops the setting to 2.
    expect(validateAskRequest({
      questions: Array.from({ length: 10 }, (_, i) =>
        rawQuestion({ question: `Question ${i + 1}?` })),
    }).ok).toBe(true);
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

  it("accepts a long, specific Other answer at every layer that touches it", () => {
    const key = "Which output shape should I optimize for?";
    const single = validRequest();
    const multi = validRequest({ multiSelect: true });
    // Far past the 500-code-point cap this tool used to impose, and astral so the
    // count differs from the UTF-16 length an HTML maxlength would have counted.
    const essay = "\u{1F600}".repeat(5_000);
    expect([...essay].length).toBe(5_000);

    expect(validateAskAnswers(single, { [key]: essay })).toMatchObject({
      ok: true,
      value: { [key]: essay },
    });
    expect(validateAskAnswers(multi, { [key]: ["Concise", essay] })).toMatchObject({
      ok: true,
      value: { [key]: ["Concise", essay] },
    });

    // Several maximal answers together, the case the retired aggregate cap rejected.
    const manyResult = validateAskRequest({
      questions: Array.from({ length: 4 }, (_, i) =>
        rawQuestion({ question: `Question ${i + 1}?` })),
    });
    if (!manyResult.ok) throw new Error(manyResult.message);
    const answers = Object.fromEntries(
      manyResult.value.questions.map((question) => [question.question, essay]),
    );
    expect(validateAskAnswers(manyResult.value, answers).ok).toBe(true);
  });

  it("leaves no length ceiling anywhere in the limits object", () => {
    // The floor is all that survives. If a length key ever reappears here, some field
    // has quietly regrown a cap.
    expect(Object.keys(ASK_USER_LIMITS)).toEqual(["minOptions"]);
    expect(ASK_USER_LIMITS.minOptions).toBe(2);
  });
});
