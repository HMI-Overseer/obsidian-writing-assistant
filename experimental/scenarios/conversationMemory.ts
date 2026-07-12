import type { LabScenario } from "../lab/types";

export function createConversationMemoryScenario(modelId: string): LabScenario {
  return {
    schemaVersion: 1,
    id: "conversation-memory",
    version: 1,
    title: "Retain an earlier conversation fact",
    description: "Tests exact retrieval of a fact supplied earlier in the conversation.",
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
      systemPrompt: "Answer the latest user question from the conversation history.",
      documentContext: null,
      ragContext: null,
      messages: [
        { role: "user", content: "Remember that the archive code is EMBER-17." },
        { role: "assistant", content: "I will remember it." },
        { role: "user", content: "Reply with only the archive code." },
      ],
    },
    evaluators: [{
      id: "exact-memory-recall",
      label: "The response recalls only the earlier archive code",
      evaluate: ({ completion }) => completion.text.trim() === "EMBER-17",
    }],
  };
}
