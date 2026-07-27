import { describe, expect, it, vi } from "vitest";
import {
  PLUGIN_UNLOAD_ABORT_REASON,
  createStreamMetadataGate,
} from "../../../../src/api/assistantStreamRun";
import type { AssistantStreamRun } from "../../../../src/api/assistantStreamRun";
import {
  createOwnedStreamRun,
  detachedAttemptContext,
} from "../../../../src/api/assistantStreamRuntime";
import { TurnRunOwner } from "../../../../src/chat/streaming/TurnRunOwner";

/**
 * RFC-0011 phase 2: turn-run and attempt ownership.
 *
 * The owner's job is that no instant exists in which a provider is running and
 * unowned, and that every attempt settles exactly once with an honest reason.
 */

/** A run that never ends on its own, so only cancellation can settle it. */
function endlessRun(label: string): {
  run: AssistantStreamRun<string>;
  state: { closed: boolean };
} {
  const state = { closed: false };
  const metadata = createStreamMetadataGate();
  async function* source(): AsyncGenerator<string> {
    try {
      for (;;) yield "chunk";
    } finally {
      state.closed = true;
    }
  }
  return {
    run: createOwnedStreamRun<string>({
      attempt: detachedAttemptContext(label),
      provider: "anthropic",
      open: source,
      metadata,
    }),
    state,
  };
}

describe("TurnRunOwner attempt identity", () => {
  it("allocates monotonic ordinals and lease IDs from the pre-minted turn ID", () => {
    const owner = new TurnRunOwner<string>("turn-abc");

    const first = owner.openAttempt();
    const second = owner.openAttempt();

    expect(first.context).toMatchObject({
      turnId: "turn-abc",
      attemptOrdinal: 1,
      leaseId: "turn-abc#1",
    });
    expect(second.context).toMatchObject({
      attemptOrdinal: 2,
      leaseId: "turn-abc#2",
    });
  });

  it("gives each attempt a signal of its own", () => {
    const owner = new TurnRunOwner<string>("turn-abc");
    const first = owner.openAttempt();
    const second = owner.openAttempt();

    void first.cancel("retry_abandoned");

    expect(first.context.signal.aborted).toBe(true);
    expect(second.context.signal.aborted).toBe(false);
  });
});

describe("TurnRunOwner settlement", () => {
  it("settles a lease whose factory never produced a run", async () => {
    const owner = new TurnRunOwner<string>("turn-abc");
    const lease = owner.openAttempt();

    lease.failConstruction(new Error("could not construct the provider stream"));

    expect(lease.isQuiet).toBe(true);
    expect(owner.isQuiet).toBe(true);
    const settlement = await lease.settled;
    expect(settlement.reason).toBe("provider_failed");
    expect(settlement.diagnostics[0]?.code).toBe("attempt_construction_failed");
  });

  it("settles an attached run through cancellation", async () => {
    const owner = new TurnRunOwner<string>("turn-abc");
    const lease = owner.openAttempt();
    const { run, state } = endlessRun("a1");
    lease.attach(run);
    const iterator = run.events[Symbol.asyncIterator]();
    await iterator.next();

    await lease.cancel("retry_abandoned");

    expect(state.closed).toBe(true);
    expect(lease.isQuiet).toBe(true);
    await expect(lease.settled).resolves.toMatchObject({
      reason: "retry_abandoned",
    });
  });

  it("is idempotent under concurrent cancellation", async () => {
    const owner = new TurnRunOwner<string>("turn-abc");
    const lease = owner.openAttempt();
    const { run } = endlessRun("a1");
    lease.attach(run);
    const iterator = run.events[Symbol.asyncIterator]();
    await iterator.next();

    await Promise.all([
      lease.cancel("user_stop"),
      lease.cancel("downstream_failed"),
      owner.cancelAll("consumer_returned"),
    ]);

    await expect(lease.settled).resolves.toMatchObject({ reason: "user_stop" });
  });

  it("awaits every attempt, not only the committed one", async () => {
    const owner = new TurnRunOwner<string>("turn-abc");
    const abandoned = owner.openAttempt();
    const committed = owner.openAttempt();
    const first = endlessRun("a1");
    const second = endlessRun("a2");
    abandoned.attach(first.run);
    committed.attach(second.run);
    owner.commitAttempt(committed);
    await first.run.events[Symbol.asyncIterator]().next();
    await second.run.events[Symbol.asyncIterator]().next();

    await owner.cancelAll("plugin_unload");
    await owner.awaitQuiescence();

    expect(owner.isQuiet).toBe(true);
    expect(first.state.closed).toBe(true);
    expect(second.state.closed).toBe(true);
    expect(owner.committedAttempt).toBe(committed);
  });
});

describe("TurnRunOwner abort reasons", () => {
  it("cancels open attempts as user_stop when the turn signal fires", async () => {
    const controller = new AbortController();
    const owner = new TurnRunOwner<string>("turn-abc", controller.signal);
    const lease = owner.openAttempt();
    const { run } = endlessRun("a1");
    lease.attach(run);
    await run.events[Symbol.asyncIterator]().next();

    controller.abort();
    await owner.awaitQuiescence();

    await expect(lease.settled).resolves.toMatchObject({ reason: "user_stop" });
  });

  it("cancels as plugin_unload when the abort carries the teardown reason", async () => {
    const controller = new AbortController();
    const owner = new TurnRunOwner<string>("turn-abc", controller.signal);
    const lease = owner.openAttempt();
    const { run } = endlessRun("a1");
    lease.attach(run);
    await run.events[Symbol.asyncIterator]().next();

    // Only `user_stop` may preserve a Claude session for reuse, so teardown must
    // not be mistaken for a Stop.
    controller.abort(PLUGIN_UNLOAD_ABORT_REASON);
    await owner.awaitQuiescence();

    await expect(lease.settled).resolves.toMatchObject({ reason: "plugin_unload" });
  });

  it("opens an already-aborted attempt when the turn was stopped first", () => {
    const controller = new AbortController();
    controller.abort();
    const owner = new TurnRunOwner<string>("turn-abc", controller.signal);

    expect(owner.openAttempt().context.signal.aborted).toBe(true);
  });
});

describe("TurnRunOwner retry permission", () => {
  it("permits retry until a consequential callback enters", () => {
    const owner = new TurnRunOwner<string>("turn-abc");

    expect(owner.retryRefusal()).toBeNull();
    owner.noteConsequentialCallback();

    // Criterion 16: retry permission is lease evidence, not "did the UI see a
    // delta". Phase 5 wires the Claude callback surfaces that set this.
    expect(owner.consequentialCallbackEntered).toBe(true);
    expect(owner.retryRefusal()).toBe("consequential_callback_entered");
  });

  it("refuses retry once the bound callback lease reports a crossed boundary", () => {
    const owner = new TurnRunOwner<string>("turn-abc");
    let sink: (() => void) | null = null;
    owner.bindCallbackLease({
      noteAttempt: vi.fn(),
      onConsequentialCallback: (fn: () => void) => {
        sink = fn;
      },
    });

    expect(owner.retryRefusal()).toBeNull();
    // Phase 2 built the flag and the refusal it drives with no production writer.
    // This is the writer phase 5 wires: a Claude callback crossing an effect
    // boundary, reported through the lease.
    sink?.();

    expect(owner.retryRefusal()).toBe("consequential_callback_entered");
  });

  it("stamps each attempt's ordinal onto the bound callback lease", () => {
    const owner = new TurnRunOwner<string>("turn-abc");
    const noteAttempt = vi.fn();
    owner.bindCallbackLease({
      noteAttempt,
      onConsequentialCallback: () => undefined,
    });

    owner.openAttempt();
    owner.openAttempt();

    // The ordinal is evidence on a generation-scoped lease, never its identity.
    expect(noteAttempt.mock.calls).toEqual([[1], [2]]);
  });

  it("stops listening to the turn signal once released", async () => {
    const controller = new AbortController();
    const owner = new TurnRunOwner<string>("turn-abc", controller.signal);
    const lease = owner.openAttempt();
    const cancel = vi.spyOn(lease, "cancel");

    owner.release();
    controller.abort();
    await Promise.resolve();

    expect(cancel).not.toHaveBeenCalled();
  });
});
