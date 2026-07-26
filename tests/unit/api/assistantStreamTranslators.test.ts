import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import {
  translateAnthropicStream,
} from "../../../src/api/anthropicStreamTranslator";
import {
  translateOpenAICompatibleStream,
} from "../../../src/api/openAICompatibleStreamTranslator";

interface AnthropicFixture {
  events: unknown[];
}

interface OpenAICompatibleScenario {
  name: string;
  chunks: unknown[];
}

interface OpenAICompatibleFixture {
  scenarios: OpenAICompatibleScenario[];
}

function fixture<T>(name: string): T {
  const path = join(
    process.cwd(),
    "tests",
    "fixtures",
    "assistant-turns",
    name,
  );
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

describe("Anthropic ordered stream translation", () => {
  it("preserves content-block order and retains one validated thinking capsule", () => {
    const input = fixture<AnthropicFixture>("anthropic-interleaved-blocks.json");
    const translated = translateAnthropicStream(input.events, {
      segmentId: "segment-anthropic",
    });

    expect(translated.events).toEqual([
      {
        type: "segment_start",
        segmentId: "segment-anthropic",
        providerMessageId: "msg_fixture_anthropic_1",
      },
      {
        type: "prose_delta",
        segmentId: "segment-anthropic",
        delta: "I will inspect the fixture note.",
      },
      {
        type: "tool_call_start",
        segmentId: "segment-anthropic",
        declarationKey: "segment-anthropic:block:2",
        toolName: "read_file",
      },
      {
        type: "tool_call_identity",
        declarationKey: "segment-anthropic:block:2",
        toolCallId: "toolu_fixture_read_1",
        correlation: "provider_id",
      },
      {
        type: "tool_call_delta",
        declarationKey: "segment-anthropic:block:2",
        argumentsDelta: "{\"path\":\"Fixtures/alpha.md\"}",
      },
      {
        type: "prose_delta",
        segmentId: "segment-anthropic",
        delta: "The fixture needs one small change.",
      },
      {
        type: "tool_call_start",
        segmentId: "segment-anthropic",
        declarationKey: "segment-anthropic:block:4",
        toolName: "propose_edit",
      },
      {
        type: "tool_call_identity",
        declarationKey: "segment-anthropic:block:4",
        toolCallId: "toolu_fixture_edit_1",
        correlation: "provider_id",
      },
      {
        type: "tool_call_delta",
        declarationKey: "segment-anthropic:block:4",
        argumentsDelta:
          "{\"path\":\"Fixtures/alpha.md\",\"search\":\"old\",\"replace\":\"new\"}",
      },
      { type: "segment_end", segmentId: "segment-anthropic" },
      { type: "turn_end", status: "completed" },
    ]);
    expect(translated.usage).toEqual({
      inputTokens: 12,
      outputTokens: 31,
    });
    expect(translated.stopReason).toBe("tool_use");
    expect(translated.replayCapsule).toEqual({
      provider: "anthropic",
      version: 1,
      thinkingBlocks: [
        {
          type: "thinking",
          thinking: "Inspect the synthetic note first.",
          signature: "sig_fixture_anthropic_1",
        },
      ],
    });
    expect(translated.replayEvidence).toEqual({
      tier: "structural",
      capabilities: {
        captureOrder: "exact",
        toolCorrelation: "provider_id",
        coldReplay: "structural",
        nativeResume: false,
      },
    });
  });

  it("rejects the complete thinking capsule when one block is invalid", () => {
    const input = fixture<AnthropicFixture>("anthropic-interleaved-blocks.json");
    const events = structuredClone(input.events) as Array<Record<string, unknown>>;
    const signature = events.find((event) => {
      const delta = event.delta as Record<string, unknown> | undefined;
      return delta?.type === "signature_delta";
    });
    if (signature) {
      signature.delta = { type: "signature_delta", signature: "" };
    }

    const translated = translateAnthropicStream(events, {
      segmentId: "segment-invalid-capsule",
    });

    expect(translated.replayCapsule).toBeNull();
    expect(translated.replayEvidence).toMatchObject({
      tier: "textual",
      loweredReason: "anthropic_replay_capsule_invalid",
    });
  });
});

describe("OpenAI-compatible ordered stream translation", () => {
  const input = fixture<OpenAICompatibleFixture>(
    "openai-compatible-interleaved-chunks.json",
  );
  const scenario = (name: string): OpenAICompatibleScenario => {
    const found = input.scenarios.find((candidate) => candidate.name === name);
    if (!found) throw new Error(`Missing fixture scenario ${name}.`);
    return found;
  };

  it("preserves observed interleaving and multiple declaration indices", () => {
    const translated = translateOpenAICompatibleStream(
      scenario("several_indices_with_provider_ids").chunks,
      { segmentId: "segment-multi", provider: "openai" },
    );

    expect(translated.events).toEqual([
      {
        type: "segment_start",
        segmentId: "segment-multi",
        providerMessageId: "chatcmpl_fixture_multi",
      },
      {
        type: "prose_delta",
        segmentId: "segment-multi",
        delta: "I will inspect two fixtures.",
      },
      {
        type: "tool_call_start",
        segmentId: "segment-multi",
        declarationKey: "segment-multi:tool:0",
        toolName: "read_file",
      },
      {
        type: "tool_call_identity",
        declarationKey: "segment-multi:tool:0",
        toolCallId: "call_fixture_read_a",
        correlation: "provider_id",
      },
      {
        type: "tool_call_delta",
        declarationKey: "segment-multi:tool:0",
        argumentsDelta: "{\"path\":\"Fixtures/a.md\"}",
      },
      {
        type: "tool_call_start",
        segmentId: "segment-multi",
        declarationKey: "segment-multi:tool:1",
        toolName: "read_file",
      },
      {
        type: "tool_call_identity",
        declarationKey: "segment-multi:tool:1",
        toolCallId: "call_fixture_read_b",
        correlation: "provider_id",
      },
      {
        type: "tool_call_delta",
        declarationKey: "segment-multi:tool:1",
        argumentsDelta: "{\"path\":\"Fixtures/b.md\"}",
      },
      {
        type: "prose_delta",
        segmentId: "segment-multi",
        delta: "Both declarations belong to this observed emission.",
      },
      { type: "segment_end", segmentId: "segment-multi" },
      { type: "turn_end", status: "completed" },
    ]);
    expect(translated.replayEvidence.tier).toBe("structural");
  });

  it("binds a delayed provider ID without changing declaration identity", () => {
    const translated = translateOpenAICompatibleStream(
      scenario("provider_id_arrives_after_declaration_start").chunks,
      { segmentId: "segment-delayed", provider: "openai" },
    );

    const startIndex = translated.events.findIndex(
      (event) => event.type === "tool_call_start",
    );
    const identityIndex = translated.events.findIndex(
      (event) => event.type === "tool_call_identity",
    );
    expect(startIndex).toBeGreaterThanOrEqual(0);
    expect(identityIndex).toBeGreaterThan(startIndex);
    expect(translated.events[startIndex]).toMatchObject({
      declarationKey: "segment-delayed:tool:0",
    });
    expect(translated.events[identityIndex]).toEqual({
      type: "tool_call_identity",
      declarationKey: "segment-delayed:tool:0",
      toolCallId: "call_fixture_delayed",
      correlation: "provider_id",
    });
    expect(translated.events).toContainEqual({
      type: "prose_delta",
      segmentId: "segment-delayed",
      delta: "The provider ID arrived without changing declaration position.",
    });
  });

  it("mints the exact fallback identity only immediately before segment completion", () => {
    const translated = translateOpenAICompatibleStream(
      scenario("provider_id_missing_for_entire_segment").chunks,
      { segmentId: "segment-missing", provider: "lmstudio" },
    );

    const identityIndex = translated.events.findIndex(
      (event) => event.type === "tool_call_identity",
    );
    const segmentEndIndex = translated.events.findIndex(
      (event) => event.type === "segment_end",
    );
    expect(translated.events[identityIndex]).toEqual({
      type: "tool_call_identity",
      declarationKey: "segment-missing:tool:0",
      toolCallId: "lmsa-tool-segment-missing-0",
      correlation: "plugin_id",
    });
    expect(identityIndex).toBe(segmentEndIndex - 1);
    expect(translated.replayEvidence).toMatchObject({
      tier: "structural",
      capabilities: {
        toolCorrelation: "plugin_id",
      },
      loweredReason: "provider_tool_call_id_missing",
    });
  });

  it("retains malformed argument bytes and lowers replay to textual", () => {
    const translated = translateOpenAICompatibleStream(
      scenario("malformed_arguments").chunks,
      { segmentId: "segment-bad-args", provider: "lmstudio" },
    );

    expect(translated.events).toContainEqual({
      type: "tool_call_delta",
      declarationKey: "segment-bad-args:tool:0",
      argumentsDelta: "{\"path\":\"Fixtures/a.md\",\"search\":",
    });
    expect(translated.replayEvidence).toMatchObject({
      tier: "textual",
      loweredReason: "tool_arguments_invalid",
    });
  });
});
