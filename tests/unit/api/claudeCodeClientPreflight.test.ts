import { describe, it, expect, vi, beforeEach } from "vitest";

// Stub only `streamClaudeCodeMessages` (the legacy subprocess spawn) so the legacy-env
// assertion can capture the env without a real `claude` process; everything else
// in the module (claudeCodeHarnessEnv, resolveClaudeBinary, result parsers) stays
// real, so the env the client builds is the genuine one.
const { streamClaudeCodeMessagesMock } = vi.hoisted(() => ({
  streamClaudeCodeMessagesMock: vi.fn(),
}));

vi.mock("../../../src/api/claudeCodeProcess", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/api/claudeCodeProcess")>();
  return {
    ...actual,
    streamClaudeCodeMessages: (opts: unknown) =>
      streamClaudeCodeMessagesMock(opts),
  };
});

import { ClaudeCodeClient, type ClaudeCodeRuntime } from "../../../src/api/ClaudeCodeClient";
import { ClaudeCodeContextOverflowError } from "../../../src/api/claudeCodeContextPreflight";
import type { ChatRequest } from "../../../src/shared/chatRequest";
import type { SamplingParams } from "../../../src/shared/types";
import type {
  AssistantCaptureBatch,
  AssistantCaptureFrame,
} from "../../../src/api/assistantCapture";
import { proseTurnFrames } from "../../helpers/captureFrames";
import { detachedAttemptContext } from "../../../src/api/assistantStreamRuntime";

const params: SamplingParams = {
  temperature: 0,
  maxTokens: null,
  topP: null,
  topK: null,
  minP: null,
  repeatPenalty: null,
  reasoning: null,
};

function request(userContent: string): ChatRequest {
  return {
    systemPrompt: "",
    documentContext: null,
    ragContext: null,
    messages: [{ role: "user", content: userContent }],
  };
}

function okGen(): AsyncGenerator<AssistantCaptureFrame> {
  return proseTurnFrames(["ok"]);
}

async function drain(
  batches: AsyncIterable<AssistantCaptureBatch>,
): Promise<string[]> {
  const out: string[] = [];
  for await (const batch of batches) {
    for (const fact of batch.facts) {
      if (fact.type === "prose_delta") out.push(fact.delta);
    }
  }
  return out;
}

// A blob well past the 176k-token budget of a 200k window (~250k tokens).
const OVERSIZED = "x".repeat(1_000_000);

describe("ClaudeCodeClient send-path preflight", () => {
  beforeEach(() => streamClaudeCodeMessagesMock.mockReset());

  it("blocks an oversized mint blob before any dispatch (zero API calls)", async () => {
    const run = vi.fn(() => okGen());
    const runtime: ClaudeCodeRuntime = {
      useSdk: true,
      contextWindow: 200_000,
      sdkSession: { conversationId: "c", run },
    };
    const client = new ClaudeCodeClient("claude", runtime);

    const { events } = client.stream(request(OVERSIZED), "haiku", params, detachedAttemptContext("t"));
    await expect(drain(events)).rejects.toBeInstanceOf(ClaudeCodeContextOverflowError);
    // Nothing was dispatched: the session's `run` (which spawns / resumes the
    // process) was never invoked.
    expect(run).not.toHaveBeenCalled();
  });

  it("lets a blob within budget dispatch normally", async () => {
    const run = vi.fn(() => okGen());
    const runtime: ClaudeCodeRuntime = {
      useSdk: true,
      contextWindow: 200_000,
      sdkSession: { conversationId: "c", run },
    };
    const client = new ClaudeCodeClient("claude", runtime);

    const { events } = client.stream(request("hello"), "haiku", params, detachedAttemptContext("t"));
    expect(await drain(events)).toEqual(["ok"]);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("is a passive no-op when the context window is unknown (first turn)", async () => {
    const run = vi.fn(() => okGen());
    const runtime: ClaudeCodeRuntime = {
      useSdk: true,
      sdkSession: { conversationId: "c", run },
    };
    const client = new ClaudeCodeClient("claude", runtime);

    // The same oversized blob dispatches, because there is no window to judge it.
    const { events } = client.stream(request(OVERSIZED), "haiku", params, detachedAttemptContext("t"));
    expect(await drain(events)).toEqual(["ok"]);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("removes no context when it blocks: the transcript is byte-identical", async () => {
    const run = vi.fn(() => okGen());
    const runtime: ClaudeCodeRuntime = {
      useSdk: true,
      contextWindow: 200_000,
      sdkSession: { conversationId: "c", run },
    };
    const client = new ClaudeCodeClient("claude", runtime);

    const req = request(OVERSIZED);
    const before = JSON.parse(JSON.stringify(req.messages));
    const { events } = client.stream(req, "haiku", params, detachedAttemptContext("t"));
    await expect(drain(events)).rejects.toBeInstanceOf(ClaudeCodeContextOverflowError);
    expect(req.messages).toEqual(before);
  });

  it("carries DISABLE_COMPACT into the legacy subprocess env", async () => {
    streamClaudeCodeMessagesMock.mockImplementation(() =>
      (async function* () {
        yield {
          type: "stream_event",
          event: {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "ok" },
          },
        };
        yield {
          type: "result",
          subtype: "success",
          is_error: false,
          usage: { input_tokens: 1, output_tokens: 1 },
        };
      })(),
    );
    // Legacy path: no session, SDK unusable, no MCP → pure-analyst subprocess.
    const client = new ClaudeCodeClient("claude", { useSdk: false });

    await drain(client.stream(request("hello"), "haiku", params, detachedAttemptContext("t")).events);

    expect(streamClaudeCodeMessagesMock).toHaveBeenCalledTimes(1);
    const opts = streamClaudeCodeMessagesMock.mock.calls[0][0] as {
      env: Record<string, string>;
    };
    expect(opts.env.DISABLE_COMPACT).toBe("1");
  });
});
