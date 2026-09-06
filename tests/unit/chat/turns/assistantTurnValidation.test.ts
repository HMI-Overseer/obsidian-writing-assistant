import { describe, expect, it } from "vitest";
import anthropicFixture from "../../../fixtures/assistant-turns/anthropic-interleaved-blocks.json";
import type {
  AssistantTurnRecord,
  ProviderReplayCapsule,
} from "../../../../src/shared/types";
import {
  ASSISTANT_TURN_MAX_RESULT_RECORD_CHARS,
  ASSISTANT_TURN_MAX_REPLAY_CAPSULE_CHARS,
  validateAssistantTurn,
  validateProviderReplayCapsule,
} from "../../../../src/chat/turns/assistantTurnValidation";

function capsule(): ProviderReplayCapsule {
  const signature = "sig_fixture_anthropic_1";
  expect(JSON.stringify(anthropicFixture)).toContain(signature);
  return {
    provider: "anthropic",
    version: 1,
    thinkingBlocks: [
      {
        type: "thinking",
        thinking: "Inspect the synthetic note first.",
        signature,
      },
      {
        type: "redacted_thinking",
        data: "redacted_fixture_data",
      },
    ],
  };
}

function validTurn(): AssistantTurnRecord {
  return {
    schemaVersion: 1,
    id: "turn-valid",
    status: "completed",
    segments: [
      {
        id: "segment-1",
        providerMessageId: "message-1",
        replayCapsule: capsule(),
      },
      { id: "segment-2" },
    ],
    items: [
      {
        type: "prose",
        id: "item-prose",
        segmentId: "segment-1",
        sourceItemId: "source-prose",
        text: "Visible prose.",
        actionRef: "action-parsed-edit",
        actionAnchor: "parsed_edit",
      },
      {
        type: "tool_call",
        id: "item-tool",
        segmentId: "segment-1",
        sourceItemId: "source-tool",
        toolCallId: "call-1",
        toolName: "read",
        toolArguments: "{\"path\":\"Fixtures/a.md\"}",
        toolArgs: { path: "Fixtures/a.md" },
        toolInput: "Fixtures/a.md",
        state: "completed",
        resultRecord: "Synthetic result.",
        resultDigest: "[read: Fixtures/a.md]",
        isError: false,
        actionRef: "action-tool",
        round: 1,
      },
      {
        type: "prose",
        id: "item-prose-2",
        segmentId: "segment-2",
        text: "Final prose.",
      },
    ],
  };
}

function mutableTurn(): Record<string, unknown> {
  return structuredClone(validTurn()) as unknown as Record<string, unknown>;
}

function reasonCode(value: unknown): string {
  const result = validateAssistantTurn(value);
  if (result.ok) throw new Error("Expected assistant-turn validation to fail.");
  return result.reason.code;
}

describe("validateAssistantTurn", () => {
  it("accepts a complete schema-1 ordered turn without changing it", () => {
    const turn = validTurn();
    const before = structuredClone(turn);
    const result = validateAssistantTurn(turn);

    expect(result).toEqual({ ok: true, value: turn });
    expect(turn).toEqual(before);
  });

  it("accepts tool-only, empty, failed, interrupted, and silent-segment records", () => {
    const toolOnly = validTurn();
    toolOnly.status = "interrupted";
    toolOnly.items = [
      {
        type: "tool_call",
        id: "item-only",
        segmentId: "segment-2",
        toolCallId: "call-only",
        toolName: "read",
        toolArguments: "",
        state: "interrupted",
      },
    ];
    expect(validateAssistantTurn(toolOnly).ok).toBe(true);

    for (const status of ["completed", "failed", "interrupted"] as const) {
      const empty: AssistantTurnRecord = {
        schemaVersion: 1,
        id: `turn-${status}`,
        status,
        segments: [{ id: "silent-1" }, { id: "silent-2" }],
        items: [],
      };
      expect(validateAssistantTurn(empty).ok).toBe(true);
    }
  });

  it("rejects non-records, unsupported schema versions, and invalid statuses by name", () => {
    expect(reasonCode(null)).toBe("record_invalid");

    // Version 2 is accepted since RFC-0011; version 3 does not exist.
    const schema = mutableTurn();
    schema.schemaVersion = 3;
    expect(reasonCode(schema)).toBe("schema_version_unsupported");

    const status = mutableTurn();
    status.status = "done";
    expect(reasonCode(status)).toBe("status_invalid");
  });

  it("rejects empty, duplicate, and cross-kind domain IDs", () => {
    const emptyTurnId = mutableTurn();
    emptyTurnId.id = "";
    expect(reasonCode(emptyTurnId)).toBe("id_invalid");

    const duplicateSegments = validTurn();
    duplicateSegments.segments[1].id = "segment-1";
    expect(reasonCode(duplicateSegments)).toBe("id_duplicate");

    const duplicateItems = validTurn();
    duplicateItems.items[2].id = "item-prose";
    expect(reasonCode(duplicateItems)).toBe("id_duplicate");

    const crossKind = validTurn();
    crossKind.items[0].id = "segment-1";
    expect(reasonCode(crossKind)).toBe("id_duplicate");

    const duplicateCalls = validTurn();
    duplicateCalls.items.push({
      type: "tool_call",
      id: "item-tool-2",
      segmentId: "segment-2",
      toolCallId: "call-1",
      toolName: "read",
      toolArguments: "",
      state: "completed",
    });
    expect(reasonCode(duplicateCalls)).toBe("tool_call_id_duplicate");
  });

  it("rejects missing segment membership and segment order that moves backward", () => {
    const missing = validTurn();
    missing.items[0].segmentId = "missing";
    expect(reasonCode(missing)).toBe("segment_membership_invalid");

    const backwards = validTurn();
    backwards.items.push({
      type: "prose",
      id: "item-backwards",
      segmentId: "segment-1",
      text: "Out of order.",
    });
    expect(reasonCode(backwards)).toBe("segment_order_invalid");
  });

  it("rejects unknown item discriminants and empty prose", () => {
    const discriminant = mutableTurn();
    const items = discriminant.items as Array<Record<string, unknown>>;
    items[0].type = "reasoning";
    expect(reasonCode(discriminant)).toBe("item_type_invalid");

    const empty = validTurn();
    const prose = empty.items[0];
    if (prose.type !== "prose") throw new Error("Fixture shape changed.");
    prose.text = "";
    expect(reasonCode(empty)).toBe("prose_empty");
  });

  it("enforces parsed-edit action anchoring on prose and non-empty tool action references", () => {
    const missingAnchor = validTurn();
    const prose = missingAnchor.items[0];
    if (prose.type !== "prose") throw new Error("Fixture shape changed.");
    delete prose.actionAnchor;
    expect(reasonCode(missingAnchor)).toBe("prose_action_invalid");

    const missingReference = mutableTurn();
    const rawProse = (missingReference.items as Array<Record<string, unknown>>)[0];
    delete rawProse.actionRef;
    expect(reasonCode(missingReference)).toBe("prose_action_invalid");

    const wrongAnchor = mutableTurn();
    const wrongProse = (wrongAnchor.items as Array<Record<string, unknown>>)[0];
    wrongProse.actionAnchor = "tool_call";
    expect(reasonCode(wrongAnchor)).toBe("prose_action_invalid");

    const emptyToolReference = validTurn();
    const tool = emptyToolReference.items[1];
    if (tool.type !== "tool_call") throw new Error("Fixture shape changed.");
    tool.actionRef = "";
    expect(reasonCode(emptyToolReference)).toBe("action_ref_invalid");
  });

  it("requires non-empty final tool identity, name, and an allowed lifecycle state", () => {
    const emptyCall = validTurn();
    const callItem = emptyCall.items[1];
    if (callItem.type !== "tool_call") throw new Error("Fixture shape changed.");
    callItem.toolCallId = "";
    expect(reasonCode(emptyCall)).toBe("tool_call_id_invalid");

    const emptyName = validTurn();
    const nameItem = emptyName.items[1];
    if (nameItem.type !== "tool_call") throw new Error("Fixture shape changed.");
    nameItem.toolName = " ";
    expect(reasonCode(emptyName)).toBe("tool_name_invalid");

    const badState = mutableTurn();
    const stateItem = (badState.items as Array<Record<string, unknown>>)[1];
    stateItem.state = "pending";
    expect(reasonCode(badState)).toBe("tool_state_invalid");
  });

  it("accepts malformed argument text only when no parsed toolArgs claim is present", () => {
    const diagnostic = validTurn();
    const tool = diagnostic.items[1];
    if (tool.type !== "tool_call") throw new Error("Fixture shape changed.");
    tool.toolArguments = "{\"path\":";
    delete tool.toolArgs;
    expect(validateAssistantTurn(diagnostic).ok).toBe(true);

    const falseClaim = validTurn();
    const falseClaimTool = falseClaim.items[1];
    if (falseClaimTool.type !== "tool_call") throw new Error("Fixture shape changed.");
    falseClaimTool.toolArguments = "{\"path\":";
    expect(reasonCode(falseClaim)).toBe("tool_args_invalid");

    const mismatch = validTurn();
    const mismatchTool = mismatch.items[1];
    if (mismatchTool.type !== "tool_call") throw new Error("Fixture shape changed.");
    mismatchTool.toolArgs = { path: "Fixtures/b.md" };
    expect(reasonCode(mismatch)).toBe("tool_args_mismatch");
  });

  it("refuses a declaration by shape, never by size", () => {
    // A note write carries the whole note in its arguments. The provider's own
    // output limit is the only bound on that text; the record has none (ADR-0040).
    const large = validTurn();
    const largeItem = large.items[1];
    if (largeItem.type !== "tool_call") throw new Error("Fixture shape changed.");
    const content = "x".repeat(200_000);
    largeItem.toolArguments = JSON.stringify({ path: "Fixtures/a.md", content });
    largeItem.toolArgs = { path: "Fixtures/a.md", content };
    largeItem.toolInput = "y".repeat(20_000);
    expect(validateAssistantTurn(large).ok).toBe(true);

    const notText = validTurn();
    const notTextItem = notText.items[1];
    if (notTextItem.type !== "tool_call") throw new Error("Fixture shape changed.");
    (notTextItem as Record<string, unknown>).toolInput = 42;
    expect(reasonCode(notText)).toBe("tool_input_invalid");
  });

  it("enforces the result record's capture-time bound", () => {
    const resultAtBound = validTurn();
    const atBoundItem = resultAtBound.items[1];
    if (atBoundItem.type !== "tool_call") throw new Error("Fixture shape changed.");
    atBoundItem.resultRecord = "x".repeat(ASSISTANT_TURN_MAX_RESULT_RECORD_CHARS);
    expect(validateAssistantTurn(resultAtBound).ok).toBe(true);

    atBoundItem.resultRecord += "x";
    expect(reasonCode(resultAtBound)).toBe("result_record_too_long");
  });

  it("validates ask guidance and its lifecycle relationship", () => {
    const valid = validTurn();
    const tool = valid.items[1];
    if (tool.type !== "tool_call") throw new Error("Fixture shape changed.");
    tool.askStatus = "completed";
    tool.askGuidance = {
      questions: [
        {
          question: "Continue?",
          header: "Decision",
          answer: ["First", "Second"],
        },
      ],
    };
    expect(validateAssistantTurn(valid).ok).toBe(true);

    tool.askStatus = "cancelled";
    expect(reasonCode(valid)).toBe("ask_guidance_invalid");
  });

  it("rejects unexpected persisted fields instead of retaining raw provider data", () => {
    const turn = mutableTurn();
    turn.rawProviderEvents = [{ secret: "not allowed" }];
    expect(reasonCode(turn)).toBe("field_unexpected");
  });

  // Tool-result image metadata (RFC-0021 D6, ADR-0041). A field the allowlist does not
  // know is rejected outright, so an unregistered `resultImages` would make every
  // conversation holding an image read fail validation on reload. That is the exact
  // failure these cases exist to have already happened once, in a test.
  describe("tool-result image metadata", () => {
    /** The turn's tool item, with a well-formed image list. */
    function withImages(images: unknown): Record<string, unknown> {
      const turn = mutableTurn();
      const items = turn.items as Record<string, unknown>[];
      const tool = items.find((item) => item.type === "tool_call");
      if (!tool) throw new Error("fixture has no tool item");
      tool.resultImages = images;
      return turn;
    }

    const ONE_IMAGE = [
      {
        path: "Art/map.png",
        mimeType: "image/png",
        byteLength: 245760,
        width: 1024,
        height: 768,
      },
    ];

    it("accepts a well-formed list, with and without dimensions", () => {
      expect(validateAssistantTurn(withImages(ONE_IMAGE)).ok).toBe(true);
      expect(
        validateAssistantTurn(
          withImages([{ path: "Art/map.gif", mimeType: "image/gif", byteLength: 0 }]),
        ).ok,
      ).toBe(true);
      expect(
        validateAssistantTurn(
          withImages([
            ONE_IMAGE[0],
            { path: "Art/tree.webp", mimeType: "image/webp", byteLength: 12, width: 2, height: 3 },
          ]),
        ).ok,
      ).toBe(true);
    });

    it("accepts an empty list and an absent field", () => {
      expect(validateAssistantTurn(withImages([])).ok).toBe(true);
      expect(validateAssistantTurn(mutableTurn()).ok).toBe(true);
    });

    it("rejects a malformed list with its own reason code", () => {
      for (const bad of [
        "not an array",
        {},
        [null],
        ["a string"],
        // Missing path.
        [{ mimeType: "image/png", byteLength: 1 }],
        // Blank path.
        [{ path: "  ", mimeType: "image/png", byteLength: 1 }],
        // A media type this pathway never produces.
        [{ path: "a.bmp", mimeType: "image/bmp", byteLength: 1 }],
        // Sizes that cannot be real.
        [{ path: "a.png", mimeType: "image/png", byteLength: -1 }],
        [{ path: "a.png", mimeType: "image/png", byteLength: 1.5 }],
        [{ path: "a.png", mimeType: "image/png" }],
        // Dimensions present but not positive integers.
        [{ path: "a.png", mimeType: "image/png", byteLength: 1, width: 0, height: 1 }],
        [{ path: "a.png", mimeType: "image/png", byteLength: 1, width: 1, height: -3 }],
        [{ path: "a.png", mimeType: "image/png", byteLength: 1, width: "1", height: 1 }],
      ]) {
        expect(reasonCode(withImages(bad)), JSON.stringify(bad)).toBe(
          "result_images_invalid",
        );
      }
    });

    it("rejects an unknown key inside an image record, bytes above all", () => {
      // The one thing this record must never carry, named explicitly: a persisted
      // conversation must not grow base64 through a field nobody validated.
      expect(
        reasonCode(withImages([{ ...ONE_IMAGE[0], data: "AQID" }])),
      ).toBe("result_image_field_unexpected");
      expect(
        reasonCode(withImages([{ ...ONE_IMAGE[0], hash: "abc" }])),
      ).toBe("result_image_field_unexpected");
    });
  });
});

describe("validateProviderReplayCapsule", () => {
  it("accepts the complete fixture-backed Anthropic capsule", () => {
    const value = capsule();
    expect(validateProviderReplayCapsule(value)).toEqual({ ok: true, value });
  });

  it("rejects an unknown version, empty signature, or invalid block as a whole", () => {
    const version = structuredClone(capsule()) as unknown as Record<string, unknown>;
    version.version = 2;
    expect(validateProviderReplayCapsule(version)).toMatchObject({
      ok: false,
      reason: { code: "capsule_version_unsupported" },
    });

    const signature = structuredClone(capsule());
    const thinking = signature.thinkingBlocks[0];
    if (thinking.type !== "thinking") throw new Error("Fixture shape changed.");
    thinking.signature = "";
    expect(validateProviderReplayCapsule(signature)).toMatchObject({
      ok: false,
      reason: { code: "capsule_block_invalid" },
    });

    const block = structuredClone(capsule()) as unknown as Record<string, unknown>;
    block.thinkingBlocks = [{ type: "text", text: "Do not keep this block." }];
    expect(validateProviderReplayCapsule(block)).toMatchObject({
      ok: false,
      reason: { code: "capsule_block_invalid" },
    });
  });

  it("rejects an oversized capsule without returning a partially truncated value", () => {
    const oversized = capsule();
    const first = oversized.thinkingBlocks[0];
    if (first.type !== "thinking") throw new Error("Fixture shape changed.");
    first.thinking = "x".repeat(ASSISTANT_TURN_MAX_REPLAY_CAPSULE_CHARS + 1);

    const result = validateProviderReplayCapsule(oversized);

    expect(result).toMatchObject({
      ok: false,
      reason: { code: "capsule_too_large" },
    });
    expect(result).not.toHaveProperty("value");
  });

  it("causes the complete turn chain to fail when its capsule is invalid", () => {
    const turn = validTurn();
    const replayCapsule = turn.segments[0].replayCapsule;
    if (!replayCapsule) throw new Error("Fixture shape changed.");
    replayCapsule.version = 2 as 1;

    const result = validateAssistantTurn(turn);

    expect(result).toMatchObject({
      ok: false,
      reason: {
        code: "replay_capsule_invalid",
        path: "segments[0].replayCapsule",
      },
    });
    expect(result).not.toHaveProperty("value");
  });
});
