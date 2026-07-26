import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the single SDK boundary (same shape as sdkSession.test.ts) so a real
// SdkSession can bank a watermark for a zero-text clean interrupt.
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
import {
  decideReuse,
  fingerprint,
  type HarnessSession,
  type SessionConfig,
  type SessionTurn,
} from "../../src/api/harnessSession";
import type { ChatSessionStore } from "../../src/chat/conversation/ChatSessionStore";
import {
  createAssistantTurnMessage,
  createAssistantTurnRevision,
} from "../../src/chat/finalization/assistantTurnFinalization";
import type { Options } from "../../src/api/sdk/claudeAgentSdk";
import type { ConversationMessage } from "../../src/shared/types";

/**
 * Phase 1 end-to-end: a zero-text clean interrupt banks coveredCount = turns + 1
 * with an empty assistant turn (section 6.1). Pre-phase the chat layer persisted NO
 * assistant message for an empty abort, so the next turn's transcript was one
 * turn short → a guaranteed `turn-count` rebuild. Persist-always makes the
 * transcript match the banked prefix, so the next turn REUSES the live session.
 */

function cfg(): SessionConfig {
  return { model: "claude-sonnet-4-6", systemPrompt: "Be concise.", agenticMode: true, toolNames: ["read_file"] };
}

function mintedMeta(): HarnessSession {
  const c = cfg();
  return {
    provider: "claudecode",
    model: c.model,
    coveredCount: 0,
    prefixHash: "",
    configFingerprint: fingerprint(c),
    config: c,
  };
}

function makeStore() {
  const messages: ConversationMessage[] = [];
  const store = {
    appendMessage: (m: ConversationMessage) => messages.push(m),
    setLastAssistantResponse: () => undefined,
  } as unknown as ChatSessionStore;
  return { store, messages };
}

describe("claudecode zero-text interrupt → next-turn reuse", () => {
  beforeEach(() => {
    // Block body: an expression-bodied arrow would return mockReset()'s value (the
    // mock itself), which vitest then invokes as a teardown, calling query() with no
    // args at cleanup.
    queryMock.mockReset();
  });

  it("reuses the interrupted session next turn once the empty assistant turn is persisted", async () => {
    // A turn that yields NO text before the interrupt (thinking / a tool running),
    // then reaches its terminal result once released.
    let release!: () => void;
    const hang = new Promise<void>((r) => {
      release = r;
    });
    const interrupt = vi.fn(() => Promise.resolve());
    queryMock.mockImplementation((params: { prompt: AsyncIterable<{ message: { content: string } }> }) => {
      const input = params.prompt;
      const gen = (async function* () {
        for await (const _msg of input) {
          await hang; // no text yielded before the interrupt
          yield { type: "result", subtype: "success", is_error: false, result: "", session_id: "s", usage: {} };
        }
      })() as AsyncGenerator<unknown> & { interrupt: typeof interrupt };
      gen.interrupt = interrupt;
      return gen;
    });

    const session = new SdkSession(() => ({}) as Options, mintedMeta());
    const turns: SessionTurn[] = [{ role: "user", content: "hi" }];
    const ac = new AbortController();
    const gen = session.runTurn("hi", { turns, signal: ac.signal });

    const pending = gen.next(); // starts the turn, parks on `hang`
    ac.abort(); // request a clean interrupt
    release(); // let the fake reach its terminal result
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });

    // The watermark banked the (empty) assistant turn; the session survives.
    expect(session.wasInterruptedCleanly).toBe(true);
    expect(session.isDisposed).toBe(false);
    expect(session.meta.coveredCount).toBe(2);

    // The chat layer persists the aborted turn (zero text) for claudecode.
    const { store, messages } = makeStore();
    store.appendMessage(
      createAssistantTurnMessage({
        messageId: "assistant-interrupted",
        revision: createAssistantTurnRevision({
          revisionId: "revision-interrupted",
          origin: "generated",
          createdAt: 1,
          provider: "claudecode",
          modelId: cfg().model,
          interrupted: true,
          replayEvidence: {
            tier: "native",
            capabilities: {
              captureOrder: "exact",
              toolCorrelation: "provider_id",
              coldReplay: "textual",
              nativeResume: true,
            },
          },
          turn: {
            schemaVersion: 1,
            id: "turn-interrupted",
            status: "interrupted",
            segments: [],
            items: [],
          },
        }),
        actionLedger: [],
      }),
    );

    // Build the next turn's transcript exactly as the store now holds it, then a
    // new user message. With persist-always this is [user, assistant(""), user].
    const nextTurns: SessionTurn[] = [
      { role: "user", content: "hi" },
      ...messages.map((m) => ({ role: m.role, content: m.content })),
      { role: "user", content: "again" },
    ];

    expect(decideReuse(session, nextTurns, cfg())).toEqual({ reuse: true });
    session.dispose();
  });
});
