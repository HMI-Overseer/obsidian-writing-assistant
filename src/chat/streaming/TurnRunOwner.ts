import type {
  AssistantStreamAttemptContext,
  AssistantStreamRun,
  AssistantStreamSettlement,
  StreamCancelReason,
} from "../../api/assistantStreamRun";
import {
  boundedFailureMessage,
  cancelReasonForAbort,
  createSettleOnce,
  leaseIdFor,
} from "../../api/assistantStreamRun";

/**
 * Turn-level ownership of every provider attempt (RFC-0011 phase 2, settled plan
 * decision 12).
 *
 * The owner is constructed from the pre-minted turn ID *before* retry can call a
 * provider, which closes the gap the incident exposed: a run that fails during
 * construction, or is abandoned between retries, previously had no one holding it.
 * Here every attempt gets a lease before its factory is invoked, so there is no
 * instant at which a provider is running and unowned.
 *
 * The owner does not consume events and does not know what a batch is. It knows
 * which attempts exist, which one was selected, whether any of them let a
 * consequential callback through, and how to make all of them stop.
 */

/** Where one attempt is in its life. */
export type AttemptLeaseState = "open" | "committed" | "stopping" | "settled";

/** The settlement synthesized for a lease whose provider never constructed. */
function constructionFailureSettlement(
  reason: StreamCancelReason,
  error: unknown,
): AssistantStreamSettlement {
  return {
    quiescence: "proven",
    reason,
    hardDisposed: false,
    diagnostics:
      error === undefined
        ? []
        : [
            {
              code: "attempt_construction_failed",
              provider: "unknown",
              stage: "construction",
              message: boundedFailureMessage(error),
            },
          ],
  };
}

/**
 * One owned provider attempt.
 *
 * A lease exists from before its factory runs until it is proven quiet, so it
 * settles whether the factory threw, the provider failed, the consumer walked
 * away, or the turn completed normally.
 */
export class AttemptLease<Event> {
  readonly context: AssistantStreamAttemptContext;

  private run: AssistantStreamRun<Event> | null = null;
  private leaseState: AttemptLeaseState = "open";
  private stopping: Promise<AssistantStreamSettlement> | null = null;
  private readonly controller: AbortController;
  private readonly settlement = createSettleOnce<AssistantStreamSettlement>(
    constructionFailureSettlement("retry_abandoned", undefined),
  );

  constructor(turnId: string, attemptOrdinal: number, controller: AbortController) {
    this.controller = controller;
    this.context = {
      turnId,
      attemptOrdinal,
      leaseId: leaseIdFor(turnId, attemptOrdinal),
      signal: controller.signal,
    };
  }

  get state(): AttemptLeaseState {
    return this.leaseState;
  }

  /** Resolves once this attempt can issue no further work. */
  get settled(): Promise<AssistantStreamSettlement> {
    return this.settlement.promise;
  }

  /** True once nothing more can come from this attempt. */
  get isQuiet(): boolean {
    return this.settlement.isSettled;
  }

  /** Hands the lease the run its factory produced. */
  attach(run: AssistantStreamRun<Event>): void {
    this.run = run;
    // A run that settles on its own, by exhaustion or by its own failure, settles
    // the lease with it. The lease never invents a second account of the same
    // attempt.
    void run.settled.then(
      (settlement) => {
        this.leaseState = "settled";
        this.settlement.settle(settlement);
      },
      (error) => {
        this.leaseState = "settled";
        this.settlement.settle(
          constructionFailureSettlement("provider_failed", error),
        );
      },
    );
  }

  /**
   * Records that the factory threw, so the lease settles rather than leaving the
   * turn waiting on an attempt that never existed.
   */
  failConstruction(error: unknown): void {
    this.leaseState = "settled";
    this.settlement.settle(
      constructionFailureSettlement("provider_failed", error),
    );
  }

  /** Marks this attempt as the one the turn selected. */
  commit(): void {
    if (this.leaseState === "open") this.leaseState = "committed";
  }

  /**
   * Idempotent cancellation. The first reason wins, so a user Stop that arrives
   * before the consumer unwinds is not overwritten by the `consumer_returned` the
   * unwinding produces.
   */
  async cancel(reason: StreamCancelReason): Promise<AssistantStreamSettlement> {
    if (this.settlement.isSettled) return this.settlement.promise;
    if (this.stopping) return this.stopping;
    this.leaseState = "stopping";
    this.stopping = (async () => {
      if (!this.controller.signal.aborted) this.controller.abort();
      const run = this.run;
      if (!run) {
        this.leaseState = "settled";
        this.settlement.settle(constructionFailureSettlement(reason, undefined));
        return this.settlement.promise;
      }
      await run.cancel(reason);
      return this.settlement.promise;
    })();
    return this.stopping;
  }
}

/** How the owner reports why a retry is not permitted. */
export type RetryRefusal = "consequential_callback_entered";

export class TurnRunOwner<Event> {
  readonly turnId: string;

  private readonly leases: AttemptLease<Event>[] = [];
  private nextOrdinal = 1;
  private selected: AttemptLease<Event> | null = null;
  private callbackEntered = false;
  private readonly turnSignal: AbortSignal | undefined;
  private readonly onTurnAbort: () => void;

  /**
   * @param turnId the pre-minted turn ID, so lease identity is stable from before
   *   the first provider call rather than being invented per attempt.
   * @param turnSignal the generation's abort signal. When it fires, every open
   *   attempt is cancelled with the reason the abort itself carries: `user_stop`
   *   for a Stop, `plugin_unload` for teardown. Only the first may preserve a
   *   Claude session, so the difference is read from the signal rather than
   *   inferred from whichever `AbortError` surfaces first in the unwind.
   */
  constructor(turnId: string, turnSignal?: AbortSignal) {
    this.turnId = turnId;
    this.turnSignal = turnSignal;
    this.onTurnAbort = () => {
      void this.cancelAll(
        turnSignal ? cancelReasonForAbort(turnSignal) : "user_stop",
      );
    };
    if (turnSignal) {
      if (turnSignal.aborted) this.onTurnAbort();
      else turnSignal.addEventListener("abort", this.onTurnAbort, { once: true });
    }
  }

  /** The attempt the turn selected, once one has been committed. */
  get committedAttempt(): AttemptLease<Event> | null {
    return this.selected;
  }

  /** True once every attempt this turn opened is quiet. */
  get isQuiet(): boolean {
    return this.leases.every((lease) => lease.isQuiet);
  }

  /**
   * True once a callback with an irreversible outcome was admitted under any of
   * this turn's attempts.
   *
   * Phase 2 owns the flag and the retry refusal it drives; phase 5 wires the
   * Claude callback surfaces that set it. Retry permission depends on this rather
   * than on whether the UI happened to receive a first event, because a retried
   * request can repeat consequential work that the first attempt already did.
   */
  get consequentialCallbackEntered(): boolean {
    return this.callbackEntered;
  }

  noteConsequentialCallback(): void {
    this.callbackEntered = true;
  }

  /** Why a retry is refused, or null when it is permitted. */
  retryRefusal(): RetryRefusal | null {
    return this.callbackEntered ? "consequential_callback_entered" : null;
  }

  /**
   * Opens the next attempt. Called before the provider factory, so construction
   * failure still has a lease to settle.
   */
  openAttempt(): AttemptLease<Event> {
    const controller = new AbortController();
    if (this.turnSignal?.aborted) controller.abort();
    const lease = new AttemptLease<Event>(
      this.turnId,
      this.nextOrdinal++,
      controller,
    );
    this.leases.push(lease);
    return lease;
  }

  /** Explicitly transfers the committed attempt to the turn's ownership. */
  commitAttempt(lease: AttemptLease<Event>): void {
    lease.commit();
    this.selected = lease;
  }

  /**
   * Cancels the committed attempt. This is the finalizer the retry wrapper calls
   * from its own `finally`: after commitment the wrapper is an iterator-cleanup
   * custodian, not a second owner.
   */
  async finalizeCommitted(reason: StreamCancelReason): Promise<void> {
    if (!this.selected) return;
    await this.selected.cancel(reason);
  }

  /** Cancels every attempt that is not already quiet. Idempotent. */
  async cancelAll(reason: StreamCancelReason): Promise<void> {
    await Promise.all(
      this.leases
        .filter((lease) => !lease.isQuiet)
        .map((lease) => lease.cancel(reason)),
    );
  }

  /** Waits for every attempt to be quiet without cancelling anything. */
  async awaitQuiescence(): Promise<AssistantStreamSettlement[]> {
    return Promise.all(this.leases.map((lease) => lease.settled));
  }

  /** Releases the turn-level abort subscription. Safe to call more than once. */
  release(): void {
    this.turnSignal?.removeEventListener("abort", this.onTurnAbort);
  }
}
