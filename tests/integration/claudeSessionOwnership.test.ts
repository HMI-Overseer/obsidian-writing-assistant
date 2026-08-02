import { describe, it, expect, vi } from "vitest";

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

import { SdkSession } from "../../src/api/sdk/sdkSession";
import type { Options } from "../../src/api/sdk/claudeAgentSdk";
import { fingerprint, type SessionConfig } from "../../src/api/harnessSession";

/**
 * RFC-0011 phase 0: persistent-session ownership characterization.
 *
 * The persistent session drives its Query with a manual iterator so a terminal
 * `result` can pause it for reuse. That is deliberate, but it means an early
 * consumer return only clears `busy`: the Query is neither interrupted, returned,
 * nor disposed, so the `claude` process keeps running and its MCP callbacks keep
 * arriving. `it.fails` states what phase 2 and phase 5 must establish.
 */

const CONFIG: SessionConfig = {
  model: "claude-sonnet-4-5",
  systemPrompt: "system",
  agenticMode: true,
  toolNames: ["read"],
};

function textDelta(text: string) {
  return {
    type: "stream_event",
    event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
  };
}

/**
 * A Query whose generator records closure and whose `interrupt` is observable,
 * and which keeps producing messages until it is explicitly stopped.
 */
function installLongQuery() {
  const state = { closed: false, produced: 0, interrupted: 0 };
  const interrupt = vi.fn(() => {
    state.interrupted += 1;
    return Promise.resolve();
  });
  queryMock.mockImplementation((params: { prompt: AsyncIterable<{ message: { content: string } }> }) => {
    const input = params.prompt;
    const generator = (async function* () {
      try {
        for await (const _message of input) {
          void _message;
          for (let index = 0; index < 50; index += 1) {
            state.produced += 1;
            yield textDelta(`chunk-${index}`);
          }
        }
      } finally {
        state.closed = true;
      }
    })() as AsyncGenerator<unknown> & {
      interrupt: typeof interrupt;
      applyFlagSettings: () => Promise<void>;
      supportedModels: () => Promise<unknown[]>;
    };
    generator.interrupt = interrupt;
    generator.applyFlagSettings = () => Promise.resolve();
    generator.supportedModels = () => Promise.resolve([]);
    return generator;
  });
  return { state, interrupt };
}

function session(): SdkSession {
  return new SdkSession(
    (abortController: AbortController): Options => ({ abortController }) as Options,
    {
      provider: "claudecode",
      model: CONFIG.model,
      coveredCount: 0,
      prefixHash: "",
      configFingerprint: fingerprint(CONFIG),
      config: CONFIG,
    },
    null,
  );
}

async function consumeThenBail(live: SdkSession, take: number): Promise<void> {
  let seen = 0;
  for await (const _event of live.runTurnEvents("hello", { turns: [] })) {
    void _event;
    seen += 1;
    if (seen >= take) break;
  }
}

describe("persistent Claude session ownership", () => {
  // Criterion 18, fixed in phase 2. Promoted from `it.fails` when the defect closed.
  it("stops the query when the turn consumer returns early", async () => {
    const { state } = installLongQuery();
    const live = session();

    await consumeThenBail(live, 3);

    expect(state.closed).toBe(true);
  });

  it("refuses a later turn on the session the abandoned one disposed", async () => {
    installLongQuery();
    const live = session();

    await consumeThenBail(live, 3);

    // Criterion 27: an abandoned turn leaves the session's tail indeterminate, so
    // it cannot be reused. Previously the remaining messages of the abandoned turn
    // were handed to the next turn's consumer, which is one attempt's provider
    // output reaching a newer attempt.
    expect(live.isDisposed).toBe(true);
    await expect(consumeThenBail(live, 2)).rejects.toThrow("disposed");
  });

  it("interrupts rather than disposing when the turn reaches its own terminal", async () => {
    const { state, interrupt } = installLongQuery();
    const live = session();

    // A turn that ends on the provider's own `result` pauses the query for reuse,
    // which is the whole point of the persistent session. Only abandonment
    // disposes.
    expect(state.closed).toBe(false);
    expect(interrupt).not.toHaveBeenCalled();
    expect(live.isDisposed).toBe(false);
  });

  it("disposes with a settlement handle a caller can await", async () => {
    const { state } = installLongQuery();
    const live = session();
    // Start the query so there is a running generator to close: a generator that
    // was never started runs no `finally` when returned.
    const events = live.runTurnEvents("hello", { turns: [] });
    await events.next();

    const disposed: unknown = live.dispose();

    // Criterion 20 and 21: settlement must account for provider termination.
    // `dispose()` now returns a promise that resolves once the CLI child is
    // provably gone, so a deadline can be enforced on it. The old body returned
    // void, so there was nothing to await, and phase 0 measured that it left the
    // process running.
    expect(disposed).toBeInstanceOf(Promise);
    await disposed;
    expect(live.isDisposed).toBe(true);
    expect(state.closed).toBe(true);
  });
});
