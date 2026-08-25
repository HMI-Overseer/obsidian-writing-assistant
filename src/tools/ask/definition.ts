import type { CanonicalToolDefinition } from "../types";

export const ASK_USER_TOOL_NAME = "ask_user";

export const ASK_USER_TOOL_DESCRIPTION =
  "Ask the user for intent, preferences, constraints, or a decision that is required to continue " +
  "correctly. This pauses the turn until the user submits every answer. Ask all currently known " +
  "questions in one call and call this tool alone. Do not use it for facts available through vault " +
  "tools, action approval, rhetorical confirmation, or secrets.";

/**
 * The tool as advertised, built around the user's configured question ceiling.
 *
 * A builder rather than a constant because that ceiling is a setting. It varies only
 * when the user changes it, which is the same contract `memoriesEnabled` already has
 * on the stable tool superset, so a session's advertised tools stay byte-identical
 * across its requests and the prompt cache prefix stays warm.
 *
 * Only the count is stated. No field carries a length limit, so none is advertised:
 * the model is free to write a long question, a long option description, or many
 * options, and the window renders whatever it sends.
 */
export function buildAskUserTool(maxQuestions: number): CanonicalToolDefinition {
  const questionCount =
    maxQuestions === 1 ? "Exactly one question." : `One to ${maxQuestions} questions to present together.`;
  return {
    name: ASK_USER_TOOL_NAME,
    description: ASK_USER_TOOL_DESCRIPTION,
    annotations: { readOnlyHint: true },
    parameters: {
      type: "object",
      properties: {
        questions: {
          type: "array",
          description: questionCount,
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
                      description: "A unique, non-empty one-line choice label.",
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
  };
}

export const ASK_TOOL_NAMES: ReadonlySet<string> = new Set([ASK_USER_TOOL_NAME]);
