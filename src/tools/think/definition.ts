import type { CanonicalToolDefinition } from "../types";

export const THINK_TOOL_NAME = "think";

export const THINK_TOOL: CanonicalToolDefinition = {
  name: THINK_TOOL_NAME,
  description:
    "Use this tool to reason step-by-step before calling other tools or producing a final response. " +
    "Write out your reasoning, plan, or intermediate conclusions in the thought field. " +
    "The result is not shown to the user — it exists only to structure your thinking.",
  strategyHint: "pause and reason before acting, especially before complex tool sequences",
  parameters: {
    type: "object",
    properties: {
      thought: {
        type: "string",
        description: "Your reasoning, plan, or intermediate conclusions.",
      },
    },
    required: ["thought"],
  },
};
