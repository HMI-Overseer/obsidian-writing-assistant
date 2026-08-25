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

/**
 * The one structural floor left on an `ask_user` request. Nothing here caps length or
 * verbosity: a question, a header, an option label, and an option description may all
 * run as long as the model wants, and a question may carry as many options as it
 * wants. A verbose window is a consequence of the model having a lot to ask, not a
 * failure to guard against.
 *
 * `minOptions` is a floor rather than a cap. A "choice" with fewer than two authored
 * options is not a choice, it is the rhetorical confirmation the tool's own guidance
 * forbids, so this rejects a shape rather than a size.
 *
 * The one real ceiling, how many questions may arrive in a single call, is the user's
 * to set. It lives in settings as `askMaxQuestions` and is enforced once, at the live
 * request boundary, by {@link enforceAskQuestionLimit}. It is deliberately absent from
 * this validator so that replaying history recorded under a larger setting still
 * parses.
 */
export const ASK_USER_LIMITS = {
  minOptions: 2,
} as const;

const LINE_BREAK = /[\r\n\u2028\u2029]/u;
const OTHER_IDENTITY = "other";

export function validateAskRequest(input: unknown): AskRequestValidationResult {
  if (!isRecord(input) || !Array.isArray(input.questions)) {
    return failure("questions_count", "questions must be an array with at least one entry.");
  }
  if (input.questions.length < 1) {
    return failure("questions_count", "questions must contain at least one entry.");
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

  const header = trimmedString(input.header);
  if (!header || LINE_BREAK.test(header)) {
    return failure(
      "header_invalid",
      `Question ${index + 1} header must be a non-empty single line.`,
    );
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
  if (!Array.isArray(input) || input.length < ASK_USER_LIMITS.minOptions) {
    return failure(
      "options_count",
      `Question ${questionIndex + 1} must contain at least ${ASK_USER_LIMITS.minOptions} options.`,
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
    options.push({ label, description });
  }
  return { ok: true, value: options };
}

type AnswerValueResult =
  | { ok: true; value: { answer: string | string[] } }
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

  return { ok: true, value: { answer: value } };
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
      if (customCount > 1) {
        return failure(
          "answer_invalid",
          `The answer to "${question.question}" contains more than one custom value.`,
        );
      }
    }
    values.push(value);
  }

  return { ok: true, value: { answer: values } };
}

/**
 * The user's configured ceiling on how many questions one call may carry, applied at
 * the live request boundary and nowhere else.
 *
 * Kept out of {@link validateAskRequest} on purpose. That function also runs on replay
 * and ledger paths, where the questions were already answered under whatever setting
 * was in force at the time; gating those on today's number would silently drop a
 * conversation's history the moment the setting was lowered.
 */
export function enforceAskQuestionLimit(
  request: ValidatedAskRequest,
  maxQuestions: number,
): AskValidationFailure | null {
  if (request.questions.length <= maxQuestions) return null;
  return failure(
    "questions_count",
    `questions must contain at most ${maxQuestions} ` +
      `${maxQuestions === 1 ? "entry" : "entries"}, and this call carried ` +
      `${request.questions.length}. Ask the most important ones now and the rest later.`,
  );
}

function failure(code: AskValidationCode, message: string): AskValidationFailure {
  return { ok: false, code, message };
}

function optionIdentities(question: ValidatedAskQuestion): Set<string> {
  return new Set(question.options.map((option) => normalizeIdentity(option.label)));
}

function normalizeIdentity(value: string): string {
  return value.trim().toLowerCase();
}

function trimmedString(value: unknown): string | null {
  return typeof value === "string" ? value.trim() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
