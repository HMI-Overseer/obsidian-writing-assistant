import type { BenchmarkTestSuite } from "./types";
import { getTestCases } from "./testCases";
import { getToolTestCases } from "./toolTestCases";

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
      id: "edit-tools",
      name: "Edit tools",
      description:
        "Tests whether the model can correctly invoke editing tools — calling the right tool, with valid arguments, in the expected order.",
      icon: "wrench",
      testCases: getToolTestCases(),
    },
    {
      id: "memory",
      name: "Memory",
      description: "Tests for conversation memory retention and recall accuracy.",
      icon: "brain",
      testCases: [],
    },
  ];
}
