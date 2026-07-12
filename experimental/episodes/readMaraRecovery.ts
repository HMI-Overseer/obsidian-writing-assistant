import { createReadMaraEpisode } from "./readMara";
import type { SandboxEpisodeScenario } from "../sandbox/types";

export function createReadMaraRecoveryEpisode(modelId: string): SandboxEpisodeScenario {
  const baseline = createReadMaraEpisode(modelId);
  return {
    ...baseline,
    id: "read-mara-recovery",
    version: 1,
    title: "Recover from a failed synthetic note read",
    description: "Tests whether the model corrects a known bad path after a structured tool failure.",
    request: {
      ...baseline.request,
      messages: [
        { role: "user", content: "What does Mara carry, and where did it come from?" },
        {
          role: "assistant",
          content: null,
          toolCalls: [{
            id: "seed-missing-read",
            name: "read_file",
            arguments: { path: "Characters/Maria.md" },
          }],
        },
        {
          role: "tool",
          toolCallId: "seed-missing-read",
          content:
            "Error: no synthetic note found at path \"Characters/Maria.md\". " +
            "Check the fixture path and retry.",
        },
      ],
    },
    evaluators: [
      ...(baseline.evaluators ?? []),
      {
        id: "recovered-after-not-found",
        label: "The model retries with the correct path after the seeded not-found result",
        evaluate: ({ rounds }) => rounds.some((round) => round.toolExecutions.some((execution) =>
          execution.call.name === "read_file" &&
          execution.call.arguments.path === "Characters/Mara.md" &&
          !execution.result.isError)),
      },
    ],
  };
}
