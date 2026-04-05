import { describe, test, expect } from "vitest";
import { buildCompletionPayload } from "../../../src/api/buildPayload";
import type { Message, SamplingParams } from "../../../src/shared/types";

const MESSAGES: Message[] = [
  { role: "system", content: "You are helpful." },
  { role: "user", content: "Hello" },
];

/** SamplingParams with all optional fields null. */
function makeParams(overrides: Partial<SamplingParams> = {}): SamplingParams {
  return {
    temperature: 0.7,
    maxTokens: null,
    topP: null,
    topK: null,
    minP: null,
    repeatPenalty: null,
    reasoning: null,
    ...overrides,
  };
}

describe("buildCompletionPayload", () => {
  test("includes model, messages, temperature, and stream", () => {
    const json = JSON.parse(
      buildCompletionPayload("test-model", MESSAGES, makeParams(), true)
    );

    expect(json.model).toBe("test-model");
    expect(json.messages).toEqual(MESSAGES);
    expect(json.temperature).toBe(0.7);
    expect(json.stream).toBe(true);
  });

  test("omits optional params when null", () => {
    const json = JSON.parse(
      buildCompletionPayload("m", MESSAGES, makeParams(), false)
    );

    expect(json).not.toHaveProperty("max_tokens");
    expect(json).not.toHaveProperty("top_p");
    expect(json).not.toHaveProperty("top_k");
    expect(json).not.toHaveProperty("min_p");
    expect(json).not.toHaveProperty("repeat_penalty");
    expect(json).not.toHaveProperty("reasoning");
  });

  test("includes all optional params when set", () => {
    const params = makeParams({
      maxTokens: 2048,
      topP: 0.9,
      topK: 40,
      minP: 0.05,
      repeatPenalty: 1.1,
      reasoning: "high",
    });

    const json = JSON.parse(
      buildCompletionPayload("m", MESSAGES, params, true)
    );

    expect(json.max_tokens).toBe(2048);
    expect(json.top_p).toBe(0.9);
    expect(json.top_k).toBe(40);
    expect(json.min_p).toBe(0.05);
    expect(json.repeat_penalty).toBe(1.1);
    expect(json.reasoning).toBe("high");
  });

  test("uses correct OpenAI-compatible field names (snake_case)", () => {
    const params = makeParams({
      maxTokens: 100,
      topP: 0.5,
      topK: 10,
      minP: 0.01,
      repeatPenalty: 1.2,
    });

    const json = JSON.parse(
      buildCompletionPayload("m", MESSAGES, params, false)
    );

    // Must NOT have camelCase versions
    expect(json).not.toHaveProperty("maxTokens");
    expect(json).not.toHaveProperty("topP");
    expect(json).not.toHaveProperty("topK");
    expect(json).not.toHaveProperty("minP");
    expect(json).not.toHaveProperty("repeatPenalty");
  });

  test("preserves zero values (not treated as null)", () => {
    const params = makeParams({ maxTokens: 0, topP: 0 });

    const json = JSON.parse(
      buildCompletionPayload("m", MESSAGES, params, false)
    );

    expect(json.max_tokens).toBe(0);
    expect(json.top_p).toBe(0);
  });

  test("stream flag is reflected in payload", () => {
    const streamOn = JSON.parse(
      buildCompletionPayload("m", MESSAGES, makeParams(), true)
    );
    const streamOff = JSON.parse(
      buildCompletionPayload("m", MESSAGES, makeParams(), false)
    );

    expect(streamOn.stream).toBe(true);
    expect(streamOff.stream).toBe(false);
  });

  test("returns valid JSON string", () => {
    const result = buildCompletionPayload("m", MESSAGES, makeParams(), true);

    expect(() => JSON.parse(result)).not.toThrow();
  });

  test("includes tools when provided", () => {
    const tools = [{
      type: "function" as const,
      function: { name: "apply_edit", description: "Edit.", parameters: {} },
    }];
    const json = JSON.parse(
      buildCompletionPayload("m", MESSAGES, makeParams(), false, tools)
    );
    expect(json.tools).toEqual(tools);
  });

  test("omits tools when undefined", () => {
    const json = JSON.parse(
      buildCompletionPayload("m", MESSAGES, makeParams(), false)
    );
    expect(json).not.toHaveProperty("tools");
  });

  test("omits tools when empty array", () => {
    const json = JSON.parse(
      buildCompletionPayload("m", MESSAGES, makeParams(), false, [])
    );
    expect(json).not.toHaveProperty("tools");
  });
});
