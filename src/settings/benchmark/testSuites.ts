import type { BenchmarkTestSuite } from "./types";
import { getTestCases } from "./testCases";

/**
 * Returns all registered benchmark test suites.
 * Each suite groups related test cases for a specific feature.
 */
export function getTestSuites(): BenchmarkTestSuite[] {
  return [
    {
      id: "edit-annotations",
      name: "Edit annotations",
      description:
        "Each test sends a synthetic conversation to the model and evaluates whether it correctly interprets edit outcome annotations.",
      icon: "pencil",
      testCases: getTestCases(),
    },
    {
      id: "memory",
      name: "Memory",
      description: "Tests for conversation memory retention and recall accuracy.",
      icon: "brain",
      testCases: [],
    },
    {
      id: "tools",
      name: "Tools",
      description: "Tests for tool invocation, parameter handling, and result interpretation.",
      icon: "wrench",
      testCases: [],
    },
  ];
}
