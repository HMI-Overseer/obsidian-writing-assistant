import type { LabScenario } from "../lab/types";

export function createStructuredOutputScenario(modelId: string): LabScenario {
  return {
    schemaVersion: 1,
    id: "structured-output",
    version: 1,
    title: "Exact structured output",
    description: "Tests exact JSON protocol compliance with a small deterministic schema.",
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
      systemPrompt: "Return only the requested JSON object, with no Markdown fence or commentary.",
      documentContext: null,
      ragContext: null,
      messages: [{ role: "user", content: "Return {\"status\":\"ready\",\"count\":2}." }],
    },
    evaluators: [{
      id: "valid-exact-json",
      label: "The response is the exact requested JSON object",
      evaluate: ({ completion }) => {
        try {
          const parsed = JSON.parse(completion.text) as unknown;
          const passed = completion.text.trim() === '{"status":"ready","count":2}' &&
            typeof parsed === "object" && parsed !== null;
          return { passed, ...(passed ? {} : { detail: `Response was ${JSON.stringify(completion.text)}.` }) };
        } catch {
          return { passed: false, detail: `Response was not valid JSON: ${JSON.stringify(completion.text)}.` };
        }
      },
    }],
  };
}
