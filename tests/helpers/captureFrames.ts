import type { AssistantCaptureFrame } from "../../src/api/assistantCapture";
import type { AssistantStreamEvent } from "../../src/api/usageTypes";

/**
 * Capture-frame doubles for tests that stand in for a Claude Code session or
 * engine.
 *
 * Since RFC-0011 phase 4 those surfaces yield {@link AssistantCaptureFrame},
 * not bare events or text, because the frame boundary is what the builder
 * transaction commits against. Building it here rather than in each test keeps
 * the doubles honest: a stub that yields a shape no provider produces would let
 * a test pass against a contract production never sees.
 */

/** Wraps facts as one frame with a synthetic provider-supplied identity. */
export function captureFrame(
  frameKey: string,
  facts: AssistantStreamEvent[],
  providerMessageKey = "sess-test:msg-test",
): AssistantCaptureFrame {
  return {
    frameKey,
    frameKeySource: "provider",
    providerMessageKey,
    facts,
  };
}

/**
 * A whole prose-only turn, one frame per delta, framed by its segment and turn
 * terminals exactly as the Claude translator frames a real one.
 */
export async function* proseTurnFrames(
  deltas: readonly string[],
  segmentId = "seg-test",
): AsyncGenerator<AssistantCaptureFrame> {
  yield captureFrame("frame-open", [{ type: "segment_start", segmentId }]);
  let ordinal = 0;
  for (const delta of deltas) {
    ordinal += 1;
    yield captureFrame(`frame-delta-${ordinal}`, [
      { type: "prose_delta", segmentId, delta },
    ]);
  }
  yield captureFrame("frame-close", [
    { type: "segment_end", segmentId },
    { type: "turn_end", status: "completed" },
  ]);
}
