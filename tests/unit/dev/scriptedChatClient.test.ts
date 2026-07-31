import { describe, expect, it } from "vitest";
import type { AssistantCaptureBatch } from "../../../src/api/assistantCapture";
import { createCaptureBatch } from "../../../src/api/assistantCapture";
import { createStreamMetadataGate } from "../../../src/api/assistantStreamRun";
import {
  createOwnedStreamRun,
  detachedAttemptContext,
} from "../../../src/api/assistantStreamRuntime";
// @ts-expect-error the driver is plain ESM outside the typechecked source tree (plan D6).
import { makeScriptedChatClient } from "../../../dev/driver/lib/scriptedProvider.mjs";
// @ts-expect-error same.
import { validateDriverScript } from "../../../dev/driver/lib/script.mjs";

/**
 * The live driver's determinism rests on this client emitting the script's facts, in the
 * script's frames, through the production ownership runtime (RFC-0013 plan section 3.3). What
 * makes that worth asserting is the alternative: a hand-rolled fake would have to reimplement
 * ADR-0031 batch identity and ADR-0032 settlement, and would then be evidence about itself.
 *
 * The client now lives in `dev/`, because the driver no longer keeps anything inside the
 * plugin's source, and it is handed the ownership runtime instead of importing it. That makes
 * this test *stronger* rather than weaker: the injection point is explicit, so the test hands it
 * the same three production functions the renderer's bundle hands it, and therefore covers the
 * exact function the epilogue ships.
 */

const INTERNALS = { createOwnedStreamRun, createCaptureBatch, createStreamMetadataGate };

function clientFor(frames: unknown[]) {
  return makeScriptedChatClient(
    INTERNALS,
    validateDriverScript({ frames }, "test-script"),
    "anthropic",
  );
}

async function drain(client: ReturnType<typeof clientFor>, leaseLabel = "turn-1") {
  const attempt = detachedAttemptContext(leaseLabel);
  const run = client.stream({ messages: [] }, "fixture-model", {}, attempt);
  const batches: AssistantCaptureBatch[] = [];
  for await (const batch of run.events) batches.push(batch);
  return { batches, run };
}

const END = { type: "turn_end", status: "completed" };

/** One round of prose, terminated, which is the smallest script the validator accepts. */
function proseRound(prefix: string, delta: string) {
  return [
    { frameKey: `${prefix}-open`, delayMs: 0, facts: [{ type: "segment_start", segmentId: prefix }] },
    {
      frameKey: `${prefix}-delta`,
      delayMs: 0,
      facts: [{ type: "prose_delta", segmentId: prefix, delta }],
    },
    {
      frameKey: `${prefix}-close`,
      delayMs: 0,
      facts: [{ type: "segment_end", segmentId: prefix }, END],
    },
  ];
}

/** One round that declares a tool call, which is what makes a second round happen at all. */
function toolRound(prefix: string) {
  return [
    { frameKey: `${prefix}-open`, delayMs: 0, facts: [{ type: "segment_start", segmentId: prefix }] },
    {
      frameKey: `${prefix}-declare`,
      delayMs: 0,
      facts: [
        {
          type: "tool_call_start",
          segmentId: prefix,
          declarationKey: `${prefix}-d1`,
          toolName: "read_file",
        },
      ],
    },
    {
      frameKey: `${prefix}-identity`,
      delayMs: 0,
      facts: [
        {
          type: "tool_call_identity",
          declarationKey: `${prefix}-d1`,
          toolCallId: `${prefix}-call`,
          correlation: "provider_id",
        },
      ],
    },
    {
      frameKey: `${prefix}-close`,
      delayMs: 0,
      facts: [{ type: "segment_end", segmentId: prefix }, END],
    },
  ];
}

describe("the scripted chat client", () => {
  it("yields one capture batch per authored frame, carrying that frame's facts in order", async () => {
    const client = clientFor(proseRound("s1", "Once "));

    const { batches, run } = await drain(client);

    expect(batches.map((batch) => batch.frameKey)).toStrictEqual([
      "s1-open",
      "s1-delta",
      "s1-close",
    ]);
    expect(batches.flatMap((batch) => batch.facts.map((fact) => fact.type))).toStrictEqual([
      "segment_start",
      "prose_delta",
      "segment_end",
      "turn_end",
    ]);
    expect(await run.stopReason).toBe("end_turn");
  });

  it("seals batches under the attempt's lease, so identity is attempt-scoped", async () => {
    const first = await drain(clientFor(proseRound("s1", "Once ")), "turn-a");
    const second = await drain(clientFor(proseRound("s1", "Once ")), "turn-b");

    expect(first.batches[0].batchId).toBe("turn-a#1:s1-open");
    expect(second.batches[0].batchId).toBe("turn-b#1:s1-open");
    // Authored keys stand in for wire identity, so a repeated key reads as redelivery.
    expect(first.batches[0].frameKeySource).toBe("provider");
  });

  it("settles as a proven stop when the run is cancelled mid-script", async () => {
    const client = clientFor([
      { frameKey: "f-open", delayMs: 0, facts: [{ type: "segment_start", segmentId: "s1" }] },
      {
        frameKey: "f-delta",
        delayMs: 5_000,
        facts: [{ type: "prose_delta", segmentId: "s1", delta: "never arrives" }],
      },
      { frameKey: "f-close", delayMs: 0, facts: [END] },
    ]);

    const attempt = detachedAttemptContext("turn-cancel");
    const run = client.stream({ messages: [] }, "fixture-model", {}, attempt);
    const seen: string[] = [];
    for await (const batch of run.events) {
      seen.push(batch.frameKey);
      break;
    }

    const settlement = await run.settled;
    expect(seen).toStrictEqual(["f-open"]);
    expect(settlement.quiescence).toBe("proven");
    expect(settlement.reason).toBe("consumer_returned");
  });

  it("settles its own replay evidence, so a transcript cannot claim the attempt failed", async () => {
    const client = clientFor([{ frameKey: "f-only", delayMs: 0, facts: [END] }]);

    const { run } = await drain(client);
    const evidence = await run.replayEvidence;

    // The gate's fallback is `failedAttemptEvidence()`, whose lowered reason is
    // "stream_attempt_failed_before_commit". An attempt that ran to its last frame did not fail,
    // and both runs of the Stage 0 gate lied identically about this, so no comparison could
    // catch it. Only this assertion can.
    expect(evidence?.loweredReason).toBe("scripted_driver_provider");
  });
});

/**
 * One `stream()` call is one provider response, and the agentic loop makes one per round. A
 * client that replayed its whole script on every call would drive a tool-bearing scenario in a
 * circle until the round cap, so the round cursor is what makes Stage 2's scenarios possible at
 * all, and it is the piece most able to fail quietly.
 */
describe("the scripted chat client across rounds", () => {
  it("plays one round per stream call, in order", async () => {
    const client = clientFor([...toolRound("r1"), ...proseRound("r2", "After the tool. ")]);

    const first = await drain(client, "turn-1");
    const second = await drain(client, "turn-2");

    expect(first.batches.map((batch) => batch.frameKey)).toStrictEqual([
      "r1-open",
      "r1-declare",
      "r1-identity",
      "r1-close",
    ]);
    expect(second.batches.map((batch) => batch.frameKey)).toStrictEqual([
      "r2-open",
      "r2-delta",
      "r2-close",
    ]);
  });

  it("reports the stop reason and the tool correlation each round actually earned", async () => {
    const client = clientFor([...toolRound("r1"), ...proseRound("r2", "After the tool. ")]);

    const first = await drain(client, "turn-1");
    const second = await drain(client, "turn-2");

    expect(await first.run.stopReason).toBe("tool_use");
    expect((await first.run.replayEvidence)?.capabilities.toolCorrelation).toBe("provider_id");
    // The prose round earned neither, and claiming a correlation it has no identity fact for
    // would be the transcript saying something about the run the script did not.
    expect(await second.run.stopReason).toBe("end_turn");
    expect((await second.run.replayEvidence)?.capabilities.toolCorrelation).toBe("none");
  });

  it("replays a round that was abandoned part-way, rather than consuming it", async () => {
    // What this protects: `streamWithRetry` re-invokes the factory when an attempt fails, and the
    // attempt may already have opened. A cursor that advanced per call, rather than per round
    // actually played to its last frame, would skip the round the retry is for.
    const client = clientFor([...proseRound("r1", "First. "), ...proseRound("r2", "Second. ")]);

    const abandoned = client.stream(
      { messages: [] },
      "fixture-model",
      {},
      detachedAttemptContext("turn-0"),
    );
    for await (const _batch of abandoned.events) break;
    await abandoned.settled;

    const next = await drain(client, "turn-1");
    expect(next.batches.map((batch) => batch.frameKey)).toStrictEqual([
      "r1-open",
      "r1-delta",
      "r1-close",
    ]);
  });

  it("fails naming the script when the app asks for a round it does not have", async () => {
    // The alternative is replaying round one forever, which spins the agentic loop to its cap
    // and produces a transcript nobody authored.
    const client = clientFor(toolRound("r1"));

    await drain(client, "turn-1");
    await expect(drain(client, "turn-2")).rejects.toThrow(
      /opened round 2 of the script "test-script", which has 1/,
    );
  });
});

describe("validateDriverScript", () => {
  it("rejects a fact type the plugin has no reducer for", () => {
    expect(() =>
      validateDriverScript(
        { frames: [{ frameKey: "f", facts: [{ type: "prose_deltas", segmentId: "s" }] }] },
        "bad-script",
      ),
    ).toThrow(/unknown fact type "prose_deltas"/);
  });

  it("rejects an unknown frame key rather than ignoring it", () => {
    expect(() =>
      validateDriverScript(
        { frames: [{ frameKey: "f", pause: 10, facts: [END] }] },
        "bad-script",
      ),
    ).toThrow(/unknown key "pause"/);
  });

  it("ignores a root _comment, the one note JSON can carry beside its frames", () => {
    const script = validateDriverScript(
      { _comment: ["why this script is paced the way it is"], frames: proseRound("r1", "x") },
      "noted-script",
    );
    expect(script.rounds).toHaveLength(1);
    expect(script).not.toHaveProperty("_comment");
  });

  it("splits frames into rounds at turn_end", () => {
    const script = validateDriverScript(
      { frames: [...toolRound("r1"), ...proseRound("r2", "After. ")] },
      "two-round-script",
    );

    expect(script.rounds.map((round: { frameKey: string }[]) => round.length)).toStrictEqual([4, 3]);
    expect(script.rounds[1][0].frameKey).toBe("r2-open");
  });

  it("rejects frames left over after the last turn_end, which would never be streamed", () => {
    expect(() =>
      validateDriverScript(
        {
          frames: [
            ...proseRound("r1", "First. "),
            { frameKey: "orphan", facts: [{ type: "prose_delta", segmentId: "r1", delta: "x" }] },
          ],
        },
        "bad-script",
      ),
    ).toThrow(/carry no turn_end fact/);
  });

  it("rejects turn_end anywhere but last in its frame, so a round boundary is unambiguous", () => {
    expect(() =>
      validateDriverScript(
        {
          frames: [
            { frameKey: "f", facts: [END, { type: "segment_end", segmentId: "s1" }] },
          ],
        },
        "bad-script",
      ),
    ).toThrow(/must be the last fact of its frame/);
  });

  it("rejects a correlation the scripted client would silently read as none", () => {
    expect(() =>
      validateDriverScript(
        {
          frames: [
            {
              frameKey: "f",
              facts: [
                {
                  type: "tool_call_identity",
                  declarationKey: "d1",
                  toolCallId: "c1",
                  correlation: "provider",
                },
                END,
              ],
            },
          ],
        },
        "bad-script",
      ),
    ).toThrow(/correlation must be one of/);
  });
});
