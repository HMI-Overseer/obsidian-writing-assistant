import { createReadMaraEpisode } from "./readMara";
import type { SandboxEpisodeScenario } from "../sandbox/types";

export function createReadMaraExplicitPathEpisode(modelId: string): SandboxEpisodeScenario {
  const baseline = createReadMaraEpisode(modelId);
  return {
    ...baseline,
    id: "read-mara-explicit-path",
    version: 1,
    title: "Read a fact about Mara with an explicit path",
    description:
      "Counterfactual for control-token leakage: supplies the exact note path to remove path discovery and recovery.",
    request: {
      ...baseline.request,
      messages: [
        {
          role: "user",
          content:
            "Read Characters/Mara.md. What does Mara carry, and where did it come from?",
        },
      ],
    },
  };
}
