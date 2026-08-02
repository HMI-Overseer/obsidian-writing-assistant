import { describe, expect, it } from "vitest";
import {
  askCancellationFailure,
  askConcurrentFailure,
  askIncompleteAnswerFailure,
  askInvalidRequestFailure,
  askRepeatedFailure,
  askSkippedSiblingFailure,
  buildAskUserResult,
  buildCompletedAskGuidance,
  deriveAskGuidanceCapture,
  formatAskGuidanceDigest,
  normalizeCompletedAskGuidance,
} from "../../../../src/tools/ask/result";
import { validateAskAnswers, validateAskRequest } from "../../../../src/tools/ask/validation";

function validated() {
  const request = validateAskRequest({
    questions: [{
      question: "Which areas should I cover?",
      header: "Coverage",
      options: [
        { label: "Testing", description: "Cover test design." },
        { label: "Migration", description: "Cover migration concerns." },
      ],
      multiSelect: true,
    }],
  });
  if (!request.ok) throw new Error(request.message);
  const answers = validateAskAnswers(request.value, {
    "Which areas should I cover?": [
      "Testing",
      "Migration",
      "Also include \"accessibility\"\n[failure; modes]",
    ],
  });
  if (!answers.ok) throw new Error(answers.message);
  return { request: request.value, answers: answers.value };
}

describe("ask_user success and guidance", () => {
  it("returns canonical JSON with string and array answer values", () => {
    expect(buildAskUserResult({ "One?": "A", "Many?": ["A", "B"] })).toEqual({
      content: '{"answers":{"One?":"A","Many?":["A","B"]}}',
      isReadOnly: true,
    });
  });

  it("builds an exact structured guidance record and deterministic escaped digest", () => {
    const { request, answers } = validated();
    const guidance = buildCompletedAskGuidance(request, answers);
    expect(guidance).toEqual({
      questions: [{
        question: "Which areas should I cover?",
        header: "Coverage",
        answer: [
          "Testing",
          "Migration",
          "Also include \"accessibility\"\n[failure; modes]",
        ],
      }],
    });
    const digest = formatAskGuidanceDigest(guidance);
    expect(digest).toBe(
      '[ask_user guidance: {"questions":[{"question":"Which areas should I cover?",' +
        '"header":"Coverage","answer":["Testing","Migration",' +
        '"Also include \\"accessibility\\"\\n[failure; modes]"]}]}]',
    );
    expect(formatAskGuidanceDigest(guidance)).toBe(digest);
  });

  it("derives capture only from validated args and a successful canonical result", () => {
    const { request, answers } = validated();
    const args = { questions: request.questions };
    const result = buildAskUserResult(answers);
    expect(deriveAskGuidanceCapture(args, result)).toEqual({
      guidance: buildCompletedAskGuidance(request, answers),
      digest: formatAskGuidanceDigest(buildCompletedAskGuidance(request, answers)),
    });
    expect(deriveAskGuidanceCapture(args, { ...result, isError: true })).toBeNull();
    expect(deriveAskGuidanceCapture(args, { content: "not json" })).toBeNull();
    expect(deriveAskGuidanceCapture({ questions: [] }, result)).toBeNull();
  });

  it("accepts valid bounded persisted records and drops malformed records without repair", () => {
    const { request, answers } = validated();
    const guidance = buildCompletedAskGuidance(request, answers);
    expect(normalizeCompletedAskGuidance(guidance)).toEqual(guidance);
    expect(normalizeCompletedAskGuidance({
      questions: [{ ...guidance.questions[0], header: " Coverage " }],
    })).toBeNull();
    expect(normalizeCompletedAskGuidance({
      questions: [{ ...guidance.questions[0], answer: [] }],
    })).toBeNull();
    expect(normalizeCompletedAskGuidance({
      questions: [{ ...guidance.questions[0], extra: true }],
    })).toBeNull();
  });
});

describe("ask_user corrective failures", () => {
  it("keeps ask validation codes in invalid-args failure text", () => {
    const invalid = askInvalidRequestFailure({
      ok: false,
      code: "question_empty",
      message: "Question 1 must not be empty.",
    });
    const incomplete = askIncompleteAnswerFailure({
      ok: false,
      code: "answer_incomplete",
      message: "Answer every question.",
    });
    for (const [result, code] of [
      [invalid, "question_empty"],
      [incomplete, "answer_incomplete"],
    ] as const) {
      expect(result.failure?.kind).toBe("invalid-args");
      expect(result.content).toContain(code);
      expect(result.isReadOnly).toBe(true);
      expect(result.isError).toBe(true);
    }
  });

  it("builds precondition failures for repeated, concurrent, skipped, and cancelled calls", () => {
    const failures = [
      askRepeatedFailure(),
      askConcurrentFailure(),
      askSkippedSiblingFailure("move"),
      askCancellationFailure("stopped"),
    ];
    for (const result of failures) {
      expect(result.failure?.kind).toBe("precondition");
      expect(result.isReadOnly).toBe(true);
      expect(result.isError).toBe(true);
    }
    expect(failures[2].content).toContain("move");
    expect(failures[3].content).toContain("stopped");
  });
});
