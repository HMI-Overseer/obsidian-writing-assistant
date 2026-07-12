import { READ_CONTROL_FIXTURE } from "../fixtures/readControl";
import type { SandboxEpisodeScenario } from "../sandbox/types";
import { normalizeSyntheticPath } from "../sandbox/syntheticVault";

export function createReadMaraEpisode(modelId: string): SandboxEpisodeScenario {
  return {
    schemaVersion: 1,
    id: "read-mara",
    version: 2,
    title: "Read a fact about Mara",
    description: "Tests whether the model reads a known synthetic note and grounds its answer.",
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
    fixture: READ_CONTROL_FIXTURE,
    request: {
      systemPrompt:
        "Answer from the synthetic vault. Use read_file before answering. Do not guess note content.",
      documentContext: null,
      ragContext: null,
      messages: [{ role: "user", content: "What does Mara carry, and where did it come from?" }],
    },
    evaluators: [
      {
        id: "read-target-note",
        label: "The model reads the target synthetic note",
        evaluate: ({ rounds }) => {
          const calls = rounds.flatMap((round) =>
            round.toolExecutions.map((execution) => execution.call));
          const passed = calls.some((call) => {
            if (call.name !== "read_file" || typeof call.arguments.path !== "string") return false;
            const normalized = normalizeSyntheticPath(call.arguments.path);
            return normalized.ok && normalized.path === "Characters/Mara.md";
          });
          return {
            passed,
            ...(passed ? {} : { detail: "No read_file call targeted Characters/Mara.md." }),
          };
        },
      },
      {
        id: "grounded-answer",
        label: "The final answer reports the synthetic note's fact",
        evaluate: ({ finalText }) => {
          const lower = finalText.toLowerCase();
          const passed = lower.includes("brass compass") && lower.includes("grandmother");
          return {
            passed,
            ...(passed ? {} : { detail: `Final answer was ${JSON.stringify(finalText)}.` }),
          };
        },
      },
      {
        id: "no-control-token-leak",
        label: "Chat-template control tokens do not leak into model text",
        evaluate: ({ rounds }) => {
          const leaked = rounds
            .map((round) => round.response.text)
            .find((text) => text.includes("<|channel>") || text.includes("<channel|>"));
          return {
            passed: leaked === undefined,
            ...(leaked === undefined
              ? {}
              : { detail: `Observed chat-template control tokens in ${JSON.stringify(leaked)}.` }),
          };
        },
      },
      {
        id: "target-path-first-attempt",
        label: "The model targets the correct note on its first tool attempt",
        required: false,
        evaluate: ({ rounds }) => {
          const firstCall = rounds.flatMap((round) => round.toolExecutions)[0]?.call;
          if (!firstCall || typeof firstCall.arguments.path !== "string") {
            return { passed: false, detail: "No first path-bearing tool call was observed." };
          }
          const normalized = normalizeSyntheticPath(firstCall.arguments.path);
          const passed = normalized.ok && normalized.path === "Characters/Mara.md";
          return {
            passed,
            ...(passed
              ? {}
              : { detail: `First attempted path was ${JSON.stringify(firstCall.arguments.path)}.` }),
          };
        },
      },
    ],
  };
}
