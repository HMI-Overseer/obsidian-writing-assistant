import { describe, test, expect, vi, beforeEach } from "vitest";

// Mock the streaming transport so we can drive onEvent/deltas deterministically
// without a real network call. OpenAIClient only pulls `streamFetch` from here.
vi.mock("../../../src/api/streamingTransport", () => ({
  streamFetch: vi.fn(),
}));

import { OpenAIClient } from "../../../src/api/OpenAIClient";
import { streamFetch } from "../../../src/api/streamingTransport";
import type { ChatRequest } from "../../../src/shared/chatRequest";
import type { SamplingParams } from "../../../src/shared/types";

const mockStreamFetch = vi.mocked(streamFetch);

/** A single simulated SSE event, optionally carrying a text delta. */
interface FakeChunk {
  event?: unknown;
  delta?: string;
}

/**
 * Build a `streamFetch` stand-in that replays the given chunks: each chunk
 * fires `onEvent` (as the transport does for every parsed SSE payload) and
 * optionally yields a text delta (as the real extractor would).
 */
function streamImpl(chunks: FakeChunk[]): typeof streamFetch {
  return async function* (
    _url: string,
    _body: string,
    _signal?: AbortSignal,
    _headers?: Record<string, string>,
    _extractDelta?: unknown,
    onEvent?: (json: unknown) => void,
  ): AsyncGenerator<string> {
    for (const chunk of chunks) {
      if (chunk.event !== undefined) onEvent?.(chunk.event);
      if (chunk.delta !== undefined) yield chunk.delta;
    }
  } as typeof streamFetch;
}

function makeRequest(overrides: Partial<ChatRequest> = {}): ChatRequest {
  return {
    systemPrompt: "",
    documentContext: null,
    ragContext: null,
    messages: [{ role: "user", content: "hi" }],
    ...overrides,
  };
}

function makeParams(): SamplingParams {
  return {
    temperature: 0.7,
    maxTokens: null,
    topP: null,
    topK: null,
    minP: null,
    repeatPenalty: null,
    reasoning: null,
  };
}

/** Drain the deltas generator so the wrapper's finally runs and promises resolve. */
async function drain(deltas: AsyncGenerator<string>): Promise<string> {
  let text = "";
  for await (const d of deltas) text += d;
  return text;
}

describe("OpenAIClient.stream usage accounting", () => {
  beforeEach(() => {
    mockStreamFetch.mockReset();
  });

  test("requests usage accounting via stream_options.include_usage", async () => {
    mockStreamFetch.mockImplementation(streamImpl([]));
    const client = new OpenAIClient("key", "https://api.openai.com/v1");

    const result = client.stream(makeRequest(), "gpt-4o", makeParams());
    await drain(result.deltas);

    const body = JSON.parse(mockStreamFetch.mock.calls[0][1] as string);
    expect(body.stream_options).toEqual({ include_usage: true });
  });

  test("resolves usage from the terminal include_usage chunk", async () => {
    mockStreamFetch.mockImplementation(streamImpl([
      { event: { choices: [{ index: 0, delta: { content: "Hi" } }] }, delta: "Hi" },
      { event: { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] } },
      // Terminal accounting chunk: empty choices, populated usage.
      { event: { choices: [], usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 } } },
    ]));
    const client = new OpenAIClient("key", "https://api.openai.com/v1");

    const result = client.stream(makeRequest(), "gpt-4o", makeParams());
    const text = await drain(result.deltas);

    expect(text).toBe("Hi");
    expect(await result.usage).toEqual({ inputTokens: 12, outputTokens: 5 });
    expect(await result.stopReason).toBe("end_turn");
  });

  test("resolves usage null when the endpoint emits no usage chunk", async () => {
    // LM Studio (and any endpoint that ignores stream_options) sends no terminal
    // usage chunk; usage must stay null rather than fabricate zeros.
    mockStreamFetch.mockImplementation(streamImpl([
      { event: { choices: [{ index: 0, delta: { content: "Hi" } }] }, delta: "Hi" },
      { event: { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] } },
    ]));
    const client = new OpenAIClient("key", "https://api.openai.com/v1");

    const result = client.stream(makeRequest(), "gpt-4o", makeParams());
    await drain(result.deltas);

    expect(await result.usage).toBeNull();
  });

  test("resolves tool calls and usage together on a tool-call stream", async () => {
    mockStreamFetch.mockImplementation(streamImpl([
      { event: { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "propose_edit", arguments: "" } }] } }] } },
      { event: { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: "{\"a\":1}" } }] } }] } },
      { event: { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] } },
      { event: { choices: [], usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 } } },
    ]));
    const client = new OpenAIClient("key", "https://api.openai.com/v1");
    const request = makeRequest({
      tools: [{
        name: "propose_edit",
        description: "Edit the document.",
        parameters: { type: "object", properties: {}, required: [] },
      }],
    });

    const result = client.stream(request, "gpt-4o", makeParams());
    await drain(result.deltas);

    expect(await result.toolCalls).toEqual([
      { id: "call_1", name: "propose_edit", arguments: { a: 1 } },
    ]);
    expect(await result.usage).toEqual({ inputTokens: 20, outputTokens: 8 });
    expect(await result.stopReason).toBe("tool_use");
  });
});
