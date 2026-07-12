import type { LabScenario } from "../lab/types";
import { createBasicInstructionScenario } from "./basicInstruction";
import { createAccessibilityRewriteScenario } from "./accessibilityRewrite";
import { createConversationMemoryScenario } from "./conversationMemory";
import { createStructuredOutputScenario } from "./structuredOutput";
import { createVoicePreservationScenario } from "./voicePreservation";

type ScenarioFactory = (modelId: string) => LabScenario;

const SCENARIOS: Readonly<Record<string, ScenarioFactory>> = {
  "accessibility-rewrite": createAccessibilityRewriteScenario,
  "basic-instruction": createBasicInstructionScenario,
  "conversation-memory": createConversationMemoryScenario,
  "structured-output": createStructuredOutputScenario,
  "voice-preservation": createVoicePreservationScenario,
};

export function listScenarioIds(): string[] {
  return Object.keys(SCENARIOS).sort();
}

export function resolveScenario(id: string, modelId: string): LabScenario {
  const factory = SCENARIOS[id];
  if (!factory) {
    throw new Error(
      `Unknown laboratory scenario ${JSON.stringify(id)}. Available scenarios: ${listScenarioIds().join(", ")}.`,
    );
  }
  return factory(modelId);
}
