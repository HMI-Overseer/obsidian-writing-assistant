import type { ModelCandidateResult, ModelDigest } from "./types";
import type { ModelsService, ModelsQueryOptions } from "./modelsService";

/**
 * Model discovery for the Claude Code provider.
 *
 * Claude Code selects models by alias (`--model opus|sonnet|haiku|fable`) rather
 * than exposing a discovery endpoint, so this returns a fixed candidate list. No
 * API key or network call is involved, billing goes through the user's Claude
 * Code session.
 */

interface ClaudeCodeModel {
  /** Value passed to `--model`. */
  alias: string;
  displayName: string;
  summary: string;
}

const CLAUDE_CODE_MODELS: ClaudeCodeModel[] = [
  { alias: "opus", displayName: "Opus (Claude Code)", summary: "Most capable, best for rigorous document review" },
  { alias: "sonnet", displayName: "Sonnet (Claude Code)", summary: "Balanced speed and capability" },
  { alias: "haiku", displayName: "Haiku (Claude Code)", summary: "Fastest, lightest" },
  { alias: "fable", displayName: "Fable (Claude Code)", summary: "Lightweight, fast" },
];

function toDigest(model: ClaudeCodeModel): ModelDigest {
  return {
    id: `completion:claudecode-${model.alias}`,
    kind: "completion",
    displayName: model.displayName,
    targetModelId: model.alias,
    provider: "claudecode",
    summary: model.summary,
  };
}

export class ClaudeCodeModelsService implements ModelsService {
  getCompletionCandidates(_options?: ModelsQueryOptions): Promise<ModelCandidateResult> {
    return Promise.resolve({
      candidates: CLAUDE_CODE_MODELS.map(toDigest),
      source: "claudecode-builtin",
      discoveredAt: Date.now(),
    });
  }

  getEmbeddingCandidates(_options?: ModelsQueryOptions): Promise<ModelCandidateResult> {
    return Promise.resolve({ candidates: [], source: "claudecode-builtin", discoveredAt: Date.now() });
  }
}
