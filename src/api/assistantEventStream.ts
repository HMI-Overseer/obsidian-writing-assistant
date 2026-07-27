import type { ProviderOption } from "../shared/types";
import type {
  AssistantStreamAttemptContext,
  AssistantStreamRun,
} from "./assistantStreamRun";
import { closeIterator, createStreamMetadataGate } from "./assistantStreamRun";
import { createOwnedStreamRun } from "./assistantStreamRuntime";
import type { AssistantStreamEvent, AssistantStreamMetadata } from "./usageTypes";

export interface AssistantEventTranslator {
  finishEvents(): AssistantStreamEvent[];
  metadata(): AssistantStreamMetadata;
}

/** What a direct HTTP provider supplies beyond its raw byte stream. */
export interface AssistantEventStreamOptions {
  /** Identity and cancellation authority for this attempt. */
  attempt: AssistantStreamAttemptContext;
  /** Provider key, recorded on settlement diagnostics. */
  provider: ProviderOption;
  /**
   * Aborts the transport controller this attempt owns. Called before the raw
   * iterator is returned, so the socket is torn down rather than left to the
   * generator's own unwinding.
   */
  abort: () => void;
  decorateError?: (error: unknown) => unknown;
}

/**
 * Bridge a legacy text-yielding SSE transport to the owned stream contract.
 *
 * Provider payload callbacks fill `pendingEvents` before the transport yields its
 * corresponding text token. No event escapes until the generator commits to that
 * attempt. A pre-yield transport failure therefore remains retryable.
 *
 * Ownership (RFC-0011 phase 2): the raw iterator is acquired into a variable
 * outside the loop and returned in `finally` on every exit but natural
 * exhaustion. Previously it was acquired inside the `try` and never returned, so
 * a consumer that stopped reading left the transport generator suspended with its
 * socket open. Metadata still resolves on every path, including the paths that
 * now abort.
 */
export function createAssistantEventStream(
  rawStream: AsyncGenerator<string>,
  pendingEvents: AssistantStreamEvent[],
  translator: AssistantEventTranslator,
  options: AssistantEventStreamOptions,
): AssistantStreamRun<AssistantStreamEvent> {
  const metadata = createStreamMetadataGate();

  const drainPending = function* (): Generator<AssistantStreamEvent> {
    while (pendingEvents.length > 0) {
      const event = pendingEvents.shift();
      if (event !== undefined) yield event;
    }
  };

  async function* source(): AsyncGenerator<AssistantStreamEvent> {
    let raw: AsyncIterator<string> | null = null;
    let exhausted = false;
    try {
      raw = rawStream[Symbol.asyncIterator]();
      while (!(await raw.next()).done) {
        yield* drainPending();
      }
      pendingEvents.push(...translator.finishEvents());
      yield* drainPending();
      exhausted = true;
    } catch (error) {
      throw options.decorateError ? options.decorateError(error) : error;
    } finally {
      if (!exhausted) {
        options.abort();
        await closeIterator(raw);
      }
      // The translator's terminal facts are whatever it managed to select, even
      // on an aborted attempt. Anything it could not supply is filled with its
      // bounded fallback by the run's own settlement.
      const terminal = translator.metadata();
      metadata.usage.settle(terminal.usage);
      metadata.stopReason.settle(terminal.stopReason);
      metadata.replayCapsule.settle(terminal.replayCapsule);
      metadata.replayEvidence.settle(terminal.replayEvidence);
    }
  }

  return createOwnedStreamRun({
    attempt: options.attempt,
    provider: options.provider,
    open: source,
    metadata,
    abort: options.abort,
  });
}
