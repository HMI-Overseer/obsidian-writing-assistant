import { describe, expect, it } from "vitest";
// @ts-expect-error the driver is plain ESM outside the typechecked source tree (RFC-0013 plan D6).
import {
  canonicalTranscript,
  canonicalTranscriptJson,
} from "../../../dev/driver/lib/canonical.mjs";

/**
 * The Stage 0 gate rests entirely on this function, and it is the one place in the driver where
 * a bug produces false confidence instead of a visible failure: a canonicalizer that strips too
 * much makes two different runs compare equal and turns the gate green by deleting the evidence.
 *
 * So both directions are asserted. Runs that differ only in generated identity must compare
 * equal, and runs that differ in anything a scenario claims must not.
 */

function turnMessage(options: {
  messageId: string;
  revisionId: string;
  createdAt: number;
  segmentId: string;
  itemId: string;
  toolCallId: string;
  /**
   * Deliberately separate from the item text, so a case that varies only the turn item cannot
   * pass through the flat `content` projection instead of the structure under test.
   */
  content: string;
  prose: string;
  toolArguments: string;
}) {
  return {
    id: options.messageId,
    role: "assistant",
    content: options.content,
    activeRevisionId: options.revisionId,
    revisions: [
      {
        kind: "turn",
        revisionId: options.revisionId,
        origin: "generated",
        createdAt: options.createdAt,
        provider: "lmstudio",
        modelId: "fixture-model",
        usage: { inputTokens: options.createdAt % 97, outputTokens: 12 },
        turn: {
          schemaVersion: 2,
          id: `turn-${options.messageId}`,
          status: "completed",
          quiescence: "proven",
          segments: [{ id: options.segmentId, providerMessageId: `pm-${options.segmentId}` }],
          items: [
            {
              type: "prose",
              id: options.itemId,
              segmentId: options.segmentId,
              text: options.prose,
              captureEvidence: {
                originBatchId: `lease#1:${options.itemId}`,
                placement: { kind: "exact", providerMessageKey: "sess:msg", providerBlockId: "0" },
                validity: "valid",
              },
            },
            {
              type: "tool_call",
              id: `${options.itemId}-tool`,
              segmentId: options.segmentId,
              toolCallId: options.toolCallId,
              toolName: "read_file",
              toolArguments: options.toolArguments,
              state: "completed",
            },
          ],
        },
      },
    ],
  };
}

const baseline = [
  { id: "user-a1", role: "user", content: "Rewrite the opening." },
  turnMessage({
    messageId: "msg-a1",
    revisionId: "rev-a1",
    createdAt: 1_770_000_000_000,
    segmentId: "seg-a1",
    itemId: "item-a1",
    toolCallId: "call-a1",
    content: "Here is a tighter opening.",
    prose: "Here is a tighter opening.",
    toolArguments: '{"path":"Chapters/One.md"}',
  }),
];

/** The same walk, run again: every generated id and every clock reading differs. */
const secondRun = [
  { id: "user-b9", role: "user", content: "Rewrite the opening." },
  turnMessage({
    messageId: "msg-b9",
    revisionId: "rev-b9",
    createdAt: 1_770_000_931_477,
    segmentId: "seg-b9",
    itemId: "item-b9",
    toolCallId: "call-b9",
    content: "Here is a tighter opening.",
    prose: "Here is a tighter opening.",
    toolArguments: '{"path":"Chapters/One.md"}',
  }),
];

describe("canonicalTranscript", () => {
  it("compares two runs that differ only in generated identity as equal", () => {
    expect(canonicalTranscriptJson(secondRun)).toBe(canonicalTranscriptJson(baseline));
  });

  it("compares two runs that differ in a tool argument as unequal", () => {
    const differentArgument = [
      secondRun[0],
      turnMessage({
        messageId: "msg-b9",
        revisionId: "rev-b9",
        createdAt: 1_770_000_931_477,
        segmentId: "seg-b9",
        itemId: "item-b9",
        toolCallId: "call-b9",
        content: "Here is a tighter opening.",
        prose: "Here is a tighter opening.",
        toolArguments: '{"path":"Chapters/Two.md"}',
      }),
    ];

    expect(canonicalTranscriptJson(differentArgument)).not.toBe(
      canonicalTranscriptJson(baseline),
    );
  });

  it("compares two runs that differ in prose as unequal", () => {
    const differentProse = [
      secondRun[0],
      turnMessage({
        messageId: "msg-b9",
        revisionId: "rev-b9",
        createdAt: 1_770_000_931_477,
        segmentId: "seg-b9",
        itemId: "item-b9",
        toolCallId: "call-b9",
        // Same flat projection, different turn item: the difference lives only in the structure.
        content: "Here is a tighter opening.",
        prose: "Here is a looser opening.",
        toolArguments: '{"path":"Chapters/One.md"}',
      }),
    ];

    expect(canonicalTranscriptJson(differentProse)).not.toBe(canonicalTranscriptJson(baseline));
  });

  it("keeps the evidence a scenario claims, not just the shape", () => {
    const [, assistant] = canonicalTranscript(baseline) as Array<Record<string, unknown>>;
    const revision = (assistant.revisions as Array<Record<string, unknown>>)[0];
    const turn = revision.turn as Record<string, unknown>;
    const items = turn.items as Array<Record<string, unknown>>;

    expect(assistant.role).toBe("assistant");
    expect(turn.status).toBe("completed");
    expect(turn.quiescence).toBe("proven");
    expect(items.map((item) => item.type)).toStrictEqual(["prose", "tool_call"]);
    expect(items[0].text).toBe("Here is a tighter opening.");
    expect(items[1].toolName).toBe("read_file");
    expect(items[1].toolArguments).toBe('{"path":"Chapters/One.md"}');
    expect(items[1].state).toBe("completed");
    expect(
      ((items[0].captureEvidence as Record<string, unknown>).placement as Record<string, unknown>)
        .kind,
    ).toBe("exact");
  });

  it("drops the generated identity and per-run accounting the gate must ignore", () => {
    const text = canonicalTranscriptJson(baseline);

    expect(text).not.toContain("msg-a1");
    expect(text).not.toContain("rev-a1");
    expect(text).not.toContain("seg-a1");
    expect(text).not.toContain("call-a1");
    expect(text).not.toContain("1770000000000");
    expect(text).not.toContain("inputTokens");
  });
});
