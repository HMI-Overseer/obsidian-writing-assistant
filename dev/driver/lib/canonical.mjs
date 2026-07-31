// The Stage 0 gate's comparison form (RFC-0013).
//
// The RFC's gate is "one scenario runs twice and produces the same checkpoints and the same
// transcript". The second half cannot pass as written: `generateId()` in src/utils.ts is
// `Date.now().toString(36) + Math.random()...`, so every message, segment, item, and revision id
// differs between two runs of the same script, as do the timestamps beside them.
//
// So the gate compares canonical transcripts: generated identity and wall-clock are removed,
// and everything a scenario is actually claiming, structure, roles, prose, tool names, tool
// arguments, and dispositions, is preserved.
//
// This is the one place in the instrument where a bug produces false confidence rather than a
// visible failure: a canonicalizer that strips too much turns the gate green by deleting the
// evidence. Hence the explicit key list below rather than a heuristic, and hence its unit test
// asserting both directions.

/**
 * Keys removed at any depth.
 *
 * Every entry is either minted by `generateId()`, read off a wall clock, or reported by a
 * provider per run. Nothing here carries a claim a scenario makes.
 */
const STRIPPED_KEYS = new Set([
  // Generated identity
  "id",
  "revisionId",
  "parentRevisionId",
  "activeRevisionId",
  "sourceItemId",
  "segmentId",
  "toolCallId",
  "interactionId",
  "originBatchId",
  "batchId",
  "actionRef",
  "targetId",
  "eventId",
  // Provider-minted identity
  "providerMessageId",
  "providerBlockId",
  "providerMessageKey",
  // Wall clock and elapsed time
  "createdAt",
  "updatedAt",
  "ts",
  "timestamp",
  "startedAt",
  "completedAt",
  "durationMs",
  "elapsedMs",
  // Provider-reported accounting, which varies per run even on identical input
  "usage",
]);

/** The stripped set, for the run record. A run states what its gate ignored. */
export const CANONICAL_STRIPPED_KEYS = [...STRIPPED_KEYS].sort();

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value === null || typeof value !== "object") return value;

  const out = {};
  for (const key of Object.keys(value).sort()) {
    if (STRIPPED_KEYS.has(key)) continue;
    const child = value[key];
    if (child === undefined) continue;
    out[key] = canonicalValue(child);
  }
  return out;
}

/**
 * The comparable form of one run's conversation, as the plugin stored it.
 *
 * Key order is normalized so `JSON.stringify` of the result is itself stable, which is what the
 * gate diffs and what a run directory writes beside the raw transcript.
 */
export function canonicalTranscript(messages) {
  if (!Array.isArray(messages)) {
    throw new Error("canonicalTranscript expects the message array from the driver's state().");
  }
  return canonicalValue(messages);
}

/** Stable text form, for writing to disk and for equality comparison. */
export function canonicalTranscriptJson(messages) {
  return `${JSON.stringify(canonicalTranscript(messages), null, 2)}\n`;
}
