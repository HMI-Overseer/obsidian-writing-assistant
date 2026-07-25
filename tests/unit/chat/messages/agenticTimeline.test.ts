import { describe, test, expect } from "vitest";
import {
  askGuidanceDetailRows,
  selectClaimIndex,
  toolStepClasses,
  toolStepLabel,
} from "../../../../src/chat/messages/AgenticTimeline";

describe("toolStepClasses", () => {
  test("a read-only tool yields the base tool-call classes only", () => {
    expect(toolStepClasses("read_file")).toBe(
      "lmsa-agentic-timeline-step lmsa-agentic-timeline-step--tool_call",
    );
  });

  test("a mutating tool adds the --mutating category class", () => {
    for (const name of [
      "write_file",
      "move_file",
      "trash_file",
      "create_directory",
      "propose_edit",
      "update_frontmatter",
    ]) {
      expect(toolStepClasses(name).split(" ")).toContain("lmsa-agentic-timeline-step--mutating");
    }
  });

  test("extra classes are appended after the category class, in order", () => {
    expect(toolStepClasses("write_file", "lmsa-agentic-timeline-step--pending")).toBe(
      "lmsa-agentic-timeline-step lmsa-agentic-timeline-step--tool_call " +
        "lmsa-agentic-timeline-step--mutating lmsa-agentic-timeline-step--pending",
    );
  });

  test("an unknown / undefined tool is treated as read-only", () => {
    expect(toolStepClasses(undefined)).toBe(
      "lmsa-agentic-timeline-step lmsa-agentic-timeline-step--tool_call",
    );
  });
});

describe("selectClaimIndex", () => {
  test("claims the placeholder tagged with the matching id, mid-queue", () => {
    expect(selectClaimIndex(["a", "b", "c"], "b")).toBe(1);
  });

  test("falls back to FIFO (index 0) when the id is not present", () => {
    expect(selectClaimIndex(["a", "b"], "z")).toBe(0);
  });

  test("falls back to FIFO when the completing call carries no id (plugin path)", () => {
    expect(selectClaimIndex([undefined, undefined], undefined)).toBe(0);
  });

  test("skips untagged placeholders to reach the id-matched one", () => {
    expect(selectClaimIndex([undefined, "x", undefined], "x")).toBe(1);
  });
});

describe("ask_user timeline presentation", () => {
  test("derives completed, cancelled, and skipped labels from structured status", () => {
    expect(
      toolStepLabel({
        type: "tool_call",
        round: 0,
        toolName: "ask_user",
        askStatus: "completed",
      }),
    ).toBe("Asked for guidance");
    expect(
      toolStepLabel({
        type: "tool_call",
        round: 0,
        toolName: "ask_user",
        askStatus: "cancelled",
      }),
    ).toBe("Question cancelled when generation stopped");
    expect(
      toolStepLabel({
        type: "tool_call",
        round: 0,
        toolName: "ask_user",
        askStatus: "skipped",
      }),
    ).toBe("Question skipped");
  });

  test("builds completed expansion rows only from exact structured guidance", () => {
    const rows = askGuidanceDetailRows({
      type: "tool_call",
      round: 0,
      toolName: "ask_user",
      toolArgs: { questions: [{ header: "Wrong", question: "Do not parse me" }] },
      resultRecord: "bounded display text",
      askGuidance: {
        questions: [
          {
            question: "Which format?",
            header: "Output",
            answer: "Detailed",
          },
          {
            question: "Which sections?",
            header: "Sections",
            answer: ["Testing", "Accessibility"],
          },
        ],
      },
    });

    expect(rows).toEqual([
      {
        header: "Output",
        question: "Which format?",
        answers: ["Detailed"],
      },
      {
        header: "Sections",
        question: "Which sections?",
        answers: ["Testing", "Accessibility"],
      },
    ]);
  });
});
