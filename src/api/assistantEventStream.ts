import type {
  AssistantStreamEvent,
  AssistantStreamMetadata,
  StreamResult,
} from "./usageTypes";

export interface AssistantEventTranslator {
  finishEvents(): AssistantStreamEvent[];
  metadata(): AssistantStreamMetadata;
}

/**
 * Bridge a legacy text-yielding SSE transport to the ordered event contract.
 *
 * Provider payload callbacks fill `pendingEvents` before the transport yields its
 * corresponding text token. No event escapes until the generator commits to that
 * attempt. A pre-yield transport failure therefore remains retryable.
 */
export function createAssistantEventStream(
  rawStream: AsyncGenerator<string>,
  pendingEvents: AssistantStreamEvent[],
  translator: AssistantEventTranslator,
  decorateError?: (error: unknown) => unknown,
): StreamResult {
  let resolveUsage!: (value: AssistantStreamMetadata["usage"]) => void;
  let resolveStopReason!: (
    value: AssistantStreamMetadata["stopReason"],
  ) => void;
  let resolveReplayCapsule!: (
    value: AssistantStreamMetadata["replayCapsule"],
  ) => void;
  let resolveReplayEvidence!: (
    value: AssistantStreamMetadata["replayEvidence"],
  ) => void;
  const usage = new Promise<AssistantStreamMetadata["usage"]>((resolve) => {
    resolveUsage = resolve;
  });
  const stopReason = new Promise<AssistantStreamMetadata["stopReason"]>(
    (resolve) => {
      resolveStopReason = resolve;
    },
  );
  const replayCapsule = new Promise<
    AssistantStreamMetadata["replayCapsule"]
  >((resolve) => {
    resolveReplayCapsule = resolve;
  });
  const replayEvidence = new Promise<
    AssistantStreamMetadata["replayEvidence"]
  >((resolve) => {
    resolveReplayEvidence = resolve;
  });

  const drainPending = function* (): Generator<AssistantStreamEvent> {
    while (pendingEvents.length > 0) {
      const event = pendingEvents.shift();
      if (event !== undefined) yield event;
    }
  };

  async function* events(): AsyncGenerator<AssistantStreamEvent> {
    try {
      const iterator = rawStream[Symbol.asyncIterator]();
      while (!(await iterator.next()).done) {
        yield* drainPending();
      }
      pendingEvents.push(...translator.finishEvents());
      yield* drainPending();
    } catch (error) {
      throw decorateError ? decorateError(error) : error;
    } finally {
      const metadata = translator.metadata();
      resolveUsage(metadata.usage);
      resolveStopReason(metadata.stopReason);
      resolveReplayCapsule(metadata.replayCapsule);
      resolveReplayEvidence(metadata.replayEvidence);
    }
  }

  return {
    events: events(),
    usage,
    stopReason,
    replayCapsule,
    replayEvidence,
  };
}
