// The authored scenario script the live driver replays (RFC-0013).
//
// A frame is one transport frame's worth of provider-neutral facts, the same unit
// `AssistantCaptureBatch` carries. Scripts are authored, never captured, so they can hold real
// prose and paths that exist inside the fixture vault. That is exactly what
// `tests/fixtures/provider-capture/` may not hold: those are sanitized, content-free
// protocol-shape fixtures for the Claude translator, and replaying one produces a timeline with
// no prose and paths that exist in no vault.
//
// Because the fact stream is provider-neutral at the `createChatClient` seam, one script drives
// any provider. That property is the reason the driver replaces the factory rather than the wire:
// a wire-level mock would make every frame per-provider, and would not reach Claude Code at all.
//
// Validation happens here, in Node, before anything launches. Stage 0 validated inside the page,
// which spent a launch to learn that a frame had a typo in it.
//
// A script is a list of frames and also a list of **rounds**, because one `ChatClient.stream()`
// call is one provider response and the agentic loop makes one per round: prose, a tool call, the
// plugin executes it, then the model is streamed again. Stage 1's scripts were all single-round,
// so nothing forced the distinction; a tool-bearing script does, and without it the scripted
// client would replay its one round on every call and the loop would spin to its round cap.
//
// The boundary is the `turn_end` fact, which is what already means "this provider response
// ended", so no new key is invented and no author has to learn one. It is load-bearing here in a
// way it is not inside the plugin (the turn builder ignores it), which is why the validator
// insists on it: `turn_end` must be the last fact of its frame, and the last frame must carry
// one. A script whose rounds are ambiguous fails in Node rather than half-driving a live app.

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

/** The fact that ends one provider response, and therefore one round. */
const TURN_TERMINAL = "turn_end";

/**
 * Correlation values a `tool_call_identity` fact may carry.
 *
 * Checked here rather than left to the type check alone, because the scripted client now *reads*
 * this field to decide what replay evidence the attempt may claim. An unrecognised value would
 * quietly become "no correlation", which is a transcript saying something about the run that the
 * script did not.
 */
const CORRELATIONS = new Set(["provider_id", "plugin_id", "none"]);

/** Default gap between frames when the script does not set one. */
export const DRIVER_FRAME_DELAY_MS = 40;

function fail(path, detail) {
  throw new Error(`Driver script ${path}: ${detail}.`);
}

function asRecord(value, path) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(path, "expected an object");
  }
  return value;
}

/**
 * Validates an authored script, rejecting anything it does not understand.
 *
 * Unknown keys and unknown fact types are failures rather than omissions. A script that half
 * parses produces a half turn, and a half turn screenshots as a plausible earlier state, which
 * is the one failure mode this instrument exists to remove.
 */
export function validateDriverScript(raw, id) {
  const root = asRecord(raw, id);
  for (const key of Object.keys(root)) {
    // `_comment` is ignored on purpose and is the one exception to failing on an unknown key.
    // JSON carries no comments, and a script whose pacing or authoring has a reason needs that
    // reason beside the frames rather than in a document nobody opens next to them. The fixture
    // vault's settings.json set the same convention in this instrument. It is a root note only:
    // a frame and a fact still reject everything they do not understand.
    if (key !== "completionText" && key !== "frames" && key !== "description" && key !== "_comment") {
      fail(id, `unknown key "${key}"`);
    }
  }

  const { completionText, description } = root;
  if (completionText !== undefined && typeof completionText !== "string") {
    fail(id, "completionText must be a string");
  }
  if (description !== undefined && typeof description !== "string") {
    fail(id, "description must be a string");
  }

  if (!Array.isArray(root.frames) || root.frames.length === 0) {
    fail(id, "frames must be a non-empty array");
  }

  const frames = root.frames.map((entry, index) => validateFrame(entry, `${id} frame ${index}`));

  return {
    id,
    ...(description === undefined ? {} : { description }),
    ...(completionText === undefined ? {} : { completionText }),
    frames,
    rounds: partitionRounds(frames, id),
  };
}

/**
 * The frames of each provider response, in order.
 *
 * Frames left over after the last `turn_end` would never be streamed, because the client opens a
 * round per `stream()` call and a round it cannot terminate is a round nobody asked for. That is
 * an authoring mistake with a silent failure mode (a turn that ends early and screenshots as a
 * plausible earlier state), so it is a validation failure instead.
 */
function partitionRounds(frames, id) {
  const rounds = [];
  let current = [];
  for (const frame of frames) {
    current.push(frame);
    if (frame.facts[frame.facts.length - 1].type === TURN_TERMINAL) {
      rounds.push(current);
      current = [];
    }
  }
  if (current.length > 0) {
    fail(
      id,
      `the last ${current.length} frame(s) carry no ${TURN_TERMINAL} fact, so no round ends ` +
        `with them. One stream() call plays one round, and a round ends at ${TURN_TERMINAL}`,
    );
  }
  return rounds;
}

function validateFrame(raw, path) {
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
  if (frame.providerMessageKey !== undefined && typeof frame.providerMessageKey !== "string") {
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
    const where = `${path} fact ${index}`;
    const record = asRecord(fact, where);
    if (typeof record.type !== "string" || !FACT_TYPES.has(record.type)) {
      fail(where, `unknown fact type "${String(record.type)}"`);
    }
    if (record.type === TURN_TERMINAL && index !== frame.facts.length - 1) {
      fail(where, `${TURN_TERMINAL} must be the last fact of its frame, because it ends a round`);
    }
    if (record.type === "tool_call_identity" && !CORRELATIONS.has(record.correlation)) {
      fail(where, `correlation must be one of ${[...CORRELATIONS].join(", ")}`);
    }
  }

  return {
    frameKey: frame.frameKey,
    ...(frame.providerMessageKey === undefined
      ? {}
      : { providerMessageKey: frame.providerMessageKey }),
    ...(supersedes === undefined ? {} : { supersedes }),
    ...(frame.delayMs === undefined ? {} : { delayMs: frame.delayMs }),
    facts: frame.facts,
  };
}

function validateStringArray(value, path) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) fail(path, "supersedes must be an array of strings");
  if (value.some((entry) => typeof entry !== "string")) {
    fail(path, "supersedes must be an array of strings");
  }
  return value;
}
