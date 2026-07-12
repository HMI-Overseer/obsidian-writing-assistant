import type { LabScenario } from "../lab/types";
import { responseIncludes } from "../lab/evaluators";

export function createBasicInstructionScenario(modelId: string): LabScenario {
  return {
  schemaVersion: 1,
  id: "basic-instruction",
  version: 1,
  title: "Basic instruction following",
  description: "Control scenario proving that the laboratory can issue and evaluate a completion.",
  modelId,
  samplingParams: {
    temperature: 0,
    maxTokens: 32,
    topP: null,
    topK: null,
    minP: null,
    repeatPenalty: null,
    reasoning: null,
  },
  request: {
    systemPrompt: "Follow the user's instruction exactly.",
    documentContext: null,
    ragContext: null,
    messages: [{ role: "user", content: "Reply with exactly: LAB_READY" }],
  },
  evaluators: [responseIncludes("contains-sentinel", "LAB_READY")],
  };
}
