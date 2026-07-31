import type { AssistantStreamEvent } from "../api/usageTypes";

/**
 * The authored scenario script the live driver replays (RFC-0013).
 *
 * A frame is one transport frame's worth of provider-neutral facts, the same unit
 * {@link ../api/assistantCapture.AssistantCaptureBatch} carries. Scripts are authored, never
 * captured, so they can hold real prose and paths that exist inside the fixture vault. That is
 * exactly what `tests/fixtures/provider-capture/` may not hold: those are sanitized,
 * content-free protocol-shape fixtures for the Claude translator, and replaying one produces a
 * timeline with no prose and paths that exist in no vault.
 *
 * Because the fact stream is provider-neutral at the `ChatClient` seam, one script drives any
 * provider. Per-provider wire frames would only ever test a translator, which the unit suite
 * already does.
 */

/** The fact types a script may carry: the `AssistantStreamEvent` union, by name. */
const FACT_TYPES = new Set([
  "segment_start",
  "prose_delta",
  "tool_call_start",
  "tool_call_delta",
  "tool_call_identity",
  "segment_reconcile",
  "tool_result",
  "stream_diagnostic",
  "segment_end",
  "turn_end",
]);

export interface DriverScriptFrame {
  /**
   * This frame's identity within the attempt. Authored keys are declared to the capture layer
   * as provider-supplied, so ADR-0031 redelivery is live: a script that repeats a key is
   * scripting a redelivered frame, and the app answers as it would on the wire.
   */
  frameKey: string;
  /** Provider-message identity, when the script is reproducing a protocol that names one. */
  providerMessageKey?: string;
  /** Batch IDs this frame retracts. Provider-authored supersedes only. */
  supersedes?: string[];
  /**
   * Pause before this frame is yielded. Presentation only: it makes streaming observable in a
   * screenshot rather than instantaneous. No checkpoint waits on it, so a scenario that runs
   * with every delay at zero observes the same states in the same order.
   */
  delayMs?: number;
  facts: AssistantStreamEvent[];
}

export interface DriverScript {
  /** The frames directory entry this was loaded from, recorded in the run manifest. */
  id: string;
  /** What `complete()` returns, for the non-streaming path. Empty when the script never needs it. */
  completionText?: string;
  frames: DriverScriptFrame[];
}

/** Default gap between frames when the script does not set one. */
export const DRIVER_FRAME_DELAY_MS = 40;

function fail(path: string, detail: string): never {
  throw new Error(`Driver script ${path}: ${detail}.`);
}

function asRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(path, "expected an object");
  }
  return value as Record<string, unknown>;
}

/**
 * Validates an authored script, rejecting anything it does not understand.
 *
 * Unknown keys and unknown fact types are failures rather than omissions. A script that half
 * parses produces a half turn, and a half turn screenshots as a plausible earlier state, which
 * is the one failure mode this instrument exists to remove.
 */
export function validateDriverScript(raw: unknown, id: string): DriverScript {
  const root = asRecord(raw, id);
  for (const key of Object.keys(root)) {
    if (key !== "completionText" && key !== "frames") {
      fail(id, `unknown key "${key}"`);
    }
  }

  const completionText = root.completionText;
  if (completionText !== undefined && typeof completionText !== "string") {
    fail(id, "completionText must be a string");
  }

  if (!Array.isArray(root.frames) || root.frames.length === 0) {
    fail(id, "frames must be a non-empty array");
  }

  const frames = root.frames.map((entry, index) =>
    validateFrame(entry, `${id} frame ${index}`),
  );

  return {
    id,
    ...(completionText === undefined ? {} : { completionText }),
    frames,
  };
}

function validateFrame(raw: unknown, path: string): DriverScriptFrame {
  const frame = asRecord(raw, path);
  for (const key of Object.keys(frame)) {
    if (
      key !== "frameKey" &&
      key !== "providerMessageKey" &&
      key !== "supersedes" &&
      key !== "delayMs" &&
      key !== "facts"
    ) {
      fail(path, `unknown key "${key}"`);
    }
  }

  if (typeof frame.frameKey !== "string" || frame.frameKey.trim().length === 0) {
    fail(path, "frameKey must be a non-empty string");
  }
  if (
    frame.providerMessageKey !== undefined &&
    typeof frame.providerMessageKey !== "string"
  ) {
    fail(path, "providerMessageKey must be a string");
  }
  const supersedes = validateStringArray(frame.supersedes, path);
  if (
    frame.delayMs !== undefined &&
    (typeof frame.delayMs !== "number" || !Number.isFinite(frame.delayMs) || frame.delayMs < 0)
  ) {
    fail(path, "delayMs must be a non-negative number");
  }
  if (!Array.isArray(frame.facts) || frame.facts.length === 0) {
    fail(path, "facts must be a non-empty array");
  }

  for (const [index, fact] of frame.facts.entries()) {
    const record = asRecord(fact, `${path} fact ${index}`);
    if (typeof record.type !== "string" || !FACT_TYPES.has(record.type)) {
      fail(`${path} fact ${index}`, `unknown fact type "${String(record.type)}"`);
    }
  }

  return {
    frameKey: frame.frameKey,
    ...(frame.providerMessageKey === undefined
      ? {}
      : { providerMessageKey: frame.providerMessageKey }),
    ...(supersedes === undefined ? {} : { supersedes }),
    ...(frame.delayMs === undefined ? {} : { delayMs: frame.delayMs }),
    facts: frame.facts as AssistantStreamEvent[],
  };
}

function validateStringArray(value: unknown, path: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) fail(path, "supersedes must be an array of strings");
  const entries: unknown[] = value;
  if (entries.some((entry) => typeof entry !== "string")) {
    fail(path, "supersedes must be an array of strings");
  }
  return entries as string[];
}
