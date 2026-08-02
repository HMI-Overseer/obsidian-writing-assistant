import { describe, expect, it } from "vitest";
import {
  CaptureConflictError,
  batchesAreIdentical,
  canonicalJson,
  canonicalizeFrameEvidence,
  captureBatchId,
  captureDigest,
  createCaptureBatch,
  fingerprintFacts,
  frameKeyFromEvidence,
  type CanonicalFrameEvidence,
} from "../../../src/api/assistantCapture";
import {
  closeIterator,
  createSettleOnce,
  createStreamMetadataGate,
  leaseIdFor,
} from "../../../src/api/assistantStreamRun";
import { CAPTURE_FINGERPRINT_LENGTH } from "../../../src/constants";
import type { AssistantStreamEvent } from "../../../src/api/usageTypes";

const FACTS: AssistantStreamEvent[] = [
  { type: "segment_start", segmentId: "s1", providerMessageId: "msg_1" },
  {
    type: "tool_call_start",
    segmentId: "s1",
    declarationKey: "s1:block-2",
    providerBlockId: "block-2",
    toolName: "read",
  },
  {
    type: "tool_call_identity",
    declarationKey: "s1:block-2",
    toolCallId: "toolu_1",
    correlation: "provider_id",
  },
];

function evidence(overrides: Partial<CanonicalFrameEvidence> = {}): CanonicalFrameEvidence {
  return {
    providerMessageId: "msg_1",
    blockIndex: 2,
    blockType: "tool_use",
    toolCallId: "toolu_1",
    rawContentHash: captureDigest('{"path":"a.md"}'),
    ...overrides,
  };
}

describe("capture batch identity", () => {
  it("scopes batch identity to the lease", () => {
    const first = createCaptureBatch({ leaseId: "turn-1#1", frameKey: "frame-a", facts: FACTS });
    const second = createCaptureBatch({ leaseId: "turn-1#2", frameKey: "frame-a", facts: FACTS });

    expect(first.batchId).not.toBe(second.batchId);
    expect(first.factsFingerprint).toBe(second.factsFingerprint);
    expect(batchesAreIdentical(first, second)).toBe(false);
  });

  it("is idempotent for a redelivered frame under one lease", () => {
    const first = createCaptureBatch({ leaseId: "turn-1#1", frameKey: "frame-a", facts: FACTS });
    const again = createCaptureBatch({
      leaseId: "turn-1#1",
      frameKey: "frame-a",
      facts: structuredClone(FACTS),
    });
    expect(batchesAreIdentical(first, again)).toBe(true);
  });

  it("detects a redelivered frame key carrying different bytes", () => {
    const first = createCaptureBatch({ leaseId: "turn-1#1", frameKey: "frame-a", facts: FACTS });
    const changed = createCaptureBatch({
      leaseId: "turn-1#1",
      frameKey: "frame-a",
      facts: [...FACTS.slice(0, 2)],
    });
    expect(changed.batchId).toBe(first.batchId);
    expect(batchesAreIdentical(first, changed)).toBe(false);
  });

  it("builds the batch ID from the lease and the frame key only", () => {
    expect(captureBatchId("turn-9#3", "frame-x")).toBe("turn-9#3:frame-x");
    expect(leaseIdFor("turn-9", 3)).toBe("turn-9#3");
  });
});

describe("canonicalization", () => {
  it("derives one frame key from characterized protocol fields", () => {
    expect(frameKeyFromEvidence(evidence())).toBe(frameKeyFromEvidence(evidence()));
  });

  it("separates two block indices under one provider message", () => {
    expect(frameKeyFromEvidence(evidence({ blockIndex: 2 }))).not.toBe(
      frameKeyFromEvidence(evidence({ blockIndex: 3 })),
    );
  });

  it("separates block index zero in two provider messages", () => {
    expect(
      frameKeyFromEvidence(evidence({ providerMessageId: "msg_1", blockIndex: 0 })),
    ).not.toBe(
      frameKeyFromEvidence(evidence({ providerMessageId: "msg_2", blockIndex: 0 })),
    );
  });

  it("distinguishes a missing field from an empty one", () => {
    expect(canonicalizeFrameEvidence(evidence({ toolCallId: null }))).not.toBe(
      canonicalizeFrameEvidence(evidence({ toolCallId: "toolu_1" })),
    );
  });

  it("normalizes key order and drops undefined members", () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
    expect(canonicalJson({ a: 1, b: undefined })).toBe(canonicalJson({ a: 1 }));
  });

  it("keeps fingerprints stable across construction order and clock", () => {
    const forward = fingerprintFacts(FACTS);
    const reordered = fingerprintFacts(
      FACTS.map((fact) => Object.fromEntries(Object.entries(fact).reverse()) as AssistantStreamEvent),
    );
    expect(reordered).toBe(forward);
    expect(forward).toHaveLength(CAPTURE_FINGERPRINT_LENGTH);
  });

  it("fingerprints raw argument bytes rather than parsed values", () => {
    // Two JSON texts that parse identically must stay distinguishable, because
    // a redelivery check runs before any parse.
    expect(captureDigest('{"a":1,"b":2}')).not.toBe(captureDigest('{"b":2,"a":1}'));
  });
});

describe("capture batch shape", () => {
  it("refuses a batch with no frame key, the one thing that is a failure", () => {
    expect(() =>
      createCaptureBatch({ leaseId: "turn-1#1", frameKey: "  ", facts: [] }),
    ).toThrow(/frame key/);
  });

  it("accepts a frame far larger than any provider has been observed to send", () => {
    // RFC-0010: a guard whose trigger is "you have done N things" names no
    // failure. A big frame must capture, not fail the turn.
    const facts = Array.from(
      { length: 5000 },
      (_value, index): AssistantStreamEvent => ({
        type: "prose_delta",
        segmentId: "s1",
        delta: `chunk-${index}`,
      }),
    );
    const supersedes = Array.from(
      { length: 2000 },
      (_value, index) => `turn-1#1:frame-${index}`,
    );
    const batch = createCaptureBatch({
      leaseId: "turn-1#1",
      frameKey: "frame-a",
      facts,
      supersedes,
    });
    expect(batch.facts).toHaveLength(5000);
    expect(batch.supersedes).toHaveLength(2000);
  });
});

describe("capture conflict", () => {
  it("carries bounded identity evidence and no payload", () => {
    const error = new CaptureConflictError(
      "cross_batch",
      "Tool-call ID is bound to an earlier structured position.",
      {
        batchId: "turn-1#1:frame-b",
        conflictingBatchId: "turn-1#1:frame-a",
        toolCallId: "toolu_1",
      },
    );
    expect(error.name).toBe("CaptureConflictError");
    expect(error.kind).toBe("cross_batch");
    expect(error.conflictingBatchId).toBe("turn-1#1:frame-a");
    expect(Object.keys(error)).not.toContain("facts");
  });
});

describe("settlement helpers", () => {
  it("resolves exactly once and reports which call won", async () => {
    const gate = createSettleOnce<string>("fallback");
    expect(gate.settle("first")).toBe(true);
    expect(gate.settle("second")).toBe(false);
    expect(gate.isSettled).toBe(true);
    await expect(gate.promise).resolves.toBe("first");
  });

  it("falls back for every metadata promise on a failure path", async () => {
    const gate = createStreamMetadataGate();
    gate.settleRemaining();
    await expect(
      Promise.all([
        gate.usage.promise,
        gate.stopReason.promise,
        gate.replayCapsule.promise,
        gate.replayEvidence.promise,
      ]),
    ).resolves.toEqual([
      null,
      "unknown",
      null,
      expect.objectContaining({ tier: "textual" }),
    ]);
  });

  it("keeps a value a provider already supplied", async () => {
    const gate = createStreamMetadataGate();
    gate.stopReason.settle("end_turn");
    gate.settleRemaining();
    await expect(gate.stopReason.promise).resolves.toBe("end_turn");
  });

  it("turns an iterator-return failure into a diagnostic, not a throw", async () => {
    const diagnostics: unknown[] = [];
    await closeIterator(
      {
        return: () => {
          throw new Error("transport already gone");
        },
      },
      (diagnostic) => diagnostics.push(diagnostic),
    );
    expect(diagnostics).toEqual([
      expect.objectContaining({ code: "iterator_return_failed", stage: "settlement" }),
    ]);
  });

  it("tolerates an iterator with no return method", async () => {
    await expect(closeIterator({})).resolves.toBeUndefined();
    await expect(closeIterator(null)).resolves.toBeUndefined();
  });
});
