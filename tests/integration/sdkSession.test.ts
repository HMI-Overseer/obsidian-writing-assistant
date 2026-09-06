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
import { fingerprint, hashPrefix, type SessionConfig, type SessionTurn } from "../../src/api/harnessSession";
import type { ClaudeCodeResumeCursor } from "../../src/shared/types";
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

/**
 * A fake `query()` that echoes each pushed user message as a turn, staying alive.
 * The returned Query also carries an `applyFlagSettings` spy so the mid-session
 * effort-flip path can be exercised; returned for assertions.
 */
function installEchoQuery(perTurn: (text: string) => unknown[] = (t) => [textDeltaMessage(`echo:${t}`), successResult()]) {
  const applyFlagSettings = vi.fn(() => Promise.resolve());
  const supportedModels = vi.fn(() =>
    Promise.resolve([
      { value: "opus", displayName: "Opus", description: "", supportsEffort: true, supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"] },
    ]),
  );
  queryMock.mockImplementation((params: { prompt: AsyncIterable<{ message: { content: string } }> }) => {
    const input = params.prompt;
    const gen = (async function* () {
      for await (const msg of input) {
        for (const m of perTurn(msg.message.content)) yield m;
      }
    })() as AsyncGenerator<unknown> & {
      applyFlagSettings: typeof applyFlagSettings;
      supportedModels: typeof supportedModels;
    };
    gen.applyFlagSettings = applyFlagSettings;
    gen.supportedModels = supportedModels;
    return gen;
  });
  return { applyFlagSettings, supportedModels };
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

/**
 * Like {@link installEchoQuery} but records every pushed user message verbatim, so
 * a test can assert the content blocks the session actually sent.
 */
function installCapturingQuery(pushed: unknown[]) {
  queryMock.mockImplementation((params: { prompt: AsyncIterable<{ message: unknown }> }) => {
    const input = params.prompt;
    return (async function* () {
      for await (const msg of input) {
        pushed.push(msg.message);
        yield textDeltaMessage("echo");
        yield successResult();
      }
    })();
  });
}

const buildOptions = (): Options => ({}) as Options;

function cfg(overrides: Partial<SessionConfig> = {}): SessionConfig {
  return {
    model: "claude-sonnet-4-6",
    systemPrompt: "Be concise.",
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
    effort: null,
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
    const onRecoveryDecision = (d: unknown) => decisions.push(d);

    const reply = await drain(
      registry.runTurn("c1", turnRequest([{ role: "user", content: "hi" }], "hi", { onRecoveryDecision })),
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
          { onRecoveryDecision },
        ),
      ),
    );

    expect(decisions).toEqual([{ outcome: "rebuilt", reason: "no-session" }, { outcome: "reused" }]);
  });

  it("carries the new turn's images as blocks and still reuses the live session", async () => {
    const pushed: unknown[] = [];
    installCapturingQuery(pushed);
    const decisions: unknown[] = [];
    const onRecoveryDecision = (d: unknown) => decisions.push(d);
    const image = {
      type: "image" as const,
      id: "i1",
      mimeType: "image/png" as const,
      data: "AAAA",
      fileName: "design.png",
    };

    const reply = await drain(
      registry.runTurn("c1", turnRequest([{ role: "user", content: "hi" }], "hi", { onRecoveryDecision })),
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
          { onRecoveryDecision, images: [image] },
        ),
      ),
    );

    // Images live outside the watermark (role + text), so the turn is a plain reuse:
    // one process, no rebuild.
    expect(decisions).toEqual([{ outcome: "rebuilt", reason: "no-session" }, { outcome: "reused" }]);
    expect(queryMock).toHaveBeenCalledTimes(1);
    // The first turn is a cold mint, so it carries the full fixture prompt, text only.
    expect(pushed[0]).toEqual({ role: "user", content: "user:hi" });
    expect(pushed[1]).toEqual({
      role: "user",
      content: [
        { type: "text", text: "again" },
        { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
      ],
    });
  });

  it("reports the field that drove a cold rebuild", async () => {
    installEchoQuery();
    const decisions: unknown[] = [];
    const onRecoveryDecision = (d: unknown) => decisions.push(d);

    await drain(registry.runTurn("c1", turnRequest([{ role: "user", content: "hi" }], "hi", { onRecoveryDecision })));
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
          { cfg: cfg({ model: "claude-opus-4-8" }), onRecoveryDecision },
        ),
      ),
    );

    expect(decisions).toEqual([{ outcome: "rebuilt", reason: "no-session" }, { outcome: "rebuilt", reason: "model-changed" }]);
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
          turnRequest([{ role: "user", content: "hi" }], "hi", { onRecoveryDecision: (d) => decisions.push(d) }),
        ),
      ),
    ).rejects.toThrow(/boom/);

    // The decision is emitted up front (before streaming), so an errored turn
    // still reports it exactly once; the failure then disposes the session.
    expect(decisions).toEqual([{ outcome: "rebuilt", reason: "no-session" }]);
    expect(registry.size).toBe(0);
  });

  it("flips effort on the live session instead of rebuilding (low..xhigh)", async () => {
    const { applyFlagSettings } = installEchoQuery();
    const decisions: unknown[] = [];
    const onRecoveryDecision = (d: unknown) => decisions.push(d);

    const reply = await drain(
      registry.runTurn(
        "c1",
        turnRequest([{ role: "user", content: "hi" }], "hi", { effort: "low", onRecoveryDecision }),
      ),
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
          { effort: "xhigh", onRecoveryDecision },
        ),
      ),
    );

    // Same live process (one query()), the flip rode the control request.
    expect(queryMock).toHaveBeenCalledTimes(1);
    expect(applyFlagSettings).toHaveBeenCalledExactlyOnceWith({ effortLevel: "xhigh" });
    expect(decisions).toEqual([{ outcome: "rebuilt", reason: "no-session" }, { outcome: "reused" }]);
  });

  it("harvests the model list on mint only, never on reuse", async () => {
    installEchoQuery();
    const harvested: unknown[] = [];
    const onModelsDiscovered = (models: unknown) => harvested.push(models);

    const reply = await drain(
      registry.runTurn("c1", turnRequest([{ role: "user", content: "hi" }], "hi", { onModelsDiscovered })),
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
          { onModelsDiscovered },
        ),
      ),
    );

    // One mint → one harvest, carrying the handshake's ModelInfo entries.
    expect(harvested).toHaveLength(1);
    expect(harvested[0]).toMatchObject([{ value: "opus" }]);
  });

  it("streams the turn even when the harvest control request fails", async () => {
    const { supportedModels } = installEchoQuery();
    supportedModels.mockRejectedValueOnce(new Error("control request failed"));

    const reply = await drain(
      registry.runTurn(
        "c1",
        turnRequest([{ role: "user", content: "hi" }], "hi", { onModelsDiscovered: () => {} }),
      ),
    );
    expect(reply).toBe("echo:user:hi");
  });

  it("cold-rebuilds for a flip to max (not expressible in flag settings)", async () => {
    installEchoQuery();
    const decisions: unknown[] = [];
    const onRecoveryDecision = (d: unknown) => decisions.push(d);

    const reply = await drain(
      registry.runTurn(
        "c1",
        turnRequest([{ role: "user", content: "hi" }], "hi", { effort: "high", onRecoveryDecision }),
      ),
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
          { effort: "max", onRecoveryDecision },
        ),
      ),
    );

    expect(queryMock).toHaveBeenCalledTimes(2);
    expect(decisions).toEqual([
      { outcome: "rebuilt", reason: "no-session" },
      { outcome: "rebuilt", reason: "reasoning-changed" },
    ]);
  });

  it("falls back to a cold rebuild when the flip control request fails", async () => {
    const { applyFlagSettings } = installEchoQuery();
    applyFlagSettings.mockRejectedValueOnce(new Error("control request failed"));
    const decisions: unknown[] = [];
    const onRecoveryDecision = (d: unknown) => decisions.push(d);

    const reply = await drain(
      registry.runTurn(
        "c1",
        turnRequest([{ role: "user", content: "hi" }], "hi", { effort: "low", onRecoveryDecision }),
      ),
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
          { effort: "high", onRecoveryDecision },
        ),
      ),
    );

    expect(queryMock).toHaveBeenCalledTimes(2);
    expect(decisions).toEqual([
      { outcome: "rebuilt", reason: "no-session" },
      { outcome: "rebuilt", reason: "reasoning-changed" },
    ]);
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

  it("disposes a compacted-then-interrupted session (compaction guard on the throw path)", async () => {
    // The turn compacts mid-stream AND is cleanly interrupted. A clean interrupt
    // normally preserves the session, but the mid-turn compaction desynced it from
    // the authoritative transcript, so it must still be disposed (section 6.7.1: the
    // post-turn invalidation check is unreachable when the turn throws).
    const interrupt = vi.fn(() => Promise.resolve());
    queryMock.mockImplementation((params: { prompt: AsyncIterable<{ message: { content: string } }> }) => {
      const input = params.prompt;
      const gen = (async function* () {
        for await (const msg of input) {
          yield textDeltaMessage(`echo:${msg.message.content}`);
          yield compactBoundaryMessage();
          yield successResult();
        }
      })() as AsyncGenerator<unknown> & { interrupt: typeof interrupt };
      gen.interrupt = interrupt;
      return gen;
    });

    const ac = new AbortController();
    const gen = registry.runTurn("c1", turnRequest([{ role: "user", content: "hi" }], "hi", { signal: ac.signal }));
    const first = await gen.next();
    expect(first.value).toBe("echo:user:hi");
    ac.abort();
    await expect(gen.next()).rejects.toMatchObject({ name: "AbortError" });

    // Disposed despite the clean interrupt, because it compacted.
    expect(registry.size).toBe(0);
  });

  it("attributes an idle-evicted rebuild to the disposal, not a neutral no-session", async () => {
    installEchoQuery();
    const decisions: unknown[] = [];

    const reply = await drain(registry.runTurn("c1", turnRequest([{ role: "user", content: "hi" }], "hi")));
    // Far enough in the future that the idle window has elapsed.
    registry.evictIdle(Date.now() + 120_000);
    expect(registry.size).toBe(0);

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
          { onRecoveryDecision: (d) => decisions.push(d) },
        ),
      ),
    );

    // The disposal tombstone attributes the rebuild instead of the misleading
    // neutral "no-session" (which the badge shows as "session started").
    expect(decisions).toEqual([{ outcome: "rebuilt", reason: "session-disposed" }]);
  });

  it("attributes a compacted rebuild to compaction, not a neutral no-session", async () => {
    let turnNo = 0;
    installEchoQuery((t) => {
      turnNo += 1;
      return turnNo === 1
        ? [textDeltaMessage(`echo:${t}`), compactBoundaryMessage(), successResult()]
        : [textDeltaMessage(`echo:${t}`), successResult()];
    });
    const decisions: unknown[] = [];

    await drain(registry.runTurn("c1", turnRequest([{ role: "user", content: "hi" }], "hi")));
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
          { onRecoveryDecision: (d) => decisions.push(d) },
        ),
      ),
    );

    expect(decisions).toEqual([{ outcome: "rebuilt", reason: "compacted" }]);
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

  it("does not evict a session that is busy mid-turn", async () => {
    // A turn that hangs before its terminal result (e.g. parked on a user approval)
    // keeps the session busy. The idle sweep must not dispose it out from under the
    // live process, doing so is the "session ended unexpectedly" bug.
    let release!: () => void;
    const hang = new Promise<void>((r) => {
      release = r;
    });
    queryMock.mockImplementation((params: { prompt: AsyncIterable<{ message: { content: string } }> }) => {
      const input = params.prompt;
      return (async function* () {
        for await (const msg of input) {
          yield textDeltaMessage(`echo:${msg.message.content}`);
          await hang; // stay mid-turn (busy) until released
          yield successResult();
        }
      })();
    });

    const gen = registry.runTurn("c1", turnRequest([{ role: "user", content: "hi" }], "hi"));
    // Pull the first delta so the turn is in flight (busy).
    expect((await gen.next()).value).toBe("echo:user:hi");

    // The idle window has elapsed, but the session is mid-turn → not evicted.
    registry.evictIdle(Date.now() + 120_000);
    expect(registry.size).toBe(1);

    // Release the turn; once it completes the session is idle and evicts as normal.
    release();
    await drain(gen);
    expect(registry.size).toBe(1);
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

describe("SdkSessionRegistry resume tier (Model A′)", () => {
  let registry: SdkSessionRegistry;

  beforeEach(() => {
    queryMock.mockReset();
    registry = new SdkSessionRegistry(60_000);
  });
  afterEach(() => registry.disposeAll());

  /** A cursor whose watermark exactly covers `transcript` under the default cfg(). */
  function cursorFor(transcript: SessionTurn[], sessionId: string): ClaudeCodeResumeCursor {
    return {
      sessionId,
      coveredCount: transcript.length,
      prefixHash: hashPrefix(transcript, transcript.length),
      configFingerprint: fingerprint(cfg()),
    };
  }

  it("banks a full resume cursor after a completed turn", async () => {
    installEchoQuery();
    let banked: ClaudeCodeResumeCursor | undefined;

    await drain(
      registry.runTurn(
        "c1",
        turnRequest([{ role: "user", content: "hi" }], "hi", {
          onSessionBanked: (c) => (banked = c),
        }),
      ),
    );

    // sessionId from the result, coveredCount = 1 user + 1 generated assistant turn,
    // plus the two hashes the resume gate re-checks next turn.
    expect(banked).toMatchObject({ sessionId: "sess", coveredCount: 2 });
    expect(typeof banked?.prefixHash).toBe("string");
    expect(banked?.prefixHash).not.toBe("");
    expect(typeof banked?.configFingerprint).toBe("string");
  });

  it("resumes from the persisted cursor when the live process is gone", async () => {
    installEchoQuery();
    let banked: ClaudeCodeResumeCursor | undefined;

    // Turn 1 mints a session and banks its cursor.
    const reply = await drain(
      registry.runTurn(
        "c1",
        turnRequest([{ role: "user", content: "hi" }], "hi", {
          onSessionBanked: (c) => (banked = c),
        }),
      ),
    );

    // Simulate an Obsidian restart: a fresh registry holds no live session, only the
    // persisted cursor survives (as it would on disk / in the message history).
    const restarted = new SdkSessionRegistry(60_000);
    const decisions: unknown[] = [];
    let resumeId: string | undefined = "UNSET";
    const buildOptionsCapture = (_ac: AbortController, id?: string): Options => {
      resumeId = id;
      return {} as Options;
    };

    const out = await drain(
      restarted.runTurn(
        "c1",
        turnRequest(
          [
            { role: "user", content: "hi" },
            { role: "assistant", content: reply },
            { role: "user", content: "again" },
          ],
          "again",
          {
            resumeCursor: banked,
            buildOptions: buildOptionsCapture,
            onRecoveryDecision: (d) => decisions.push(d),
          },
        ),
      ),
    );

    expect(decisions).toEqual([{ outcome: "resumed", cursor: banked }]);
    // Only the delta turn was sent (the disk session already holds the rest)…
    expect(out).toBe("echo:again");
    // …and the session id was handed to the SDK's `resume`.
    expect(resumeId).toBe("sess");
    expect(restarted.size).toBe(1);
    restarted.disposeAll();
  });

  it("never resumes while a live session is held (resume never preempts reuse)", async () => {
    installEchoQuery();
    let banked: ClaudeCodeResumeCursor | undefined;
    const decisions: unknown[] = [];

    const reply = await drain(
      registry.runTurn(
        "c1",
        turnRequest([{ role: "user", content: "hi" }], "hi", {
          onSessionBanked: (c) => (banked = c),
        }),
      ),
    );

    // Same registry (the live process is still warm) AND a resume cursor is present.
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
          { resumeCursor: banked, onRecoveryDecision: (d) => decisions.push(d) },
        ),
      ),
    );

    // The warm process wins; the cursor is never consulted, one underlying process.
    expect(decisions).toEqual([{ outcome: "reused" }]);
    expect(queryMock).toHaveBeenCalledTimes(1);
  });

  it("falls through to a synthetic rebuild in the same turn when the resume can't start", async () => {
    // First query() (the resume attempt) errors before any output, as it would if the
    // on-disk session file was deleted by CLI retention; the second (the rebuild)
    // streams normally.
    let call = 0;
    queryMock.mockImplementation((params: { prompt: AsyncIterable<{ message: { content: string } }> }) => {
      call += 1;
      if (call === 1) {
        return (async function* () {
          throw new Error("resume failed: no such session");
        })();
      }
      const input = params.prompt;
      return (async function* () {
        for await (const msg of input) {
          yield textDeltaMessage(`echo:${msg.message.content}`);
          yield successResult();
        }
      })();
    });

    const covered: SessionTurn[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "yo" },
    ];
    const turns: SessionTurn[] = [...covered, { role: "user", content: "again" }];
    const decisions: unknown[] = [];

    const out = await drain(
      registry.runTurn(
        "c1",
        turnRequest(turns, "again", {
          resumeCursor: cursorFor(covered, "gone"),
          onRecoveryDecision: (d) => decisions.push(d),
        }),
      ),
    );

    // The abandoned resume is reported as a rebuild with the failure cause (expiry),
    // exactly once, and the fresh mint replayed the full transcript.
    expect(decisions).toEqual([{ outcome: "rebuilt", reason: "session-disposed" }]);
    expect(out.startsWith("echo:")).toBe(true);
    expect(queryMock).toHaveBeenCalledTimes(2);
    expect(registry.size).toBe(1);
  });

  it("propagates an abort during a resume rather than falling through to a rebuild", async () => {
    installEchoQuery();
    const covered: SessionTurn[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "yo" },
    ];
    const turns: SessionTurn[] = [...covered, { role: "user", content: "again" }];
    const decisions: unknown[] = [];
    const ac = new AbortController();
    ac.abort(); // the user stopped before the resume produced anything

    await expect(
      drain(
        registry.runTurn(
          "c1",
          turnRequest(turns, "again", {
            resumeCursor: cursorFor(covered, "sess"),
            signal: ac.signal,
            onRecoveryDecision: (d) => decisions.push(d),
          }),
        ),
      ),
    ).rejects.toMatchObject({ name: "AbortError" });

    // An abort is not a resume failure: no fall-through, no second process, and the
    // turn committed to no tier so it reported no decision.
    expect(queryMock).toHaveBeenCalledTimes(1);
    expect(registry.size).toBe(0);
    expect(decisions).toEqual([]);
  });
});
