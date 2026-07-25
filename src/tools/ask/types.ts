/** Model-authored option before runtime validation. */
export interface RawAskOption {
  label: unknown;
  description: unknown;
}

/** Model-authored question before runtime validation. */
export interface RawAskQuestion {
  question: unknown;
  header: unknown;
  options: unknown;
  multiSelect: unknown;
}

/** Complete model-authored request before runtime validation. */
export interface RawAskRequest {
  questions: unknown;
}

/** A validated model-authored option, with boundary whitespace removed. */
export interface ValidatedAskOption {
  label: string;
  description: string;
}

/** A validated model-authored question, with boundary whitespace removed. */
export interface ValidatedAskQuestion {
  question: string;
  header: string;
  options: ValidatedAskOption[];
  multiSelect: boolean;
}

/** A complete request which is safe to mount in the composer interaction lane. */
export interface ValidatedAskRequest {
  questions: ValidatedAskQuestion[];
}

export type AskSingleAnswer = string;
export type AskMultiAnswer = string[];
export type AskAnswerValue = AskSingleAnswer | AskMultiAnswer;

/** Canonical submitted answers, keyed by validated question text. */
export type AskAnswers = Record<string, AskAnswerValue>;

export type AskValidationCode =
  | "questions_count"
  | "question_empty"
  | "question_multiline"
  | "question_duplicate"
  | "header_invalid"
  | "options_count"
  | "option_label_invalid"
  | "option_label_duplicate"
  | "option_label_reserved"
  | "option_description_invalid"
  | "multi_select_invalid"
  | "field_too_long"
  | "answer_incomplete"
  | "answer_invalid"
  | "answer_other_too_long"
  | "answer_custom_total_too_long";

export interface AskValidationFailure {
  ok: false;
  code: AskValidationCode;
  message: string;
}

export type AskRequestValidationResult =
  | { ok: true; value: ValidatedAskRequest }
  | AskValidationFailure;

export type AskAnswerValidationResult =
  | { ok: true; value: AskAnswers }
  | AskValidationFailure;

export interface AskRequestContext {
  interactionId: string;
  toolCallId: string;
  signal: AbortSignal;
}

export type AskCancellationReason =
  | "stopped"
  | "conversation-switched"
  | "new-conversation"
  | "view-closed"
  | "provider-failed"
  | "superseded"
  | "destroyed";

/**
 * Generation-scoped responder contract. The coordinator validates before mounting
 * and owns the one pending composer interaction for the active root turn.
 */
export interface AskUserResponder {
  ask(request: unknown, context: AskRequestContext): Promise<AskAnswers>;
  cancelPending(reason: AskCancellationReason): void;
}
