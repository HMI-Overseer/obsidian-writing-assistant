import type {
  AskAnswers,
  AskAnswerValidationResult,
  AskRequestValidationResult,
  AskValidationCode,
  AskValidationFailure,
  ValidatedAskOption,
  ValidatedAskQuestion,
  ValidatedAskRequest,
} from "./types";

export const ASK_USER_LIMITS = {
  questions: 4,
  question: 300,
  header: 12,
  options: 4,
  optionLabel: 40,
  optionDescription: 200,
  otherText: 500,
  customTextTotal: 2000,
} as const;

const LINE_BREAK = /[\r\n\u2028\u2029]/u;
const OTHER_IDENTITY = "other";

export function validateAskRequest(input: unknown): AskRequestValidationResult {
  if (!isRecord(input) || !Array.isArray(input.questions)) {
    return failure("questions_count", "questions must contain one to four entries.");
  }
  if (input.questions.length < 1 || input.questions.length > ASK_USER_LIMITS.questions) {
    return failure("questions_count", "questions must contain one to four entries.");
  }

  const questions: ValidatedAskQuestion[] = [];
  const questionIdentities = new Set<string>();
  for (let index = 0; index < input.questions.length; index++) {
    const questionResult = validateQuestion(input.questions[index], index);
    if (!questionResult.ok) return questionResult;

    const identity = normalizeIdentity(questionResult.value.question);
    if (questionIdentities.has(identity)) {
      return failure(
        "question_duplicate",
        `Question ${index + 1} duplicates another question after trimming and case folding.`,
      );
    }
    questionIdentities.add(identity);
    questions.push(questionResult.value);
  }

  return { ok: true, value: { questions } };
}

export function validateAskAnswers(
  request: ValidatedAskRequest,
  input: unknown,
): AskAnswerValidationResult {
  if (!isRecord(input)) {
    return failure("answer_incomplete", "Submit one answer for every question.");
  }

  const expectedKeys = new Set(request.questions.map((question) => question.question));
  if (Object.keys(input).some((key) => !expectedKeys.has(key))) {
    return failure("answer_invalid", "Answers contain a question that was not asked.");
  }

  const answers: AskAnswers = {};
  let customTextTotal = 0;
  for (const question of request.questions) {
    if (!Object.prototype.hasOwnProperty.call(input, question.question)) {
      return failure(
        "answer_incomplete",
        `Answer the question "${question.question}" before submitting.`,
      );
    }

    const answerResult = question.multiSelect
      ? validateMultiAnswer(question, input[question.question])
      : validateSingleAnswer(question, input[question.question]);
    if (!answerResult.ok) return answerResult;

    answers[question.question] = answerResult.value.answer;
    customTextTotal += answerResult.value.customTextLength;
  }

  if (customTextTotal > ASK_USER_LIMITS.customTextTotal) {
    return failure(
      "answer_custom_total_too_long",
      `Custom answers must total at most ${ASK_USER_LIMITS.customTextTotal} Unicode code points.`,
    );
  }
  return { ok: true, value: answers };
}

type QuestionResult =
  | { ok: true; value: ValidatedAskQuestion }
  | AskValidationFailure;

function validateQuestion(input: unknown, index: number): QuestionResult {
  if (!isRecord(input)) {
    return failure("question_empty", `Question ${index + 1} must be an object with text.`);
  }

  const question = trimmedString(input.question);
  if (!question) {
    return failure("question_empty", `Question ${index + 1} must not be empty.`);
  }
  if (LINE_BREAK.test(question)) {
    return failure("question_multiline", `Question ${index + 1} must fit on one line.`);
  }
  if (codePointLength(question) > ASK_USER_LIMITS.question) {
    return tooLong(`Question ${index + 1}`, ASK_USER_LIMITS.question);
  }

  const header = trimmedString(input.header);
  if (!header || LINE_BREAK.test(header)) {
    return failure(
      "header_invalid",
      `Question ${index + 1} header must be a non-empty single line.`,
    );
  }
  if (codePointLength(header) > ASK_USER_LIMITS.header) {
    return tooLong(`Question ${index + 1} header`, ASK_USER_LIMITS.header);
  }

  const optionsResult = validateOptions(input.options, index);
  if (!optionsResult.ok) return optionsResult;
  if (typeof input.multiSelect !== "boolean") {
    return failure(
      "multi_select_invalid",
      `Question ${index + 1} multiSelect must be a boolean.`,
    );
  }

  return {
    ok: true,
    value: {
      question,
      header,
      options: optionsResult.value,
      multiSelect: input.multiSelect,
    },
  };
}

type OptionsResult =
  | { ok: true; value: ValidatedAskOption[] }
  | AskValidationFailure;

function validateOptions(input: unknown, questionIndex: number): OptionsResult {
  if (
    !Array.isArray(input) ||
    input.length < 2 ||
    input.length > ASK_USER_LIMITS.options
  ) {
    return failure(
      "options_count",
      `Question ${questionIndex + 1} must contain two to four options.`,
    );
  }

  const options: ValidatedAskOption[] = [];
  const identities = new Set<string>();
  for (let optionIndex = 0; optionIndex < input.length; optionIndex++) {
    const raw: unknown = (input as unknown[])[optionIndex];
    if (!isRecord(raw)) {
      return failure(
        "option_label_invalid",
        `Question ${questionIndex + 1} option ${optionIndex + 1} must be an object.`,
      );
    }

    const label = trimmedString(raw.label);
    if (!label || LINE_BREAK.test(label)) {
      return failure(
        "option_label_invalid",
        `Question ${questionIndex + 1} option ${optionIndex + 1} label must be a non-empty single line.`,
      );
    }
    if (codePointLength(label) > ASK_USER_LIMITS.optionLabel) {
      return tooLong(
        `Question ${questionIndex + 1} option ${optionIndex + 1} label`,
        ASK_USER_LIMITS.optionLabel,
      );
    }

    const identity = normalizeIdentity(label);
    if (identity === OTHER_IDENTITY) {
      return failure(
        "option_label_reserved",
        `Question ${questionIndex + 1} option ${optionIndex + 1} uses the reserved label Other.`,
      );
    }
    if (identities.has(identity)) {
      return failure(
        "option_label_duplicate",
        `Question ${questionIndex + 1} has duplicate option labels after trimming and case folding.`,
      );
    }
    identities.add(identity);

    const description = trimmedString(raw.description);
    if (!description) {
      return failure(
        "option_description_invalid",
        `Question ${questionIndex + 1} option ${optionIndex + 1} description must not be empty.`,
      );
    }
    if (codePointLength(description) > ASK_USER_LIMITS.optionDescription) {
      return tooLong(
        `Question ${questionIndex + 1} option ${optionIndex + 1} description`,
        ASK_USER_LIMITS.optionDescription,
      );
    }
    options.push({ label, description });
  }
  return { ok: true, value: options };
}

type AnswerValueResult =
  | {
      ok: true;
      value: {
        answer: string | string[];
        customTextLength: number;
      };
    }
  | AskValidationFailure;

function validateSingleAnswer(
  question: ValidatedAskQuestion,
  input: unknown,
): AnswerValueResult {
  if (typeof input !== "string") {
    return failure(
      "answer_invalid",
      `The answer to "${question.question}" must be one string.`,
    );
  }
  const value = input.trim();
  if (!value || normalizeIdentity(value) === OTHER_IDENTITY) {
    return failure(
      "answer_incomplete",
      `Choose an option or enter custom text for "${question.question}".`,
    );
  }

  const isCustom = !optionIdentities(question).has(normalizeIdentity(value));
  if (isCustom && codePointLength(value) > ASK_USER_LIMITS.otherText) {
    return failure(
      "answer_other_too_long",
      `Custom text for "${question.question}" must be at most ${ASK_USER_LIMITS.otherText} Unicode code points.`,
    );
  }
  return {
    ok: true,
    value: {
      answer: value,
      customTextLength: isCustom ? codePointLength(value) : 0,
    },
  };
}

function validateMultiAnswer(
  question: ValidatedAskQuestion,
  input: unknown,
): AnswerValueResult {
  if (!Array.isArray(input)) {
    return failure(
      "answer_invalid",
      `The answer to "${question.question}" must be an array of strings.`,
    );
  }
  if (input.length === 0) {
    return failure(
      "answer_incomplete",
      `Choose at least one option or enter custom text for "${question.question}".`,
    );
  }
  if (input.length > question.options.length + 1) {
    return failure(
      "answer_invalid",
      `The answer to "${question.question}" contains too many selections.`,
    );
  }

  const values: string[] = [];
  const seen = new Set<string>();
  const authoredOptions = optionIdentities(question);
  let customCount = 0;
  let customTextLength = 0;
  for (const raw of input) {
    if (typeof raw !== "string") {
      return failure(
        "answer_invalid",
        `Every selection for "${question.question}" must be a string.`,
      );
    }
    const value = raw.trim();
    const identity = normalizeIdentity(value);
    if (!value || identity === OTHER_IDENTITY) {
      return failure(
        "answer_incomplete",
        `Enter custom text when Other is selected for "${question.question}".`,
      );
    }
    if (seen.has(identity)) {
      return failure(
        "answer_invalid",
        `The answer to "${question.question}" contains a duplicate selection.`,
      );
    }
    seen.add(identity);

    if (!authoredOptions.has(identity)) {
      customCount++;
      customTextLength += codePointLength(value);
      if (customCount > 1) {
        return failure(
          "answer_invalid",
          `The answer to "${question.question}" contains more than one custom value.`,
        );
      }
      if (codePointLength(value) > ASK_USER_LIMITS.otherText) {
        return failure(
          "answer_other_too_long",
          `Custom text for "${question.question}" must be at most ${ASK_USER_LIMITS.otherText} Unicode code points.`,
        );
      }
    }
    values.push(value);
  }

  return { ok: true, value: { answer: values, customTextLength } };
}

function failure(code: AskValidationCode, message: string): AskValidationFailure {
  return { ok: false, code, message };
}

function tooLong(field: string, limit: number): AskValidationFailure {
  return failure(
    "field_too_long",
    `${field} must be at most ${limit} Unicode code points.`,
  );
}

function optionIdentities(question: ValidatedAskQuestion): Set<string> {
  return new Set(question.options.map((option) => normalizeIdentity(option.label)));
}

function normalizeIdentity(value: string): string {
  return value.trim().toLowerCase();
}

function codePointLength(value: string): number {
  return [...value].length;
}

function trimmedString(value: unknown): string | null {
  return typeof value === "string" ? value.trim() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
