import type { LabEvaluator } from "./types";

export function responseIncludes(id: string, expected: string): LabEvaluator {
  return {
    id,
    label: `The response includes ${JSON.stringify(expected)}`,
    evaluate: ({ completion }) => {
      const passed = completion.text.includes(expected);
      return {
        passed,
        ...(passed ? {} : { detail: `Expected text was absent from ${JSON.stringify(completion.text)}.` }),
      };
    },
  };
}

export function usesTool(id: string, toolName: string): LabEvaluator {
  return {
    id,
    label: `The model calls ${toolName}`,
    evaluate: ({ completion }) => {
      const names = (completion.toolCalls ?? []).map((call) => call.name);
      return {
        passed: names.includes(toolName),
        ...(names.includes(toolName) ? {} : { detail: `Observed tool calls: ${names.join(", ") || "none"}.` }),
      };
    },
  };
}
