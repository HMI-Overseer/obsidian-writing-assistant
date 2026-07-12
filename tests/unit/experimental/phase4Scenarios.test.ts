import { describe, expect, it } from "vitest";
import { createAccessibilityRewriteScenario } from "../../../experimental/scenarios/accessibilityRewrite";
import { createConversationMemoryScenario } from "../../../experimental/scenarios/conversationMemory";
import { createStructuredOutputScenario } from "../../../experimental/scenarios/structuredOutput";
import { createVoicePreservationScenario } from "../../../experimental/scenarios/voicePreservation";
import type { LabScenario } from "../../../experimental/lab/types";

function evaluate(scenario: LabScenario, text: string): boolean {
  const result = scenario.evaluators[0].evaluate({
    request: scenario.request,
    completion: { text, usage: null, toolCalls: null, stopReason: "end_turn" },
    durationMs: 1,
  });
  return typeof result === "boolean" ? result : result.passed;
}

describe("Phase 4 deterministic scenarios", () => {
  it("accepts only the exact structured object", () => {
    const scenario = createStructuredOutputScenario("model");
    expect(evaluate(scenario, '{"status":"ready","count":2}')).toBe(true);
    expect(evaluate(scenario, '```json\n{"status":"ready","count":2}\n```')).toBe(false);
  });

  it("checks exact conversation recall", () => {
    const scenario = createConversationMemoryScenario("model");
    expect(evaluate(scenario, "EMBER-17")).toBe(true);
    expect(evaluate(scenario, "The code is EMBER-17.")).toBe(false);
  });

  it("accepts semantic voice-preserving synonyms without claiming subjective quality", () => {
    const scenario = createVoicePreservationScenario("model");
    expect(scenario.version).toBe(2);
    expect(evaluate(scenario, "I remained by the harbor's edge until daybreak.")).toBe(true);
    expect(evaluate(scenario, "She remains at the harbor until dawn.")).toBe(false);
  });

  it("checks narrow plain-language constraints", () => {
    const scenario = createAccessibilityRewriteScenario("model");
    expect(evaluate(scenario, "Use the standard steps to complete the form.")).toBe(true);
    expect(evaluate(scenario, "Utilize the methodology to complete the form.")).toBe(false);
  });
});
