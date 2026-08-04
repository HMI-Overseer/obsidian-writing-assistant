import { describe, test, expect, vi, beforeEach } from "vitest";

// Both cloud clients are exercised against mocked transports, so nothing here
// touches the network; the assertions are about *when* the credential is read and
// *which* value reaches the wire.
vi.mock("../../../src/api/httpTransport", () => ({
  nodeRequestWithHeaders: vi.fn(),
  requestJson: vi.fn(),
}));
vi.mock("../../../src/api/streamingTransport", () => ({
  streamNode: vi.fn(),
  streamFetch: vi.fn(),
}));

import { AnthropicClient } from "../../../src/api/AnthropicClient";
import { OpenAIClient } from "../../../src/api/OpenAIClient";
import { MissingCredentialError } from "../../../src/providers/credentials";
import { nodeRequestWithHeaders, requestJson } from "../../../src/api/httpTransport";
import { streamNode, streamFetch } from "../../../src/api/streamingTransport";
import type { ChatRequest } from "../../../src/shared/chatRequest";
import type { SamplingParams } from "../../../src/shared/types";
import { detachedAttemptContext } from "../../../src/api/assistantStreamRuntime";

const mockNodeRequest = vi.mocked(nodeRequestWithHeaders);
const mockRequestJson = vi.mocked(requestJson);
const mockStreamNode = vi.mocked(streamNode);
const mockStreamFetch = vi.mocked(streamFetch);

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

function anthropicSuccess(): { body: string; headers: Record<string, string> } {
  return {
    body: JSON.stringify({
      content: [{ type: "text", text: "ok" }],
      usage: { input_tokens: 1, output_tokens: 1 },
      stop_reason: "end_turn",
    }),
    headers: {},
  };
}

function openAISuccess(): Record<string, unknown> {
  return {
    choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1 },
  };
}

/** An empty async generator, for the streaming paths that must reach the transport. */
function emptyStream() {
  return (async function* () {
    // no chunks; the assertions here are about the headers the transport received
  })();
}

beforeEach(() => {
  mockNodeRequest.mockReset();
  mockRequestJson.mockReset();
  mockStreamNode.mockReset();
  mockStreamFetch.mockReset();
});

/**
 * ADR-0039 makes `getSecret` returning null a normal runtime state: the user can
 * delete the secret from Obsidian's Keychain tab long after the client was built,
 * and `GraphService` keeps its client for the life of the service. So construction
 * must not check, every request must, and the failure must be the same whether the
 * key was never linked or has just been deleted.
 */
describe("credential resolution happens per request, not at construction", () => {
  test("Anthropic: a null-resolving thunk constructs cleanly and throws on complete()", async () => {
    const client = new AnthropicClient(() => null);

    await expect(client.complete(makeRequest(), "claude-opus-4-8", makeParams())).rejects.toThrow(
      MissingCredentialError,
    );
    expect(mockNodeRequest).not.toHaveBeenCalled();
  });

  test("Anthropic: a null-resolving thunk throws on stream() before reaching the transport", () => {
    const client = new AnthropicClient(() => null);

    expect(() =>
      client.stream(makeRequest(), "claude-opus-4-8", makeParams(), detachedAttemptContext("t")),
    ).toThrow(MissingCredentialError);
    expect(mockStreamNode).not.toHaveBeenCalled();
  });

  test("OpenAI: a null-resolving thunk constructs cleanly and throws on complete()", async () => {
    const client = new OpenAIClient(() => null, "https://api.openai.com/v1");

    await expect(client.complete(makeRequest(), "gpt-4o", makeParams())).rejects.toThrow(
      MissingCredentialError,
    );
    expect(mockRequestJson).not.toHaveBeenCalled();
  });

  test("OpenAI: a null-resolving thunk throws on stream() before reaching the transport", () => {
    const client = new OpenAIClient(() => null, "https://api.openai.com/v1");

    expect(() =>
      client.stream(makeRequest(), "gpt-4o", makeParams(), detachedAttemptContext("t")),
    ).toThrow(MissingCredentialError);
    expect(mockStreamFetch).not.toHaveBeenCalled();
  });

  test("an empty-string credential is treated as absent, not sent as an empty bearer", async () => {
    const client = new OpenAIClient(() => "", "https://api.openai.com/v1");

    await expect(client.complete(makeRequest(), "gpt-4o", makeParams())).rejects.toThrow(
      MissingCredentialError,
    );
  });
});

/**
 * The assertion that makes the long-lived client fields safe. `RagService` and
 * `GraphService` assign a client once in `configure()` and reuse it forever, so a
 * client that read its credential at construction would keep sending the old key
 * after the user rotated it. No test could express this before the thunk existed.
 */
describe("a client re-reads its credential on every request", () => {
  test("Anthropic sends the second value when the thunk changes between requests", async () => {
    mockNodeRequest.mockResolvedValue(anthropicSuccess());
    let key = "sk-ant-first";
    const client = new AnthropicClient(() => key);

    await client.complete(makeRequest(), "claude-opus-4-8", makeParams());
    key = "sk-ant-second";
    await client.complete(makeRequest(), "claude-opus-4-8", makeParams());

    const headersOf = (call: number) =>
      mockNodeRequest.mock.calls[call][5] as Record<string, string>;
    expect(headersOf(0)["x-api-key"]).toBe("sk-ant-first");
    expect(headersOf(1)["x-api-key"]).toBe("sk-ant-second");
  });

  test("OpenAI sends the second value when the thunk changes between requests", async () => {
    mockRequestJson.mockResolvedValue(openAISuccess());
    let key = "sk-first";
    const client = new OpenAIClient(() => key, "https://api.openai.com/v1");

    await client.complete(makeRequest(), "gpt-4o", makeParams());
    key = "sk-second";
    await client.complete(makeRequest(), "gpt-4o", makeParams());

    const headersOf = (call: number) => mockRequestJson.mock.calls[call][6] as Record<string, string>;
    expect(headersOf(0).Authorization).toBe("Bearer sk-first");
    expect(headersOf(1).Authorization).toBe("Bearer sk-second");
  });

  test("OpenAI's streaming path resolves per call too, not from a constructor-built header", () => {
    mockStreamFetch.mockImplementation((() => emptyStream()) as typeof streamFetch);
    let key = "sk-first";
    const client = new OpenAIClient(() => key, "https://api.openai.com/v1");

    client.stream(makeRequest(), "gpt-4o", makeParams(), detachedAttemptContext("a"));
    key = "sk-second";
    client.stream(makeRequest(), "gpt-4o", makeParams(), detachedAttemptContext("b"));

    const headersOf = (call: number) => mockStreamFetch.mock.calls[call][3] as Record<string, string>;
    expect(headersOf(0).Authorization).toBe("Bearer sk-first");
    expect(headersOf(1).Authorization).toBe("Bearer sk-second");
  });
});
