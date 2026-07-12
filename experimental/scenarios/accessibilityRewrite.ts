import type { LabScenario } from "../lab/types";

export function createAccessibilityRewriteScenario(modelId: string): LabScenario {
  return {
    schemaVersion: 1,
    id: "accessibility-rewrite",
    version: 1,
    title: "Rewrite procedural jargon plainly",
    description: "Tests narrow, deterministic plain-language constraints.",
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
      systemPrompt: "Rewrite in plain language. Return one sentence and no commentary.",
      documentContext: null,
      ragContext: null,
      messages: [{
        role: "user",
        content: "Utilize the established methodology to facilitate completion of the form.",
      }],
    },
    evaluators: [{
      id: "plain-language-constraints",
      label: "The rewrite is one short sentence using plain alternatives",
      evaluate: ({ completion }) => {
        const text = completion.text.trim();
        const words = text.split(/\s+/).filter(Boolean);
        const lower = text.toLowerCase();
        const passed = words.length <= 20 && lower.includes("use") && lower.includes("form") &&
          !lower.includes("utilize") && !lower.includes("methodology") &&
          !lower.includes("facilitate");
        return { passed, ...(passed ? {} : { detail: `Response was ${JSON.stringify(text)}.` }) };
      },
    }],
  };
}
