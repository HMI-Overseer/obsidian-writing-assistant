import { describe, test, expect } from "vitest";
import {
  buildAnthropicMessages,
  buildAnthropicHeaders,
  buildAnthropicPayload,
} from "../../../src/api/buildAnthropicPayload";
import type { ChatRequest } from "../../../src/shared/chatRequest";
import type { SamplingParams, AnthropicCacheSettings } from "../../../src/shared/types";

function makeRequest(overrides: Partial<ChatRequest> = {}): ChatRequest {
  return {
    systemPrompt: "You are helpful.",
    documentContext: null,
    ragContext: null,
    messages: [{ role: "user", content: "Hello" }],
    ...overrides,
  };
}

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

describe("buildAnthropicMessages", () => {
  test("without cache returns system as plain string", () => {
    const { system } = buildAnthropicMessages(makeRequest());
    expect(typeof system).toBe("string");
    expect(system).toBe("You are helpful.");
  });

  test("with cache enabled returns system as content block array with cache_control", () => {
    const cache: AnthropicCacheSettings = { enabled: true, ttl: "default" };
    const { system } = buildAnthropicMessages(makeRequest(), cache);
    expect(Array.isArray(system)).toBe(true);
    expect(system).toEqual([
      { type: "text", text: "You are helpful.", cache_control: { type: "ephemeral" } },
    ]);
  });

  test("with cache enabled but empty system returns plain empty string", () => {
    const cache: AnthropicCacheSettings = { enabled: true, ttl: "default" };
    const { system } = buildAnthropicMessages(
      makeRequest({ systemPrompt: "", documentContext: null }),
      cache
    );
    expect(typeof system).toBe("string");
    expect(system).toBe("");
  });

  test("with cache disabled returns system as plain string even when settings present", () => {
    const cache: AnthropicCacheSettings = { enabled: false, ttl: "default" };
    const { system } = buildAnthropicMessages(makeRequest(), cache);
    expect(typeof system).toBe("string");
    expect(system).toBe("You are helpful.");
  });

  test("includes document context in system text", () => {
    const { system } = buildAnthropicMessages(
      makeRequest({
        systemPrompt: "Be concise.",
        documentContext: { filePath: "note.md", content: "Some content", isFull: false },
      })
    );
    expect(typeof system).toBe("string");
    expect(system).toContain("Be concise.");
    expect(system).toContain("Current note (note.md)");
    expect(system).toContain("Some content");
  });

  test("uses 'Document to edit' label when isFull is true", () => {
    const { system } = buildAnthropicMessages(
      makeRequest({
        systemPrompt: "",
        documentContext: { filePath: "doc.md", content: "Full doc", isFull: true },
      })
    );
    expect(system).toContain("Document to edit (doc.md)");
  });

  test("maps conversation turns to Anthropic message format", () => {
    const { messages } = buildAnthropicMessages(
      makeRequest({
        messages: [
          { role: "user", content: "Hi" },
          { role: "assistant", content: "Hello" },
        ],
      })
    );
    expect(messages).toEqual([
      { role: "user", content: "Hi" },
      { role: "assistant", content: "Hello" },
    ]);
  });
});

describe("buildAnthropicHeaders", () => {
  test("without cache has no beta header", () => {
    const headers = buildAnthropicHeaders("sk-test", "2023-06-01");
    expect(headers).not.toHaveProperty("anthropic-beta");
    expect(headers["x-api-key"]).toBe("sk-test");
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    expect(headers["Content-Type"]).toBe("application/json");
  });

  test("with cache enabled + default TTL has no beta header", () => {
    const cache: AnthropicCacheSettings = { enabled: true, ttl: "default" };
    const headers = buildAnthropicHeaders("sk-test", "2023-06-01", cache);
    expect(headers).not.toHaveProperty("anthropic-beta");
  });

  test("with cache enabled + 1h TTL includes beta header", () => {
    const cache: AnthropicCacheSettings = { enabled: true, ttl: "1h" };
    const headers = buildAnthropicHeaders("sk-test", "2023-06-01", cache);
    expect(headers["anthropic-beta"]).toBe("prompt-caching-2024-07-31");
  });

  test("with cache disabled + 1h TTL does not include beta header", () => {
    const cache: AnthropicCacheSettings = { enabled: false, ttl: "1h" };
    const headers = buildAnthropicHeaders("sk-test", "2023-06-01", cache);
    expect(headers).not.toHaveProperty("anthropic-beta");
  });
});

describe("buildAnthropicPayload", () => {
  test("with string system includes system in body", () => {
    const json = JSON.parse(
      buildAnthropicPayload("claude-3", "You are helpful.", [], makeParams(), false)
    );
    expect(json.system).toBe("You are helpful.");
  });

  test("with array system includes system array in body", () => {
    const systemBlocks = [
      { type: "text" as const, text: "Hello", cache_control: { type: "ephemeral" } },
    ];
    const json = JSON.parse(
      buildAnthropicPayload("claude-3", systemBlocks, [], makeParams(), false)
    );
    expect(json.system).toEqual(systemBlocks);
  });

  test("omits system when empty string", () => {
    const json = JSON.parse(
      buildAnthropicPayload("claude-3", "", [], makeParams(), false)
    );
    expect(json).not.toHaveProperty("system");
  });

  test("omits system when empty array", () => {
    const json = JSON.parse(
      buildAnthropicPayload("claude-3", [], [], makeParams(), false)
    );
    expect(json).not.toHaveProperty("system");
  });

  test("uses default max_tokens of 4096 when not specified", () => {
    const json = JSON.parse(
      buildAnthropicPayload("claude-3", "", [], makeParams(), false)
    );
    expect(json.max_tokens).toBe(4096);
  });

  test("uses provided max_tokens when set", () => {
    const json = JSON.parse(
      buildAnthropicPayload("claude-3", "", [], makeParams({ maxTokens: 8192 }), false)
    );
    expect(json.max_tokens).toBe(8192);
  });

  test("omits minP and repeatPenalty (Anthropic unsupported)", () => {
    const json = JSON.parse(
      buildAnthropicPayload(
        "claude-3", "", [],
        makeParams({ minP: 0.05, repeatPenalty: 1.1 }),
        false
      )
    );
    expect(json).not.toHaveProperty("min_p");
    expect(json).not.toHaveProperty("repeat_penalty");
  });

  test("includes optional params when set", () => {
    const json = JSON.parse(
      buildAnthropicPayload(
        "claude-3", "sys", [],
        makeParams({ temperature: 0.5, topP: 0.9, topK: 40 }),
        true
      )
    );
    expect(json.temperature).toBe(0.5);
    expect(json.top_p).toBe(0.9);
    expect(json.top_k).toBe(40);
    expect(json.stream).toBe(true);
  });

  test("returns valid JSON string", () => {
    const result = buildAnthropicPayload("claude-3", "sys", [], makeParams(), true);
    expect(() => JSON.parse(result)).not.toThrow();
  });
});
