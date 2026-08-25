import { describe, expect, it } from "vitest";
import {
  ASK_TOOL_NAMES,
  ASK_USER_TOOL_DESCRIPTION,
  ASK_USER_TOOL_NAME,
  buildAskUserTool,
} from "../../../../src/tools/ask/definition";

describe("buildAskUserTool", () => {
  it("defines the canonical self-contained contract", () => {
    expect(ASK_USER_TOOL_NAME).toBe("ask_user");
    expect(ASK_TOOL_NAMES).toEqual(new Set(["ask_user"]));
    expect(buildAskUserTool(4)).toEqual({
      name: "ask_user",
      description: ASK_USER_TOOL_DESCRIPTION,
      annotations: { readOnlyHint: true },
      parameters: {
        type: "object",
        properties: {
          questions: {
            type: "array",
            description: "One to 4 questions to present together.",
            items: {
              type: "object",
              properties: {
                question: {
                  type: "string",
                  description:
                    "One unique, non-empty line. Be as specific as the decision requires.",
                },
                header: {
                  type: "string",
                  description: "A short, non-empty one-line label for this question's tab.",
                },
                options: {
                  type: "array",
                  description:
                    "At least two distinct choices. Do not add Other, the application adds it.",
                  items: {
                    type: "object",
                    properties: {
                      label: {
                        type: "string",
                        description:
                          "A unique, non-empty one-line choice label.",
                      },
                      description: {
                        type: "string",
                        description:
                          "A non-empty explanation of this choice and its impact.",
                      },
                    },
                    required: ["label", "description"],
                  },
                },
                multiSelect: {
                  type: "boolean",
                  description: "Whether the user may select more than one answer.",
                },
              },
              required: ["question", "header", "options", "multiSelect"],
            },
          },
        },
        required: ["questions"],
      },
    });
  });

  it("keeps the description complete when optional built-in prompts are disabled", () => {
    expect(ASK_USER_TOOL_DESCRIPTION).toContain("pauses the turn");
    expect(ASK_USER_TOOL_DESCRIPTION).toContain("Ask all currently known questions in one call");
    expect(ASK_USER_TOOL_DESCRIPTION).toContain("call this tool alone");
    expect(ASK_USER_TOOL_DESCRIPTION).toContain("facts available through vault tools");
    expect(ASK_USER_TOOL_DESCRIPTION).toContain("action approval");
    expect(ASK_USER_TOOL_DESCRIPTION).toContain("rhetorical confirmation");
    expect(ASK_USER_TOOL_DESCRIPTION).toContain("secrets");
  });

  it("advertises the configured question ceiling and no length limit at all", () => {
    const questionsOf = (tool: ReturnType<typeof buildAskUserTool>): string =>
      String(
        (tool.parameters.properties as Record<string, { description?: string }>)
          .questions.description,
      );
    expect(questionsOf(buildAskUserTool(1))).toBe("Exactly one question.");
    expect(questionsOf(buildAskUserTool(2))).toBe("One to 2 questions to present together.");
    expect(questionsOf(buildAskUserTool(25))).toBe("One to 25 questions to present together.");

    // No field may advertise a size, or the model will self-censor against a bound the
    // validator no longer applies.
    const advertised = JSON.stringify(buildAskUserTool(4));
    expect(advertised).not.toContain("code points");
    expect(advertised).not.toContain("at most");
    expect(advertised).not.toMatch(/characters/u);
  });

  it("has no approval posture or vault policy metadata", () => {
    expect(Object.keys(buildAskUserTool(4))).toEqual([
      "name",
      "description",
      "annotations",
      "parameters",
    ]);
  });
});
