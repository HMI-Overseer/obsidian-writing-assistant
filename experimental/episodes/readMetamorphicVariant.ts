import { METAMORPHIC_READ_CONTROL_FIXTURE } from "../fixtures/metamorphicReadControl";
import { normalizeSyntheticPath } from "../sandbox/syntheticVault";
import type { SandboxEpisodeScenario } from "../sandbox/types";

export function createReadMetamorphicVariantEpisode(modelId: string): SandboxEpisodeScenario {
  return {
    schemaVersion: 1,
    id: "read-metamorphic-variant",
    version: 1,
    title: "Read an equivalent fact after path and noun substitution",
    description: "Metamorphic variant of the explicit-path grounded-read episode.",
    modelId,
    samplingParams: {
      temperature: 0,
      maxTokens: 128,
      topP: null,
      topK: null,
      minP: null,
      repeatPenalty: null,
      reasoning: null,
    },
    fixture: METAMORPHIC_READ_CONTROL_FIXTURE,
    request: {
      systemPrompt: "Answer from the synthetic vault. Use read_file before answering.",
      documentContext: null,
      ragContext: null,
      messages: [{
        role: "user",
        content: "Read People/Iris.md. What does Iris carry, and where did it come from?",
      }],
    },
    evaluators: [
      {
        id: "read-variant-target",
        label: "The model reads the transformed target note",
        evaluate: ({ rounds }) => rounds.some((round) => round.toolExecutions.some(({ call }) => {
          if (call.name !== "read_file" || typeof call.arguments.path !== "string") return false;
          const normalized = normalizeSyntheticPath(call.arguments.path);
          return normalized.ok && normalized.path === "People/Iris.md";
        })),
      },
      {
        id: "grounded-variant-answer",
        label: "The final answer reports the transformed synthetic fact",
        evaluate: ({ finalText }) => {
          const lower = finalText.toLowerCase();
          return lower.includes("silver key") && lower.includes("uncle");
        },
      },
      {
        id: "no-control-token-leak",
        label: "Chat-template control tokens do not leak into model text",
        evaluate: ({ rounds }) => !rounds.some((round) =>
          round.response.text.includes("<|channel>") || round.response.text.includes("<channel|>")),
      },
    ],
  };
}
