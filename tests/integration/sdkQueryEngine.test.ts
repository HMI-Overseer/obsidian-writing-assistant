import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the single SDK dependency boundary so the engine can be exercised without
// the real Agent SDK / `claude` CLI. `query` is swapped per test; `AbortError`
// mirrors the SDK's class for the abort-detection branch. Declared via
// `vi.hoisted` so they exist when the hoisted `vi.mock` factory runs.
const { queryMock, FakeAbortError } = vi.hoisted(() => ({
  queryMock: vi.fn(),
  FakeAbortError: class FakeAbortError extends Error {},
}));

vi.mock("../../src/api/sdk/claudeAgentSdk", () => ({
  query: (params: unknown) => queryMock(params),
  AbortError: FakeAbortError,
  createSdkMcpServer: vi.fn(),
  tool: vi.fn(),
  isSdkAvailable: () => true,
}));

import { streamSdkTurn, type SdkTurnOptions } from "../../src/api/sdk/sdkQueryEngine";
import type { ClaudeCodeResultUsage } from "../../src/api/claudeCodeProcess";

function textDeltaMessage(text: string) {
  return {
    type: "stream_event",
    event: { type: "content_block_delta", delta: { type: "text_delta", text } },
  };
}

function successResult(overrides: Record<string, unknown> = {}) {
  return {
    type: "result",
    subtype: "success",
    is_error: false,
    result: "done",
    total_cost_usd: 0.012,
    session_id: "sess-1",
    usage: {
      input_tokens: 100,
      output_tokens: 20,
      cache_read_input_tokens: 80,
      cache_creation_input_tokens: 5,
    },
    ...overrides,
  };
}

function feed(messages: unknown[]) {
  queryMock.mockReturnValue(
    (async function* () {
      for (const m of messages) yield m;
    })(),
  );
}

function baseOptions(overrides: Partial<SdkTurnOptions> = {}): SdkTurnOptions {
  return {
    prompt: "hello",
    model: "claude-sonnet-4-6",
    systemPrompt: "Be concise.",
    reasoning: "off",
    claudePath: "/usr/bin/claude",
    ...overrides,
  };
}

async function drain(gen: AsyncGenerator<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const d of gen) out.push(d);
  return out;
}

describe("streamSdkTurn", () => {
  beforeEach(() => {
    queryMock.mockReset();
  });

  it("yields assistant text deltas and captures terminal usage", async () => {
    feed([textDeltaMessage("Hel"), textDeltaMessage("lo"), successResult()]);

    let captured: ClaudeCodeResultUsage | null = null;
    const deltas = await drain(streamSdkTurn(baseOptions({ onResult: (r) => (captured = r) })));

    expect(deltas).toEqual(["Hel", "lo"]);
    expect(captured).toEqual({
      inputTokens: 100,
      outputTokens: 20,
      cacheReadInputTokens: 80,
      cacheCreationInputTokens: 5,
      costUsd: 0.012,
      sessionId: "sess-1",
    });
  });

  it("passes the resolved binary, model, and disabled persistence to the SDK", async () => {
    feed([successResult()]);
    await drain(streamSdkTurn(baseOptions()));

    const params = queryMock.mock.calls[0][0];
    expect(params.prompt).toBe("hello");
    expect(params.options.pathToClaudeCodeExecutable).toBe("/usr/bin/claude");
    expect(params.options.model).toBe("claude-sonnet-4-6");
    expect(params.options.persistSession).toBe(false);
    expect(params.options.settingSources).toEqual([]);
  });

  it("runs as a pure analyst (no tools) when no MCP bridge is supplied", async () => {
    feed([successResult()]);
    await drain(streamSdkTurn(baseOptions()));

    const { options } = queryMock.mock.calls[0][0];
    expect(options.tools).toEqual([]);
    expect(options.mcpServers).toBeUndefined();
  });

  it("wires the MCP bridge and locks down native tools when supplied", async () => {
    feed([successResult()]);
    const server = { type: "sdk", name: "writing_assistant", instance: {} };
    await drain(
      streamSdkTurn(
        baseOptions({ sdkMcp: { server: server as never, serverName: "writing_assistant" } }),
      ),
    );

    const { options } = queryMock.mock.calls[0][0];
    expect(options.mcpServers).toEqual({ writing_assistant: server });
    expect(options.allowedTools).toEqual(["mcp__writing_assistant"]);
    expect(options.permissionMode).toBe("dontAsk");
    expect(options.disallowedTools).toContain("Bash");
    expect(options.tools).toBeUndefined();
  });

  it("throws on a non-success result and never reports usage", async () => {
    feed([
      textDeltaMessage("partial"),
      { type: "result", subtype: "error_during_execution", is_error: true, errors: ["boom"], usage: {} },
    ]);

    const onResult = vi.fn();
    await expect(drain(streamSdkTurn(baseOptions({ onResult })))).rejects.toThrow(/boom/);
    expect(onResult).not.toHaveBeenCalled();
  });

  it("surfaces an assistant-level error (auth, rate limit) as a thrown error", async () => {
    feed([{ type: "assistant", error: "authentication_failed", message: {} }]);
    await expect(drain(streamSdkTurn(baseOptions()))).rejects.toThrow(/authentication_failed/);
  });

  it("converts an SDK AbortError into an AbortError-named error", async () => {
    queryMock.mockReturnValue(
      (async function* () {
        yield textDeltaMessage("x");
        throw new FakeAbortError("aborted");
      })(),
    );

    await expect(drain(streamSdkTurn(baseOptions()))).rejects.toMatchObject({ name: "AbortError" });
  });

  it("throws immediately when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      drain(streamSdkTurn(baseOptions({ signal: controller.signal }))),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(queryMock).not.toHaveBeenCalled();
  });
});
