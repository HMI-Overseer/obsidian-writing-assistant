import type { SandboxEpisodeScenario } from "../sandbox/types";
import { createReadMaraEpisode } from "./readMara";
import { createReadCleanCanaryEpisode } from "./readCleanCanary";
import { createReadMaraExplicitPathEpisode } from "./readMaraExplicitPath";
import { createToolSurfaceNoCallEpisode } from "./toolSurfaceNoCall";
import { createReviewedWriteEpisode } from "./reviewedWrite";
import { createReadMaraRecoveryEpisode } from "./readMaraRecovery";
import { createReadMetamorphicVariantEpisode } from "./readMetamorphicVariant";

type EpisodeFactory = (modelId: string) => SandboxEpisodeScenario;

const EPISODES: Readonly<Record<string, EpisodeFactory>> = {
  "read-clean-canary": createReadCleanCanaryEpisode,
  "read-mara": createReadMaraEpisode,
  "read-mara-explicit-path": createReadMaraExplicitPathEpisode,
  "read-mara-recovery": createReadMaraRecoveryEpisode,
  "read-metamorphic-variant": createReadMetamorphicVariantEpisode,
  "reviewed-write": createReviewedWriteEpisode,
  "tool-surface-no-call": createToolSurfaceNoCallEpisode,
};

export function listEpisodeIds(): string[] {
  return Object.keys(EPISODES).sort();
}

export function resolveEpisode(id: string, modelId: string): SandboxEpisodeScenario {
  const factory = EPISODES[id];
  if (!factory) {
    throw new Error(
      `Unknown sandbox episode ${JSON.stringify(id)}. Available episodes: ${listEpisodeIds().join(", ")}.`,
    );
  }
  return factory(modelId);
}
