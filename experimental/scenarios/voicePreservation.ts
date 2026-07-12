import type { LabScenario } from "../lab/types";

export function createVoicePreservationScenario(modelId: string): LabScenario {
  return {
    schemaVersion: 1,
    id: "voice-preservation",
    version: 2,
    title: "Preserve first-person past-tense voice",
    description:
      "Tests explicit voice constraints without treating subjective prose quality as deterministic.",
    modelId,
    samplingParams: {
      temperature: 0,
      maxTokens: 64,
      topP: null,
      topK: null,
      minP: null,
      repeatPenalty: null,
      reasoning: null,
    },
    request: {
      systemPrompt: "Rewrite the sentence while preserving first person, past tense, and its meaning.",
      documentContext: null,
      ragContext: null,
      messages: [{
        role: "user",
        content: "Rewrite without changing voice: I waited beside the harbor until dawn.",
      }],
    },
    evaluators: [{
      id: "voice-constraints-preserved",
      label: "The rewrite preserves first person, past tense, location, and waiting meaning",
      evaluate: ({ completion }) => {
        const text = completion.text.toLowerCase();
        const waitMeaning = /\b(?:waited|remained|stayed|lingered)\b/.test(text);
        const dawnMeaning = /\b(?:dawn|daybreak|sunrise)\b/.test(text);
        const passed = /\bi\b/.test(text) && /\b[a-z]+ed\b/.test(text) && waitMeaning &&
          text.includes("harbor") && dawnMeaning;
        return { passed, ...(passed ? {} : { detail: `Response was ${JSON.stringify(completion.text)}.` }) };
      },
    }],
  };
}
