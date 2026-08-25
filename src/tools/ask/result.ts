import type {
  CompletedAskGuidanceQuestion,
  CompletedAskGuidanceRecord,
} from "../../shared/types";
import { toolFailure } from "../toolFailure";
import type { ToolResult } from "../types";
import type {
  AskAnswers,
  AskCancellationReason,
  AskValidationFailure,
  ValidatedAskRequest,
} from "./types";
import { validateAskAnswers, validateAskRequest } from "./validation";

const LINE_BREAK = /[\r\n\u2028\u2029]/u;

export interface AskGuidanceCapture {
  guidance: CompletedAskGuidanceRecord;
  digest: string;
}

export function buildAskUserResult(answers: AskAnswers): ToolResult {
  return {
    content: JSON.stringify({ answers }),
    isReadOnly: true,
  };
}

export function buildCompletedAskGuidance(
  request: ValidatedAskRequest,
  answers: AskAnswers,
): CompletedAskGuidanceRecord {
  return {
    questions: request.questions.map((question) => ({
      question: question.question,
      header: question.header,
      answer: cloneAnswer(answers[question.question]),
    })),
  };
}

/**
 * JSON encoding is deliberate: authored newlines, quotes, brackets, and separators
 * stay escaped data rather than becoming replay syntax.
 */
export function formatAskGuidanceDigest(guidance: CompletedAskGuidanceRecord): string {
  return `[ask_user guidance: ${JSON.stringify(guidance)}]`;
}

/**
 * Reconstruct exact guidance at a tool-result choke point. Invalid input, failed
 * calls, non-JSON results, and incomplete answers do not acquire false provenance.
 */
export function deriveAskGuidanceCapture(
  args: Record<string, unknown>,
  result: Pick<ToolResult, "content" | "isError">,
): AskGuidanceCapture | null {
  if (result.isError) return null;
  const request = validateAskRequest(args);
  if (!request.ok) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.content);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || !isRecord(parsed.answers)) return null;

  const answers = validateAskAnswers(request.value, parsed.answers);
  if (!answers.ok) return null;
  const guidance = buildCompletedAskGuidance(request.value, answers.value);
  return { guidance, digest: formatAskGuidanceDigest(guidance) };
}

/**
 * Strict load-time validation for user-editable conversation JSON. This clones a
 * valid record and rejects malformed or padded data instead of trimming or repairing
 * it, so persisted guidance never gains altered provenance during normalization.
 */
export function normalizeCompletedAskGuidance(
  input: unknown,
): CompletedAskGuidanceRecord | null {
  if (!hasExactKeys(input, ["questions"]) || !Array.isArray(input.questions)) return null;
  // A floor, not a ceiling. The question count is the user's setting to choose, and a
  // record written under a larger setting must still load after they lower it.
  if (input.questions.length < 1) return null;

  const questions: CompletedAskGuidanceQuestion[] = [];
  const identities = new Set<string>();
  for (const rawQuestion of input.questions) {
    if (!hasExactKeys(rawQuestion, ["question", "header", "answer"])) return null;

    const question = exactLine(rawQuestion.question);
    const header = exactLine(rawQuestion.header);
    if (question === null || header === null) return null;

    const identity = question.toLowerCase();
    if (identities.has(identity)) return null;
    identities.add(identity);

    const answer = normalizePersistedAnswer(rawQuestion.answer);
    if (answer === null) return null;

    questions.push({ question, header, answer });
  }
  return { questions };
}

export function askInvalidRequestFailure(issue: AskValidationFailure): ToolResult {
  return validationFailure("invalid request", issue);
}

export function askIncompleteAnswerFailure(issue: AskValidationFailure): ToolResult {
  return validationFailure("incomplete answer", issue);
}

export function askRepeatedFailure(): ToolResult {
  return askPreconditionFailure(
    "ask_repeated",
    "only the first ask_user call in a tool batch can run",
    "continue from the first answer and include all known questions in one future call",
  );
}

export function askConcurrentFailure(): ToolResult {
  return askPreconditionFailure(
    "ask_concurrent",
    "another ask_user interaction is already pending",
    "wait for that interaction to settle before asking again",
  );
}

export function askSkippedSiblingFailure(toolName: string): ToolResult {
  return askPreconditionFailure(
    "ask_sibling_skipped",
    `${toolName} was not executed because ask_user must run alone`,
    "continue after the user's answer and call the tool again only if it is still needed",
  );
}

export function askCancellationFailure(reason: AskCancellationReason): ToolResult {
  return askPreconditionFailure(
    "ask_cancelled",
    `the pending ask_user interaction was cancelled because the generation was ${reason}`,
    "ask again in a new turn only if the guidance is still required",
  );
}

function validationFailure(label: string, issue: AskValidationFailure): ToolResult {
  return toolFailure({
    kind: "invalid-args",
    what: `ask_user ${label} (${issue.code}): ${issue.message}`,
    recovery: "correct the named issue and retry ask_user alone",
  });
}

function askPreconditionFailure(
  code: string,
  what: string,
  recovery: string,
): ToolResult {
  return toolFailure({
    kind: "precondition",
    what: `ask_user ${code}: ${what}`,
    recovery,
  });
}

function normalizePersistedAnswer(input: unknown): string | string[] | null {
  if (typeof input === "string") return exactAnswerString(input);
  if (!Array.isArray(input) || input.length < 1) return null;

  const answer: string[] = [];
  const identities = new Set<string>();
  for (const rawValue of input) {
    const value = exactAnswerString(rawValue);
    if (value === null) return null;
    const identity = value.toLowerCase();
    if (identities.has(identity)) return null;
    identities.add(identity);
    answer.push(value);
  }
  return answer;
}

/**
 * Shape only, never length. What protects provenance here is that the record is
 * cloned exactly rather than trimmed or repaired, so a padded or malformed answer is
 * rejected instead of quietly rewritten. A code-point ceiling adds nothing to that,
 * a forged short answer passes any length test, and gating the read on one would
 * discard a long answer the user really did type.
 */
function exactAnswerString(input: unknown): string | null {
  if (typeof input !== "string" || input.length === 0 || input !== input.trim()) return null;
  return input;
}

/**
 * Shape only, matching {@link exactAnswerString}. Single-line is a structural rule the
 * question and header are authored under, not a size limit, so it stays while the
 * length ceiling that used to sit beside it does not.
 */
function exactLine(input: unknown): string | null {
  if (
    typeof input !== "string" ||
    input.length === 0 ||
    input !== input.trim() ||
    LINE_BREAK.test(input)
  ) {
    return null;
  }
  return input;
}

function cloneAnswer(answer: string | string[]): string | string[] {
  return Array.isArray(answer) ? [...answer] : answer;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys<T extends string>(
  value: unknown,
  expectedKeys: readonly T[],
): value is Record<T, unknown> {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  return keys.length === expectedKeys.length && expectedKeys.every((key) => keys.includes(key));
}
