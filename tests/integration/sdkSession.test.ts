import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock the single SDK boundary. `query` is driven by a fake that consumes the
// streaming-input iterable and emits one echo turn per pushed user message, so a
// single fake "process" can serve multiple turns, the persistent-session
// behavior under test. Declared via `vi.hoisted` for the hoisted `vi.mock` factory.
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

import { SdkSession, SdkSessionRegistry, type SessionTurnRequest } from "../../src/api/sdk/sdkSession";
import type { SessionConfig, SessionTurn } from "../../src/api/harnessSession";
import type { Options } from "../../src/api/sdk/claudeAgentSdk";

function textDeltaMessage(text: string) {
  return { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text } } };
}

function compactBoundaryMessage() {
  return { type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "auto", pre_tokens: 100 } };
}

function successResult(overrides: Record<string, unknown> = {}) {
  return {
    type: "result",
    subtype: "success",
    is_error: false,
    result: "done",
    total_cost_usd: 0.01,
    session_id: "sess",
    usage: { input_tokens: 10, output_tokens: 5 },
    ...overrides,
  };
}

/** A fake `query()` that echoes each pushed user message as a turn, staying alive. */
function installEchoQuery(perTurn: (text: string) => unknown[] = (t) => [textDeltaMessage(`echo:${t}`), successResult()]) {
  queryMock.mockImplementation((params: { prompt: AsyncIterable<{ message: { content: string } }> }) => {
    const input = params.prompt;
    return (async function* () {
      for await (const msg of input) {
        for (const m of perTurn(msg.message.content)) yield m;
      }
    })();
  });
}

/**
 * Like {@link installEchoQuery} but the returned Query carries an `interrupt()`
 * method, so the abort-preserves-session path can be exercised. The fake emits a
 * delta then the terminal result per turn; aborting between them drives the session
 * to treat that result as a clean interrupt. Returns the interrupt spy.
 */
function installInterruptibleQuery(
  perTurn: (text: string) => unknown[] = (t) => [textDeltaMessage(`echo:${t}`), successResult()],
) {
  const interrupt = vi.fn(() => Promise.resolve());
  queryMock.mockImplementation((params: { prompt: AsyncIterable<{ message: { content: string } }> }) => {
    const input = params.prompt;
    const gen = (async function* () {
      for await (const msg of input) {
        for (const m of perTurn(msg.message.content)) yield m;
      }
    })() as AsyncGenerator<unknown> & { interrupt: typeof interrupt };
    gen.interrupt = interrupt;
    return gen;
  });
  return { interrupt };
}

const buildOptions = (): Options => ({}) as Options;

function cfg(overrides: Partial<SessionConfig> = {}): SessionConfig {
  return {
    model: "claude-sonnet-4-6",
    systemPrompt: "Be concise.",
    reasoning: "off",
    agenticMode: true,
    toolNames: ["read_note"],
    ...overrides,
  };
}

async function drain(gen: AsyncGenerator<string>): Promise<string> {
  let out = "";
  for await (const d of gen) out += d;
  return out;
}

/** Builds a turn request whose transcript ends with a fresh user turn. */
function turnRequest(turns: SessionTurn[], deltaText: string, overrides: Partial<SessionTurnRequest> = {}): SessionTurnRequest {
  return {
    cfg: cfg(),
    turns,
    fullPrompt: turns.map((t) => `${t.role}:${t.content}`).join("\n"),
    deltaPrompt: deltaText,
    buildOptions,
    ...overrides,
  };
}

describe("SdkSession", () => {
  beforeEach(() => {
    queryMock.mockReset();
  });

  it("streams a turn, captures usage, and advances the watermark", async () => {
    installEchoQuery();
    const session = new SdkSession(buildOptions, {
      provider: "claudecode",
      model: "claude-sonnet-4-6",
      coveredCount: 0,
      prefixHash: "",
      configFingerprint: "fp",
    });

    let usage: unknown = null;
    const turns: SessionTurn[] = [{ role: "user", content: "hi" }];
    const text = await drain(session.runTurn("hi", { turns, onResult: (u) => (usage = u) }));

    expect(text).toBe("echo:hi");
    expect(usage).toMatchObject({ inputTokens: 10, outputTokens: 5, costUsd: 0.01 });
    // covered = 1 user turn + 1 generated assistant turn
    expect(session.meta.coveredCount).toBe(2);
    expect(session.meta.prefixHash).not.toBe("");
    session.dispose();
  });

  it("serves a second turn from the same live process (one query() call)", async () => {
    installEchoQuery();
    const session = new SdkSession(buildOptions, {
      provider: "claudecode",
      model: "claude-sonnet-4-6",
      coveredCount: 0,
      prefixHash: "",
      configFingerprint: "fp",
    });

    await drain(session.runTurn("hi", { turns: [{ role: "user", content: "hi" }] }));
    const second = await drain(
      session.runTurn("again", {
        turns: [
          { role: "user", content: "hi" },
          { role: "assistant", content: "echo:hi" },
          { role: "user", content: "again" },
        ],
      }),
    );

    expect(second).toBe("echo:again");
    expect(queryMock).toHaveBeenCalledTimes(1);
    session.dispose();
  });

  it("throws after disposal", async () => {
    installEchoQuery();
    const session = new SdkSession(buildOptions, {
      provider: "claudecode",
      model: "claude-sonnet-4-6",
      coveredCount: 0,
      prefixHash: "",
      configFingerprint: "fp",
    });
    session.dispose();
    await expect(drain(session.runTurn("hi", { turns: [{ role: "user", content: "hi" }] }))).rejects.toThrow(/disposed/);
  });

  it("throws on a non-success result", async () => {
    installEchoQuery(() => [
      { type: "result", subtype: "error_during_execution", is_error: true, errors: ["boom"], usage: {} },
    ]);
    const session = new SdkSession(buildOptions, {
      provider: "claudecode",
      model: "claude-sonnet-4-6",
      coveredCount: 0,
      prefixHash: "",
      configFingerprint: "fp",
    });
    await expect(drain(session.runTurn("hi", { turns: [{ role: "user", content: "hi" }] }))).rejects.toThrow(/boom/);
    session.dispose();
  });

  it("interrupt() on abort preserves the session and banks the partial reply", async () => {
    const { interrupt } = installInterruptibleQuery();
    const session = new SdkSession(buildOptions, {
      provider: "claudecode",
      model: "claude-sonnet-4-6",
      coveredCount: 0,
      prefixHash: "",
      configFingerprint: "fp",
    });

    const ac = new AbortController();
    const turns: SessionTurn[] = [{ role: "user", content: "hi" }];
    const gen = session.runTurn("hi", { turns, signal: ac.signal });

    // First delta streams, then we cancel mid-turn.
    const first = await gen.next();
    expect(first.value).toBe("echo:hi");
    ac.abort();

    // The terminal result is now read as a clean interrupt → AbortError surfaces.
    await expect(gen.next()).rejects.toMatchObject({ name: "AbortError" });
    expect(interrupt).toHaveBeenCalledOnce();
    // Session survives for reuse with the partial reply banked as the covered turn.
    expect(session.isDisposed).toBe(false);
    expect(session.wasInterruptedCleanly).toBe(true);
    expect(session.meta.coveredCount).toBe(2);
    session.dispose();
  });

  it("flags compaction for invalidation while finishing the turn", async () => {
    installEchoQuery((t) => [textDeltaMessage(`echo:${t}`), compactBoundaryMessage(), successResult()]);
    const session = new SdkSession(buildOptions, {
      provider: "claudecode",
      model: "claude-sonnet-4-6",
      coveredCount: 0,
      prefixHash: "",
      configFingerprint: "fp",
    });

    const text = await drain(session.runTurn("hi", { turns: [{ role: "user", content: "hi" }] }));
    expect(text).toBe("echo:hi");
    expect(session.needsInvalidation).toBe(true);
    session.dispose();
  });
});

describe("SdkSessionRegistry", () => {
  let registry: SdkSessionRegistry;

  beforeEach(() => {
    queryMock.mockReset();
    registry = new SdkSessionRegistry(60_000);
  });
  afterEach(() => registry.disposeAll());

  it("mints a session on the first turn and reuses it on a clean extension", async () => {
    installEchoQuery();

    // The stored assistant turn must be exactly what the session generated, so the
    // next turn's prefix hash matches what the session recorded.
    const reply = await drain(registry.runTurn("c1", turnRequest([{ role: "user", content: "hi" }], "hi")));
    expect(registry.size).toBe(1);

    await drain(
      registry.runTurn(
        "c1",
        turnRequest(
          [
            { role: "user", content: "hi" },
            { role: "assistant", content: reply },
            { role: "user", content: "again" },
          ],
          "again",
        ),
      ),
    );

    // Reuse → still one live session, one underlying process.
    expect(registry.size).toBe(1);
    expect(queryMock).toHaveBeenCalledTimes(1);
  });

  it("reports the reuse decision per turn (no-session, then reuse)", async () => {
    installEchoQuery();
    const decisions: unknown[] = [];
    const onReuseDecision = (d: unknown) => decisions.push(d);

    const reply = await drain(
      registry.runTurn("c1", turnRequest([{ role: "user", content: "hi" }], "hi", { onReuseDecision })),
    );
    await drain(
      registry.runTurn(
        "c1",
        turnRequest(
          [
            { role: "user", content: "hi" },
            { role: "assistant", content: reply },
            { role: "user", content: "again" },
          ],
          "again",
          { onReuseDecision },
        ),
      ),
    );

    expect(decisions).toEqual([{ reuse: false, reason: "no-session" }, { reuse: true }]);
  });

  it("reports the field that drove a cold rebuild", async () => {
    installEchoQuery();
    const decisions: unknown[] = [];
    const onReuseDecision = (d: unknown) => decisions.push(d);

    await drain(registry.runTurn("c1", turnRequest([{ role: "user", content: "hi" }], "hi", { onReuseDecision })));
    await drain(
      registry.runTurn(
        "c1",
        turnRequest(
          [
            { role: "user", content: "hi" },
            { role: "assistant", content: "echo:hi" },
            { role: "user", content: "again" },
          ],
          "again",
          { cfg: cfg({ model: "claude-opus-4-8" }), onReuseDecision },
        ),
      ),
    );

    expect(decisions).toEqual([{ reuse: false, reason: "no-session" }, { reuse: false, reason: "model-changed" }]);
  });

  it("reports the decision before a turn that then errors", async () => {
    installEchoQuery(() => [
      { type: "result", subtype: "error_during_execution", is_error: true, errors: ["boom"], usage: {} },
    ]);
    const decisions: unknown[] = [];

    await expect(
      drain(
        registry.runTurn(
          "c1",
          turnRequest([{ role: "user", content: "hi" }], "hi", { onReuseDecision: (d) => decisions.push(d) }),
        ),
      ),
    ).rejects.toThrow(/boom/);

    // The decision is emitted up front (before streaming), so an errored turn
    // still reports it exactly once; the failure then disposes the session.
    expect(decisions).toEqual([{ reuse: false, reason: "no-session" }]);
    expect(registry.size).toBe(0);
  });

  it("cold-rebuilds (new process) when config drifts", async () => {
    installEchoQuery();

    await drain(registry.runTurn("c1", turnRequest([{ role: "user", content: "hi" }], "hi")));
    await drain(
      registry.runTurn(
        "c1",
        turnRequest(
          [
            { role: "user", content: "hi" },
            { role: "assistant", content: "echo:hi" },
            { role: "user", content: "again" },
          ],
          "again",
          { cfg: cfg({ model: "claude-opus-4-8" }) },
        ),
      ),
    );

    expect(registry.size).toBe(1);
    expect(queryMock).toHaveBeenCalledTimes(2);
  });

  it("disposes the session when a turn fails", async () => {
    installEchoQuery(() => [
      { type: "result", subtype: "error_during_execution", is_error: true, errors: ["boom"], usage: {} },
    ]);

    await expect(
      drain(registry.runTurn("c1", turnRequest([{ role: "user", content: "hi" }], "hi"))),
    ).rejects.toThrow(/boom/);
    expect(registry.size).toBe(0);
  });

  it("preserves the session after a clean interrupt and reuses it next turn", async () => {
    installInterruptibleQuery();

    const ac = new AbortController();
    const gen = registry.runTurn(
      "c1",
      turnRequest([{ role: "user", content: "hi" }], "hi", { signal: ac.signal }),
    );
    // The cold mint sends the full transcript prompt ("user:hi"), so the echo,
    // banked as the partial reply on interrupt, is "echo:user:hi".
    const first = await gen.next();
    expect(first.value).toBe("echo:user:hi");
    ac.abort();
    await expect(gen.next()).rejects.toMatchObject({ name: "AbortError" });

    // The interrupted session stays live (its context covers the partial reply).
    expect(registry.size).toBe(1);

    // Next turn extends it, the stored assistant turn must match what was banked,
    // so the prefix hash lines up and the live process is reused (no new query()).
    await drain(
      registry.runTurn(
        "c1",
        turnRequest(
          [
            { role: "user", content: "hi" },
            { role: "assistant", content: "echo:user:hi" },
            { role: "user", content: "again" },
          ],
          "again",
        ),
      ),
    );
    expect(registry.size).toBe(1);
    expect(queryMock).toHaveBeenCalledTimes(1);
  });

  it("invalidates a compacted session so the next turn cold-rebuilds", async () => {
    // Only the first turn compacts; the second runs clean to prove a fresh mint.
    let turnNo = 0;
    installEchoQuery((t) => {
      turnNo += 1;
      return turnNo === 1
        ? [textDeltaMessage(`echo:${t}`), compactBoundaryMessage(), successResult()]
        : [textDeltaMessage(`echo:${t}`), successResult()];
    });

    await drain(registry.runTurn("c1", turnRequest([{ role: "user", content: "hi" }], "hi")));
    // Compaction disposed the session at turn end.
    expect(registry.size).toBe(0);

    await drain(
      registry.runTurn(
        "c1",
        turnRequest(
          [
            { role: "user", content: "hi" },
            { role: "assistant", content: "echo:user:hi" },
            { role: "user", content: "again" },
          ],
          "again",
        ),
      ),
    );
    // New process minted, context retention sacrificed for correctness.
    expect(registry.size).toBe(1);
    expect(queryMock).toHaveBeenCalledTimes(2);
  });

  it("keeps separate sessions per conversation", async () => {
    installEchoQuery();
    await drain(registry.runTurn("c1", turnRequest([{ role: "user", content: "a" }], "a")));
    await drain(registry.runTurn("c2", turnRequest([{ role: "user", content: "b" }], "b")));
    expect(registry.size).toBe(2);
    expect(queryMock).toHaveBeenCalledTimes(2);
  });

  it("evicts idle sessions", async () => {
    installEchoQuery();
    await drain(registry.runTurn("c1", turnRequest([{ role: "user", content: "hi" }], "hi")));
    expect(registry.size).toBe(1);

    // Far enough in the future that the 60s idle window has elapsed.
    registry.evictIdle(Date.now() + 120_000);
    expect(registry.size).toBe(0);
  });

  it("disposes all sessions on unload", async () => {
    installEchoQuery();
    await drain(registry.runTurn("c1", turnRequest([{ role: "user", content: "hi" }], "hi")));
    await drain(registry.runTurn("c2", turnRequest([{ role: "user", content: "hi" }], "hi")));
    registry.disposeAll();
    expect(registry.size).toBe(0);
  });
});
