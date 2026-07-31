import { describe, expect, it } from "vitest";
import type { AssistantCaptureBatch } from "../../../src/api/assistantCapture";
import { detachedAttemptContext } from "../../../src/api/assistantStreamRuntime";
import type { ChatRequest } from "../../../src/shared/chatRequest";
import { ScriptedChatClient } from "../../../src/dev/scriptedChatClient";
import { validateDriverScript } from "../../../src/dev/driverScript";

/**
 * The live driver's determinism rests on this client emitting the script's facts, in the
 * script's frames, through the production ownership runtime (RFC-0013 plan section 3.3). What
 * makes that worth asserting is the alternative: a hand-rolled fake would have to reimplement
 * ADR-0031 batch identity and ADR-0032 settlement, and would then be evidence about itself.
 */

const request = { messages: [] } as unknown as ChatRequest;

function scriptOf(frames: unknown[]) {
  return validateDriverScript({ frames }, "test-script");
}

/** The provider the factory was asked for, carried onto settlement diagnostics. */
function clientFor(frames: unknown[]) {
  return new ScriptedChatClient(scriptOf(frames), "anthropic");
}

async function drain(client: ScriptedChatClient, leaseLabel = "turn-1") {
  const attempt = detachedAttemptContext(leaseLabel);
  const run = client.stream(request, "fixture-model", {}, attempt);
  const batches: AssistantCaptureBatch[] = [];
  for await (const batch of run.events) batches.push(batch);
  return { batches, run };
}

describe("ScriptedChatClient", () => {
  it("yields one capture batch per authored frame, carrying that frame's facts in order", async () => {
    const client = clientFor([
      {
        frameKey: "f-open",
        delayMs: 0,
        facts: [{ type: "segment_start", segmentId: "s1" }],
      },
      {
        frameKey: "f-delta",
        delayMs: 0,
        facts: [{ type: "prose_delta", segmentId: "s1", delta: "Once " }],
      },
      {
        frameKey: "f-close",
        delayMs: 0,
        facts: [
          { type: "segment_end", segmentId: "s1" },
          { type: "turn_end", status: "completed" },
        ],
      },
    ]);

    const { batches, run } = await drain(client);

    expect(batches.map((batch) => batch.frameKey)).toStrictEqual([
      "f-open",
      "f-delta",
      "f-close",
    ]);
    expect(
      batches.flatMap((batch) => batch.facts.map((fact) => fact.type)),
    ).toStrictEqual([
      "segment_start",
      "prose_delta",
      "segment_end",
      "turn_end",
    ]);
    expect(await run.stopReason).toBe("end_turn");
  });

  it("seals batches under the attempt's lease, so identity is attempt-scoped", async () => {
    const client = clientFor([
      {
        frameKey: "f-open",
        delayMs: 0,
        facts: [{ type: "segment_start", segmentId: "s1" }],
      },
    ]);

    const first = await drain(client, "turn-a");
    const second = await drain(client, "turn-b");

    expect(first.batches[0].batchId).toBe("turn-a#1:f-open");
    expect(second.batches[0].batchId).toBe("turn-b#1:f-open");
    // Authored keys stand in for wire identity, so a repeated key reads as redelivery.
    expect(first.batches[0].frameKeySource).toBe("provider");
  });

  it("settles as a proven stop when the run is cancelled mid-script", async () => {
    const client = clientFor([
      {
        frameKey: "f-open",
        delayMs: 0,
        facts: [{ type: "segment_start", segmentId: "s1" }],
      },
      {
        frameKey: "f-delta",
        delayMs: 5_000,
        facts: [
          { type: "prose_delta", segmentId: "s1", delta: "never arrives" },
        ],
      },
    ]);

    const attempt = detachedAttemptContext("turn-cancel");
    const run = client.stream(request, "fixture-model", {}, attempt);
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
});

describe("validateDriverScript", () => {
  it("rejects a fact type the plugin has no reducer for", () => {
    expect(() =>
      validateDriverScript(
        {
          frames: [
            {
              frameKey: "f",
              facts: [{ type: "prose_deltas", segmentId: "s" }],
            },
          ],
        },
        "bad-script",
      ),
    ).toThrow(/unknown fact type "prose_deltas"/);
  });

  it("rejects an unknown frame key rather than ignoring it", () => {
    expect(() =>
      validateDriverScript(
        {
          frames: [
            {
              frameKey: "f",
              pause: 10,
              facts: [{ type: "turn_end", status: "completed" }],
            },
          ],
        },
        "bad-script",
      ),
    ).toThrow(/unknown key "pause"/);
  });
});
