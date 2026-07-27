import type { ProviderOption } from "../shared/types";
import type {
  AssistantCaptureBatch,
  AssistantCaptureFrame,
} from "./assistantCapture";
import { derivedFrameKey, sealCaptureFrame } from "./assistantCapture";
import type {
  AssistantStreamAttemptContext,
  AssistantStreamRun,
} from "./assistantStreamRun";
import { closeIterator, createStreamMetadataGate } from "./assistantStreamRun";
import { createOwnedStreamRun } from "./assistantStreamRuntime";
import type { AssistantStreamEvent, AssistantStreamMetadata } from "./usageTypes";

export interface AssistantEventTranslator {
  translate(payload: unknown): AssistantStreamEvent[];
  finishEvents(): AssistantStreamEvent[];
  metadata(): AssistantStreamMetadata;
  /**
   * The provider message this attempt's facts belong to, once the stream has
   * named one. It is the key a `segment` placement carries, so a translator that
   * never sees a provider message ID leaves its items honestly unplaced.
   */
  providerMessageKey(): string | undefined;
}

/**
 * Frame-preserving queue between a transport's payload callback and the stream.
 *
 * The transport parses one SSE payload, hands it here, and yields its text token
 * separately, so several payloads can arrive between two yields. A flat event
 * array loses that grouping: the tool loop sees one event at a time and publishes
 * a snapshot after each, which is exactly the seam an atomic transaction cannot
 * be built on. One payload is one frame, and one frame is one batch (ADR-0031).
 *
 * A payload that translates to no facts is not a frame. Publishing an empty
 * batch would produce a snapshot for nothing, which the flat buffer also
 * (accidentally) avoided.
 */
export class CaptureFrameQueue {
  private readonly pending: AssistantCaptureFrame[] = [];

  constructor(private readonly translator: AssistantEventTranslator) {}

  /**
   * Translates one raw transport payload into at most one frame.
   *
   * Bound as a property so it can be handed straight to a transport's `onEvent`
   * hook without the call site re-binding it.
   */
  readonly onPayload = (payload: unknown, raw: string): void => {
    this.record(this.translator.translate(payload), derivedFrameKey(raw));
  };

  /** Records the translator's terminal facts as one final frame. */
  finish(): void {
    this.record(this.translator.finishEvents(), TERMINAL_FRAME_KEY);
  }

  *drain(): Generator<AssistantCaptureFrame> {
    while (this.pending.length > 0) {
      const frame = this.pending.shift();
      if (frame !== undefined) yield frame;
    }
  }

  private record(facts: AssistantStreamEvent[], frameKey: string): void {
    if (facts.length === 0) return;
    const providerMessageKey = this.translator.providerMessageKey();
    this.pending.push({
      frameKey,
      // Neither Anthropic nor the OpenAI-compatible surface gives an SSE payload
      // a wire identity, so this key names the frame's bytes rather than its
      // delivery and cannot be read as proof of redelivery.
      frameKeySource: "derived",
      facts,
      ...(providerMessageKey === undefined ? {} : { providerMessageKey }),
    });
  }
}

/**
 * The translator's own terminal facts are not a transport frame, so they get a
 * fixed key of their own rather than a digest of bytes that do not exist.
 */
const TERMINAL_FRAME_KEY = "derived-stream-terminal";

/** What a direct HTTP provider supplies beyond its raw byte stream. */
export interface AssistantCaptureStreamOptions {
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
 * Bridge a legacy text-yielding SSE transport to the owned capture contract.
 *
 * The queue is filled by the provider's payload callback before the transport
 * yields its corresponding text token. No batch escapes until the generator
 * commits to that attempt, so a pre-yield transport failure remains retryable.
 *
 * Ownership (ADR-0032): the raw iterator is acquired into a variable
 * outside the loop and returned in `finally` on every exit but natural
 * exhaustion. Previously it was acquired inside the `try` and never returned, so
 * a consumer that stopped reading left the transport generator suspended with its
 * socket open. Metadata still resolves on every path, including the paths that
 * now abort.
 */
export function createAssistantCaptureStream(
  rawStream: AsyncGenerator<string>,
  frames: CaptureFrameQueue,
  translator: AssistantEventTranslator,
  options: AssistantCaptureStreamOptions,
): AssistantStreamRun {
  const metadata = createStreamMetadataGate();
  const leaseId = options.attempt.leaseId;

  const drainBatches = function* (): Generator<AssistantCaptureBatch> {
    for (const frame of frames.drain()) yield sealCaptureFrame(leaseId, frame);
  };

  async function* source(): AsyncGenerator<AssistantCaptureBatch> {
    let raw: AsyncIterator<string> | null = null;
    let exhausted = false;
    try {
      raw = rawStream[Symbol.asyncIterator]();
      while (!(await raw.next()).done) {
        yield* drainBatches();
      }
      frames.finish();
      yield* drainBatches();
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
