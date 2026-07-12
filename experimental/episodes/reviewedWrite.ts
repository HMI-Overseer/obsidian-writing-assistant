import { WRITE_CONTROL_FIXTURE } from "../fixtures/writeControl";
import type { SandboxEpisodeScenario } from "../sandbox/types";

const FINAL_CONTENT = "# Lighthouse\n\nStatus: final\n";

export function createReviewedWriteEpisode(modelId: string): SandboxEpisodeScenario {
  return {
    schemaVersion: 1,
    id: "reviewed-write",
    version: 2,
    title: "Apply one reviewed synthetic note edit",
    description:
      "Exercises a complete read, reviewed write, tool-result continuation, state diff, and replay.",
    modelId,
    samplingParams: {
      temperature: 0,
      maxTokens: 256,
      topP: null,
      topK: null,
      minP: null,
      repeatPenalty: null,
      reasoning: null,
    },
    fixture: WRITE_CONTROL_FIXTURE,
    writeReview: {
      disposition: "applied",
      reason: "The frozen laboratory scenario approves this exact disposable-fixture edit.",
    },
    request: {
      systemPrompt:
        "Work only in the synthetic vault. Read Projects/Lighthouse.md, then use write_file " +
        "with the complete note content to change its status from draft to final.",
      documentContext: null,
      ragContext: null,
      messages: [{
        role: "user",
        content: "Change the Lighthouse project status from draft to final.",
      }],
    },
    stateEvaluators: [{
      id: "lighthouse-final-content",
      label: "The reviewed write produced the expected note content",
      evaluate: (_initial, final) => {
        const file = final.files.find((entry) => entry.path === "Projects/Lighthouse.md");
        return {
          passed: file?.content.trimEnd() === FINAL_CONTENT.trimEnd(),
          detail: file ? `Final content: ${JSON.stringify(file.content)}` : "The note is missing.",
        };
      },
    }],
    evaluators: [
      {
        id: "read-before-reviewed-write",
        label: "The model reads the target before proposing its reviewed write",
        evaluate: ({ rounds }) => {
          const executions = rounds.flatMap((round) => round.toolExecutions);
          const readIndex = executions.findIndex((entry) => entry.call.name === "read_file");
          const writeIndex = executions.findIndex((entry) => entry.call.name === "write_file");
          return readIndex >= 0 && writeIndex > readIndex;
        },
      },
      {
        id: "reviewed-write-applied",
        label: "The write proposal received the frozen applied disposition",
        evaluate: ({ rounds }) => rounds.some((round) => round.toolExecutions.some((entry) =>
          entry.review?.disposition === "applied" && entry.review.applied)),
      },
      {
        id: "no-control-token-leak",
        label: "Chat-template control tokens do not leak into model text",
        evaluate: ({ rounds }) => !rounds.some((round) =>
          round.response.text.includes("<|channel>") ||
          round.response.text.includes("<channel|>")),
      },
    ],
  };
}
