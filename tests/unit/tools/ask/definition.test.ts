import { describe, expect, it } from "vitest";
import {
  ASK_TOOL_NAMES,
  ASK_USER_TOOL,
  ASK_USER_TOOL_DESCRIPTION,
  ASK_USER_TOOL_NAME,
} from "../../../../src/tools/ask/definition";

describe("ASK_USER_TOOL", () => {
  it("defines the canonical self-contained contract", () => {
    expect(ASK_USER_TOOL_NAME).toBe("ask_user");
    expect(ASK_TOOL_NAMES).toEqual(new Set(["ask_user"]));
    expect(ASK_USER_TOOL).toEqual({
      name: "ask_user",
      description: ASK_USER_TOOL_DESCRIPTION,
      annotations: { readOnlyHint: true },
      parameters: {
        type: "object",
        properties: {
          questions: {
            type: "array",
            description: "One to four questions to present together.",
            items: {
              type: "object",
              properties: {
                question: {
                  type: "string",
                  description: "One unique, non-empty line of at most 300 Unicode code points.",
                },
                header: {
                  type: "string",
                  description: "A short, non-empty one-line label of at most 12 Unicode code points.",
                },
                options: {
                  type: "array",
                  description:
                    "Two to four distinct choices. Do not add Other, the application adds it.",
                  items: {
                    type: "object",
                    properties: {
                      label: {
                        type: "string",
                        description:
                          "A unique, non-empty one-line choice label of at most 40 Unicode code points.",
                      },
                      description: {
                        type: "string",
                        description:
                          "A non-empty explanation of this choice and its impact, at most 200 Unicode code points.",
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

  it("has no approval posture or vault policy metadata", () => {
    expect(Object.keys(ASK_USER_TOOL)).toEqual([
      "name",
      "description",
      "annotations",
      "parameters",
    ]);
  });
});
