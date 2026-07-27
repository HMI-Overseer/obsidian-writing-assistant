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
  toolNames: ["read_file"],
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
  it("leaves the query alive when the turn consumer returns early", async () => {
    const { state, interrupt } = installLongQuery();
    const live = session();

    await consumeThenBail(live, 3);

    // Invariant 10 and criterion 18: provider execution is owned until it is
    // terminal or explicitly stopped and quiescent. Ceasing iteration only
    // released the busy flag.
    expect(live.isBusy).toBe(false);
    expect(live.isDisposed).toBe(false);
    expect(interrupt).not.toHaveBeenCalled();
    expect(state.closed).toBe(false);
  });

  // Criterion 18, fixed in phase 2.
  it.fails("stops the query when the turn consumer returns early", async () => {
    const { state } = installLongQuery();
    const live = session();

    await consumeThenBail(live, 3);

    expect(state.closed).toBe(true);
  });

  it("lets a later turn resume the same unfinished query", async () => {
    const { state } = installLongQuery();
    const live = session();

    await consumeThenBail(live, 3);
    const producedAfterFirst = state.produced;
    await consumeThenBail(live, 2);

    // The abandoned turn's remaining messages are handed to the next turn's
    // consumer, so an old attempt's provider output reaches a newer attempt.
    expect(state.produced).toBeGreaterThan(producedAfterFirst);
  });

  it("disposes without a settlement handle a caller could await", () => {
    const { state } = installLongQuery();
    const live = session();

    const disposed: unknown = live.dispose();

    // Criterion 20 and 21: settlement must account for provider termination
    // and every metadata promise. `dispose()` returns void, so there is nothing
    // to await and no deadline can be enforced on it.
    expect(disposed).toBeUndefined();
    expect(live.isDisposed).toBe(true);
    expect(state.closed).toBe(false);
  });
});
