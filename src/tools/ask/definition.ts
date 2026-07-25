import type { CanonicalToolDefinition } from "../types";

export const ASK_USER_TOOL_NAME = "ask_user";

export const ASK_USER_TOOL_DESCRIPTION =
  "Ask the user for intent, preferences, constraints, or a decision that is required to continue " +
  "correctly. This pauses the turn until the user submits every answer. Ask all currently known " +
  "questions in one call and call this tool alone. Do not use it for facts available through vault " +
  "tools, action approval, rhetorical confirmation, or secrets.";

export const ASK_USER_TOOL: CanonicalToolDefinition = {
  name: ASK_USER_TOOL_NAME,
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
};

export const ASK_TOOL_NAMES: ReadonlySet<string> = new Set([ASK_USER_TOOL_NAME]);
