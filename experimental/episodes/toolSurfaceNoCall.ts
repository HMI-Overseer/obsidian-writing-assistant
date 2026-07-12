import type { SandboxEpisodeScenario } from "../sandbox/types";

export function createToolSurfaceNoCallEpisode(modelId: string): SandboxEpisodeScenario {
  return {
    schemaVersion: 1,
    id: "tool-surface-no-call",
    version: 1,
    title: "Tool surface without a tool call",
    description:
      "Isolation control for whether advertising read_file alone causes chat-template token leakage.",
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
    fixture: {
      schemaVersion: 1,
      id: "empty-control-vault",
      version: 1,
      description: "Empty synthetic vault for a no-call tool-surface control.",
      files: [],
    },
    request: {
      systemPrompt: "Do not call any tools. Follow the user's response-format instruction exactly.",
      documentContext: null,
      ragContext: null,
      messages: [{ role: "user", content: "Reply with exactly: LAB_READY" }],
    },
    evaluators: [
      {
        id: "no-tool-call",
        label: "The model does not call the advertised tool",
        evaluate: ({ rounds }) => rounds.every((round) => round.toolExecutions.length === 0),
      },
      {
        id: "exact-sentinel",
        label: "The final response is exactly LAB_READY",
        evaluate: ({ finalText }) => ({
          passed: finalText.trim() === "LAB_READY",
          ...(finalText.trim() === "LAB_READY"
            ? {}
            : { detail: `Final answer was ${JSON.stringify(finalText)}.` }),
        }),
      },
      {
        id: "no-control-token-leak",
        label: "Chat-template control tokens do not leak into model text",
        evaluate: ({ rounds }) => {
          const leaked = rounds.some((round) =>
            round.response.text.includes("<|channel>") ||
            round.response.text.includes("<channel|>"));
          return {
            passed: !leaked,
            ...(leaked ? { detail: "A response contained chat-template control tokens." } : {}),
          };
        },
      },
    ],
  };
}
