import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";

// Mock the node transport so complete() never touches the network; we drive
// success / failure per attempt to exercise the withRetry wrapper.
vi.mock("../../../src/api/httpTransport", () => ({
  nodeRequestWithHeaders: vi.fn(),
}));

// Mock the streaming transport so stream() can replay SSE events deterministically.
vi.mock("../../../src/api/streamingTransport", () => ({
  streamNode: vi.fn(),
}));

import { AnthropicClient } from "../../../src/api/AnthropicClient";
import { nodeRequestWithHeaders } from "../../../src/api/httpTransport";
import { streamNode } from "../../../src/api/streamingTransport";
import type { ChatRequest } from "../../../src/shared/chatRequest";
import type { SamplingParams } from "../../../src/shared/types";

const mockRequest = vi.mocked(nodeRequestWithHeaders);
const mockStreamNode = vi.mocked(streamNode);

/** A streamNode stand-in that fires the given SSE events via onEvent, yields no text. */
function streamNodeImpl(events: unknown[]): typeof streamNode {
  return async function* (
    _url: string,
    _payload: string,
    _signal?: AbortSignal,
    _headers?: Record<string, string>,
    _extractDelta?: unknown,
    onEvent?: (json: unknown) => void,
  ): AsyncGenerator<string> {
    for (const ev of events) onEvent?.(ev);
  } as typeof streamNode;
}

function toolUseEvents(partialJson: string): unknown[] {
  return [
    {
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id: "toolu_1", name: "propose_edit" },
    },
    { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: partialJson } },
    { type: "content_block_stop", index: 0 },
  ];
}

/** A minimal but valid Anthropic /v1/messages success body. */
function successBody(text = "ok"): { body: string; headers: Record<string, string> } {
  return {
    body: JSON.stringify({
      content: [{ type: "text", text }],
      usage: { input_tokens: 3, output_tokens: 5 },
      stop_reason: "end_turn",
    }),
    headers: {},
  };
}

function makeRequest(): ChatRequest {
  return {
    systemPrompt: "",
    documentContext: null,
    ragContext: null,
    messages: [{ role: "user", content: "hi" }],
  } as ChatRequest;
}

function makeParams(): SamplingParams {
  return { temperature: 0.7, maxTokens: 100 } as SamplingParams;
}

describe("AnthropicClient.complete retry", () => {
  beforeEach(() => {
    mockRequest.mockReset();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("retries a transient 5xx and returns the eventual success", async () => {
    mockRequest
      .mockRejectedValueOnce(new Error("HTTP 529: overloaded"))
      .mockResolvedValueOnce(successBody("recovered"));

    const client = new AnthropicClient("test-key");
    const p = client.complete(makeRequest(), "claude-opus-4-8", makeParams());

    // Advance past withRetry's first backoff so the second attempt runs.
    await vi.advanceTimersByTimeAsync(1000);
    const result = await p;

    expect(mockRequest).toHaveBeenCalledTimes(2);
    expect(result.text).toBe("recovered");
    expect(result.stopReason).toBe("end_turn");
  });

  test("does not retry a 4xx (bad request fails fast)", async () => {
    mockRequest.mockRejectedValue(new Error("HTTP 400: invalid_request_error"));

    const client = new AnthropicClient("test-key");
    const p = client.complete(makeRequest(), "claude-opus-4-8", makeParams());

    await expect(p).rejects.toThrow("HTTP 400");
    expect(mockRequest).toHaveBeenCalledTimes(1);
  });

  test("succeeds on the first attempt without any delay", async () => {
    mockRequest.mockResolvedValueOnce(successBody("first-try"));

    const client = new AnthropicClient("test-key");
    const result = await client.complete(makeRequest(), "claude-opus-4-8", makeParams());

    expect(mockRequest).toHaveBeenCalledTimes(1);
    expect(result.text).toBe("first-try");
  });
});

describe("AnthropicClient.stream tool-call parsing", () => {
  beforeEach(() => {
    mockStreamNode.mockReset();
  });

  async function collectToolCalls(events: unknown[]) {
    mockStreamNode.mockImplementation(streamNodeImpl(events));
    const client = new AnthropicClient("test-key");
    const result = client.stream(makeRequest(), "claude-opus-4-8", makeParams());
    // Drain the delta stream so the wrapped generator's finally resolves the promises.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const _delta of result.deltas) { /* no text deltas in these cases */ }
    return result.toolCalls;
  }

  test("parses a well-formed tool call's JSON arguments", async () => {
    const toolCalls = await collectToolCalls(toolUseEvents('{"search":"x","replace":"y"}'));
    expect(toolCalls).toEqual([{ id: "toolu_1", name: "propose_edit", arguments: { search: "x", replace: "y" } }]);
  });

  test("surfaces a malformed tool call with empty args instead of dropping it", async () => {
    // Pre-fix this dropped the call entirely (toolCalls === null), silently losing
    // the model's intent. Now it surfaces with {} so the loop can return a
    // self-correcting error and the model retries.
    const toolCalls = await collectToolCalls(toolUseEvents("{not valid json"));
    expect(toolCalls).toEqual([{ id: "toolu_1", name: "propose_edit", arguments: {} }]);
  });
});
