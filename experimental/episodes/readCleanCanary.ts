import { READ_CONTROL_FIXTURE } from "../fixtures/readControl";
import { normalizeSyntheticPath } from "../sandbox/syntheticVault";
import type { SandboxEpisodeScenario } from "../sandbox/types";

const TARGET_PATH = "Locations/Old Harbor.md";
const CLEAN_SENTINEL = "LAB_CANARY_CLEAN";

export function createReadCleanCanaryEpisode(modelId: string): SandboxEpisodeScenario {
  return {
    schemaVersion: 1,
    id: "read-clean-canary",
    version: 1,
    title: "Preserve clean text after a tool result",
    description:
      "Canary proving an experimental normalizer preserves clean text after a read_file result.",
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
        `Read ${TARGET_PATH} before replying. After the tool result, reply with exactly: ` +
        CLEAN_SENTINEL,
      documentContext: null,
      ragContext: null,
      messages: [{
        role: "user",
        content: `Read ${TARGET_PATH}, then return the required exact response.`,
      }],
    },
    evaluators: [
      {
        id: "read-canary-note",
        label: "The model reads the canary note",
        evaluate: ({ rounds }) => {
          const calls = rounds.flatMap((round) => round.toolExecutions.map(({ call }) => call));
          return calls.some((call) => {
            if (call.name !== "read_file" || typeof call.arguments.path !== "string") return false;
            const normalized = normalizeSyntheticPath(call.arguments.path);
            return normalized.ok && normalized.path === TARGET_PATH;
          });
        },
      },
      {
        id: "exact-clean-sentinel",
        label: `The final response is exactly ${CLEAN_SENTINEL}`,
        evaluate: ({ finalText }) => finalText === CLEAN_SENTINEL,
      },
      {
        id: "normalizer-preserved-clean-text",
        label: "The response normalizer preserves every clean response",
        evaluate: ({ rounds }) => {
          const changedRound = rounds.find(
            (round) => round.rawResponse.text !== round.response.text,
          );
          return {
            passed: changedRound === undefined,
            ...(changedRound
              ? { detail: `Round ${changedRound.round} required normalization.` }
              : {}),
          };
        },
      },
    ],
  };
}
