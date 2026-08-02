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
import type { AssistantStreamEvent } from "../../../src/api/usageTypes";
import type { AssistantStreamRun } from "../../../src/api/assistantStreamRun";
import { detachedAttemptContext } from "../../../src/api/assistantStreamRuntime";

const mockRequest = vi.mocked(nodeRequestWithHeaders);
const mockStreamNode = vi.mocked(streamNode);

/**
 * A streamNode stand-in that fires the given SSE events via onEvent, yields no
 * text. The raw payload rides along exactly as the real transport passes it: it
 * is what a capture frame key is derived from.
 */
function streamNodeImpl(events: unknown[]): typeof streamNode {
  return async function* (
    _url: string,
    _payload: string,
    _signal?: AbortSignal,
    _headers?: Record<string, string>,
    _extractDelta?: unknown,
    onEvent?: (json: unknown, raw: string) => void,
  ): AsyncGenerator<string> {
    for (const ev of events) onEvent?.(ev, JSON.stringify(ev));
  } as typeof streamNode;
}

function toolUseEvents(partialJson: string): unknown[] {
  return [
    {
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id: "toolu_1", name: "edit" },
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
    const result = client.stream(makeRequest(), "claude-opus-4-8", makeParams(), detachedAttemptContext("t"));
    const ordered = await collectEvents(result);
    return toolCallsOf(ordered);
  }

  test("parses a well-formed tool call's JSON arguments", async () => {
    const toolCalls = await collectToolCalls(toolUseEvents('{"search":"x","replace":"y"}'));
    expect(toolCalls).toEqual([{ id: "toolu_1", name: "edit", arguments: { search: "x", replace: "y" } }]);
  });

  test("surfaces a malformed tool call with empty args instead of dropping it", async () => {
    // Pre-fix this dropped the call entirely (toolCalls === null), silently losing
    // the model's intent. Now it surfaces with {} so the loop can return a
    // self-correcting error and the model retries.
    const toolCalls = await collectToolCalls(toolUseEvents("{not valid json"));
    expect(toolCalls).toEqual([{ id: "toolu_1", name: "edit", arguments: {} }]);
  });
});

describe("AnthropicClient.stream thinking-block capture (tool round trip)", () => {
  beforeEach(() => {
    mockStreamNode.mockReset();
  });

  async function collectThinkingBlocks(events: unknown[]) {
    mockStreamNode.mockImplementation(streamNodeImpl(events));
    const client = new AnthropicClient("test-key");
    const result = client.stream(makeRequest(), "claude-opus-4-8", makeParams(), detachedAttemptContext("t"));
    await collectEvents(result);
    return (await result.replayCapsule)?.thinkingBlocks ?? null;
  }

  test("assembles streamed thinking deltas + signature into a verbatim block", async () => {
    const blocks = await collectThinkingBlocks([
      { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "step one, " } },
      { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "step two" } },
      { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig-abc" } },
      { type: "content_block_stop", index: 0 },
    ]);
    expect(blocks).toEqual([
      { type: "thinking", thinking: "step one, step two", signature: "sig-abc" },
    ]);
  });

  test("keeps an empty-text thinking block (display 'omitted' still carries the signature)", async () => {
    const blocks = await collectThinkingBlocks([
      { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig-empty" } },
      { type: "content_block_stop", index: 0 },
    ]);
    expect(blocks).toEqual([{ type: "thinking", thinking: "", signature: "sig-empty" }]);
  });

  test("captures redacted_thinking blocks whole", async () => {
    const blocks = await collectThinkingBlocks([
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "redacted_thinking", data: "opaque-bytes" },
      },
      { type: "content_block_stop", index: 0 },
    ]);
    expect(blocks).toEqual([{ type: "redacted_thinking", data: "opaque-bytes" }]);
  });

  test("resolves null when the response carried no thinking", async () => {
    const blocks = await collectThinkingBlocks([
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } },
      { type: "content_block_stop", index: 0 },
    ]);
    expect(blocks).toBeNull();
  });
});

/** Flattens the run's capture batches back to facts, in arrival order. */
async function collectEvents(
  result: AssistantStreamRun,
): Promise<AssistantStreamEvent[]> {
  const events: AssistantStreamEvent[] = [];
  for await (const batch of result.events) events.push(...batch.facts);
  return events;
}

function toolCallsOf(events: AssistantStreamEvent[]) {
  const declarations = new Map<
    string,
    { id?: string; name: string; arguments: string }
  >();
  for (const event of events) {
    if (event.type === "tool_call_start") {
      declarations.set(event.declarationKey, {
        name: event.toolName ?? "",
        arguments: "",
      });
    } else if (event.type === "tool_call_delta") {
      const declaration = declarations.get(event.declarationKey);
      if (!declaration) continue;
      declaration.name += event.nameDelta ?? "";
      declaration.arguments += event.argumentsDelta ?? "";
    } else if (event.type === "tool_call_identity") {
      const declaration = declarations.get(event.declarationKey);
      if (declaration) declaration.id = event.toolCallId;
    }
  }
  return [...declarations.values()].map((declaration) => {
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(declaration.arguments) as Record<string, unknown>;
    } catch {
      args = {};
    }
    return {
      id: declaration.id,
      name: declaration.name,
      arguments: args,
    };
  });
}

describe("AnthropicClient.complete Layer-2 block tolerance", () => {
  beforeEach(() => {
    mockRequest.mockReset();
  });

  // The native tool-search turn (Layer 2, ADR-0009) interleaves server_tool_use and
  // tool_search_tool_result blocks with the model's text and the client tool_use it
  // ultimately emits. The parser handles only text + tool_use, so the server-tool blocks
  // pass through harmlessly, text and the client tool_use must survive intact.
  test("ignores server_tool_use / tool_search_tool_result blocks, keeps text + tool_use", async () => {
    mockRequest.mockResolvedValueOnce({
      body: JSON.stringify({
        content: [
          { type: "text", text: "searching" },
          { type: "server_tool_use", id: "srv_1", name: "tool_search_tool_regex", input: { query: "read" } },
          { type: "tool_search_tool_result", tool_use_id: "srv_1", content: [] },
          { type: "tool_use", id: "toolu_1", name: "read_file", input: { path: "a.md" } },
        ],
        usage: { input_tokens: 5, output_tokens: 7 },
        stop_reason: "tool_use",
      }),
      headers: {},
    });

    const client = new AnthropicClient("test-key");
    const result = await client.complete(makeRequest(), "claude-opus-4-8", makeParams());

    expect(result.text).toBe("searching");
    expect(result.toolCalls).toEqual([
      { id: "toolu_1", name: "read_file", arguments: { path: "a.md" } },
    ]);
    expect(result.stopReason).toBe("tool_use");
  });

  // A pause_turn (the server-side tool-search loop hit its ~10-iteration cap) carries a
  // trailing server_tool_use block but no client tool_use and no text. It maps to its own
  // StopReason (B-hardening), NOT "unknown", so the tool loop can render an accurate
  // recoverable message instead of misclassifying it as reasoning-only output.
  test("maps a pause_turn server-tool pause to its own stop reason", async () => {
    mockRequest.mockResolvedValueOnce({
      body: JSON.stringify({
        content: [
          { type: "server_tool_use", id: "srv_1", name: "tool_search_tool_regex", input: { query: "read" } },
        ],
        usage: { input_tokens: 5, output_tokens: 7 },
        stop_reason: "pause_turn",
      }),
      headers: {},
    });

    const client = new AnthropicClient("test-key");
    const result = await client.complete(makeRequest(), "claude-opus-4-8", makeParams());

    expect(result.text).toBe("");
    expect(result.toolCalls).toBeNull();
    expect(result.stopReason).toBe("pause_turn");
  });
});
