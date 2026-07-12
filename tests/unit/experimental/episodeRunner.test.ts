import { describe, expect, it, vi } from "vitest";
import { READ_CONTROL_FIXTURE } from "../../../experimental/fixtures/readControl";
import { createReadMaraEpisode } from "../../../experimental/episodes/readMara";
import { createReadMaraExplicitPathEpisode } from "../../../experimental/episodes/readMaraExplicitPath";
import { createReadCleanCanaryEpisode } from "../../../experimental/episodes/readCleanCanary";
import { createReviewedWriteEpisode } from "../../../experimental/episodes/reviewedWrite";
import { TOOL_RESULT_CONTROL_TOKEN_PREFIX_NORMALIZER } from "../../../experimental/candidates/toolResultControlTokenPrefix";
import { runSandboxEpisode } from "../../../experimental/sandbox/episodeRunner";
import type { SandboxEpisodeScenario } from "../../../experimental/sandbox/types";
import type { ChatClient } from "../../../src/api/chatClient";
import type { ChatRequest } from "../../../src/shared/chatRequest";

function scenario(): SandboxEpisodeScenario {
  return {
    schemaVersion: 1,
    id: "read-mara",
    version: 1,
    title: "Read Mara",
    description: "Read a fact from a synthetic note.",
    modelId: "test-model",
    samplingParams: {
      temperature: 0,
      maxTokens: 64,
      topP: null,
      topK: null,
      minP: null,
      repeatPenalty: null,
      reasoning: null,
    },
    fixture: READ_CONTROL_FIXTURE,
    request: {
      systemPrompt: "Use the available tool to answer from the synthetic vault.",
      documentContext: null,
      ragContext: null,
      messages: [{ role: "user", content: "What does Mara carry?" }],
    },
  };
}

function clientWithComplete(complete: ChatClient["complete"]): ChatClient {
  return {
    complete,
    stream: vi.fn(() => {
      throw new Error("The sandbox slice uses non-streaming completions.");
    }),
  };
}

describe("runSandboxEpisode", () => {
  it("executes a read-only tool round and feeds its result into the next round", async () => {
    const requests: ChatRequest[] = [];
    const complete = vi.fn(async (request: ChatRequest) => {
      requests.push(structuredClone(request));
      if (requests.length === 1) {
        return {
          text: "",
          usage: { inputTokens: 20, outputTokens: 5 },
          toolCalls: [
            {
              id: "call-1",
              name: "read_file",
              arguments: { path: "Characters/Mara.md" },
            },
          ],
          stopReason: "tool_use" as const,
        };
      }
      return {
        text: "Mara carries a brass compass inherited from her grandmother.",
        usage: { inputTokens: 50, outputTokens: 12 },
        toolCalls: null,
        stopReason: "end_turn" as const,
      };
    });

    const trace = await runSandboxEpisode(
      clientWithComplete(complete),
      scenario(),
      { createEpisodeId: () => "episode-1", now: () => 1_000 },
    );

    expect(trace).toMatchObject({
      kind: "sandbox-episode",
      episodeId: "episode-1",
      outcome: { kind: "completed" },
      passed: true,
      finalText: "Mara carries a brass compass inherited from her grandmother.",
    });
    expect(trace.provenance.subject).toEqual({
      provider: "unspecified",
      modelId: "test-model",
    });
    expect(trace.rounds).toHaveLength(2);
    expect(trace.rounds[0].toolExecutions[0]).toMatchObject({
      call: { name: "read_file" },
      result: { isReadOnly: true },
    });
    expect(trace.initialSnapshot).toEqual(trace.finalSnapshot);
    expect(requests[0].tools?.map((tool) => tool.name)).toEqual(["read_file"]);
    expect(requests[1].messages.slice(-2)).toMatchObject([
      { role: "assistant", toolCalls: [{ id: "call-1", name: "read_file" }] },
      { role: "tool", toolCallId: "call-1" },
    ]);
  });

  it("records and fails a round limit without escaping the read-only state", async () => {
    const client = clientWithComplete(async () => ({
      text: "",
      usage: null,
      toolCalls: [
        { id: "repeat", name: "read_file", arguments: { path: "Characters/Mara.md" } },
      ],
      stopReason: "tool_use",
    }));

    const trace = await runSandboxEpisode(client, scenario(), {
      maxRounds: 2,
      maxToolCalls: 5,
      createEpisodeId: () => "episode-2",
      now: () => 2_000,
    });

    expect(trace.outcome).toEqual({ kind: "round-limit", limit: 2 });
    expect(trace.passed).toBe(false);
    expect(trace.checks[0]).toMatchObject({ id: "episode-completed", passed: false });
    expect(trace.initialSnapshot).toEqual(trace.finalSnapshot);
  });

  it("refuses calls beyond the episode tool budget before executing them", async () => {
    const client = clientWithComplete(async () => ({
      text: "",
      usage: null,
      toolCalls: [
        { id: "one", name: "read_file", arguments: { path: "Characters/Mara.md" } },
        { id: "two", name: "read_file", arguments: { path: "Locations/Old Harbor.md" } },
      ],
      stopReason: "tool_use",
    }));

    const trace = await runSandboxEpisode(client, scenario(), {
      maxToolCalls: 1,
      createEpisodeId: () => "episode-3",
      now: () => 3_000,
    });

    expect(trace.outcome).toEqual({ kind: "tool-call-limit", limit: 1 });
    expect(trace.rounds[0].toolExecutions).toEqual([]);
    expect(trace.initialSnapshot).toEqual(trace.finalSnapshot);
  });

  it("enforces repeated-call, token, and output bounds before another tool executes", async () => {
    const repeatedClient = clientWithComplete(async () => ({
      text: "",
      usage: null,
      toolCalls: [
        { id: "one", name: "read_file", arguments: { path: "Characters/Mara.md" } },
        { id: "two", name: "read_file", arguments: { path: "Characters/Mara.md" } },
      ],
      stopReason: "tool_use",
    }));
    const repeated = await runSandboxEpisode(repeatedClient, scenario(), {
      maxRepeatedToolCalls: 1,
      createEpisodeId: () => "repeated-limit",
      now: () => 3_100,
    });
    expect(repeated.outcome).toEqual({ kind: "repeated-tool-call-limit", limit: 1 });
    expect(repeated.rounds[0].toolExecutions).toEqual([]);

    const token = await runSandboxEpisode(clientWithComplete(async () => ({
      text: "short",
      usage: { inputTokens: 8, outputTokens: 3 },
      toolCalls: null,
      stopReason: "end_turn",
    })), scenario(), {
      maxTotalTokens: 10,
      createEpisodeId: () => "token-limit",
      now: () => 3_200,
    });
    expect(token.outcome).toEqual({ kind: "token-limit", limit: 10 });

    const output = await runSandboxEpisode(clientWithComplete(async () => ({
      text: "12345",
      usage: null,
      toolCalls: null,
      stopReason: "end_turn",
    })), scenario(), {
      maxOutputChars: 4,
      createEpisodeId: () => "output-limit",
      now: () => 3_300,
    });
    expect(output.outcome).toEqual({ kind: "output-limit", limit: 4 });
  });

  it("fails the versioned episode when chat-template control tokens leak", async () => {
    let round = 0;
    const client = clientWithComplete(async () => {
      round++;
      if (round === 1) {
        return {
          text: "<|channel>thought\n<channel|>",
          usage: null,
          toolCalls: [
            {
              id: "read",
              name: "read_file",
              arguments: { path: "Characters/Mara.md" },
            },
          ],
          stopReason: "tool_use",
        };
      }
      return {
        text: "<|channel>thought\n<channel|>Mara carries a brass compass from her grandmother.",
        usage: null,
        toolCalls: null,
        stopReason: "end_turn",
      };
    });

    const trace = await runSandboxEpisode(
      client,
      createReadMaraEpisode("test-model"),
      { createEpisodeId: () => "leak", now: () => 4_000 },
    );

    expect(trace.scenario.version).toBe(2);
    expect(trace.passed).toBe(false);
    expect(trace.checks).toContainEqual(expect.objectContaining({
      id: "no-control-token-leak",
      passed: false,
      required: true,
    }));
    expect(trace.checks).toContainEqual(expect.objectContaining({
      id: "target-path-first-attempt",
      passed: true,
      required: false,
    }));
  });

  it("retains raw provider text while evaluating the normalized candidate text", async () => {
    let round = 0;
    const client = clientWithComplete(async () => {
      round++;
      if (round === 1) {
        return {
          text: "",
          usage: { inputTokens: 264, outputTokens: 19 },
          toolCalls: [{
            id: "read",
            name: "read_file",
            arguments: { path: "Characters/Mara.md" },
          }],
          stopReason: "tool_use",
        };
      }
      return {
        text: "<|channel>thought\n<channel|>Mara carries a brass compass from her grandmother.",
        usage: { inputTokens: 319, outputTokens: 20 },
        toolCalls: null,
        stopReason: "end_turn",
      };
    });

    const trace = await runSandboxEpisode(
      client,
      createReadMaraExplicitPathEpisode("test-model"),
      {
        createEpisodeId: () => "normalized-candidate",
        now: () => 5_000,
        responseNormalizer: TOOL_RESULT_CONTROL_TOKEN_PREFIX_NORMALIZER,
      },
    );

    expect(trace.schemaVersion).toBe(5);
    expect(trace.scenario).toMatchObject({ id: "read-mara-explicit-path", version: 1 });
    expect(trace.conditions.responseNormalization).toEqual({
      id: "tool-result-control-token-prefix",
      version: 1,
    });
    expect(trace.passed).toBe(true);
    expect(trace.rounds[1]).toMatchObject({
      rawResponse: {
        text: "<|channel>thought\n<channel|>Mara carries a brass compass from her grandmother.",
      },
      response: { text: "Mara carries a brass compass from her grandmother." },
      normalization: { changed: true },
    });
    expect(trace.finalText).toBe("Mara carries a brass compass from her grandmother.");
    expect(trace.checks).toContainEqual(expect.objectContaining({
      id: "no-control-token-leak",
      passed: true,
    }));
  });

  it("records, applies, diffs, and replays a reviewed multi-round edit", async () => {
    let round = 0;
    const client = clientWithComplete(async () => {
      round++;
      if (round === 1) {
        return {
          text: "",
          usage: null,
          toolCalls: [{
            id: "read",
            name: "read_file",
            arguments: { path: "Projects/Lighthouse.md" },
          }],
          stopReason: "tool_use",
        };
      }
      if (round === 2) {
        return {
          text: "",
          usage: null,
          toolCalls: [{
            id: "write",
            name: "write_file",
            arguments: {
              path: "Projects/Lighthouse.md",
              content: "# Lighthouse\n\nStatus: final\n",
            },
          }],
          stopReason: "tool_use",
        };
      }
      return { text: "Updated the status.", usage: null, toolCalls: null, stopReason: "end_turn" };
    });

    const trace = await runSandboxEpisode(client, createReviewedWriteEpisode("test-model"), {
      createEpisodeId: () => "reviewed-write",
      now: () => 7_000,
    });

    expect(trace.passed).toBe(true);
    expect(trace.rounds).toHaveLength(3);
    expect(trace.rounds[1].toolExecutions[0]).toMatchObject({
      review: { disposition: "applied", applied: true },
      result: { disposition: "applied" },
    });
    expect(trace.stateDiff).toMatchObject({
      created: [],
      deleted: [],
      modified: [{ after: { path: "Projects/Lighthouse.md", content: "# Lighthouse\n\nStatus: final\n" } }],
    });
    expect(trace.checks).toContainEqual(expect.objectContaining({
      id: "state-transitions-replay",
      passed: true,
    }));
  });

  it("passes clean post-tool text through the candidate without changing it", async () => {
    let round = 0;
    const client = clientWithComplete(async () => {
      round++;
      if (round === 1) {
        return {
          text: "",
          usage: null,
          toolCalls: [{
            id: "read-canary",
            name: "read_file",
            arguments: { path: "Locations/Old Harbor.md" },
          }],
          stopReason: "tool_use",
        };
      }
      return {
        text: "LAB_CANARY_CLEAN",
        usage: null,
        toolCalls: null,
        stopReason: "end_turn",
      };
    });

    const trace = await runSandboxEpisode(
      client,
      createReadCleanCanaryEpisode("known-clean-model"),
      {
        createEpisodeId: () => "clean-canary",
        now: () => 6_000,
        responseNormalizer: TOOL_RESULT_CONTROL_TOKEN_PREFIX_NORMALIZER,
      },
    );

    expect(trace.passed).toBe(true);
    expect(trace.finalText).toBe("LAB_CANARY_CLEAN");
    expect(trace.rounds).toHaveLength(2);
    expect(trace.rounds.every((entry) => !entry.normalization.changed)).toBe(true);
    expect(trace.checks).toContainEqual(expect.objectContaining({
      id: "normalizer-preserved-clean-text",
      passed: true,
    }));
  });
});
