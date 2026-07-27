import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ClaudeCodeSdkMessageTranslator } from "../../../../src/api/sdk/claudeCodeSdkMessageTranslator";
import { AssistantTurnBuilder } from "../../../../src/chat/turns/AssistantTurnBuilder";
import type { AssistantTurnSnapshot } from "../../../../src/chat/turns/AssistantTurnBuilder";
import { applyAssistantStreamEvent } from "../../../../src/chat/actions/toolLoop";

/**
 * RFC-0011 phase 0: the incident, reproduced from sanitized live protocol bytes.
 *
 * Tests marked `it.fails` state the behavior RFC-0011 requires and the defect
 * that currently prevents it. They pass while the defect stands and turn red the
 * moment it is fixed, which is the signal to promote them to plain `it` in the
 * phase named in their comment. Nothing here may be relaxed to keep them green.
 */

const FIXTURE_DIR = join(
  process.cwd(),
  "tests",
  "fixtures",
  "provider-capture",
  "claude-code",
);

interface CaptureFixture {
  case: string;
  frames: unknown[];
}

function loadFixture(name: string): CaptureFixture {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, `${name}.json`), "utf8")) as CaptureFixture;
}

interface ReplayOutcome {
  error: Error | null;
  snapshots: AssistantTurnSnapshot[];
}

/**
 * Drives one fixture through the production capture path exactly as
 * {@link runToolLoop} does: translate each frame, then apply every translated
 * event to the builder, publishing a snapshot after each one.
 */
function replayThroughCurrentCapture(fixtureName: string): ReplayOutcome {
  const fixture = loadFixture(fixtureName);
  const translator = new ClaudeCodeSdkMessageTranslator({
    createSegmentId: (index) => `segment-${index}`,
    toolCorrelation: "provider_id",
  });
  // Domain IDs are random in production and are not capture facts, so the
  // replay mints counter-based ones to keep the reproduction byte-stable.
  const builder = new AssistantTurnBuilder({
    turnId: "turn-incident",
    createId: counterIds(),
  });
  const snapshots: AssistantTurnSnapshot[] = [];
  const callbacks = {
    onTurnSnapshot: (snapshot: AssistantTurnSnapshot) => {
      snapshots.push(snapshot);
    },
  };

  try {
    for (const frame of fixture.frames) {
      for (const event of translator.translate(frame)) {
        applyAssistantStreamEvent(builder, event, 0, callbacks);
      }
    }
  } catch (error) {
    return { error: error as Error, snapshots };
  }
  return { error: null, snapshots };
}

function counterIds(): (kind: "segment" | "item") => string {
  const counters = { segment: 0, item: 0 };
  return (kind) => {
    counters[kind] += 1;
    return `${kind}-${counters[kind]}`;
  };
}

function toolItems(snapshot: AssistantTurnSnapshot | undefined) {
  return (snapshot?.items ?? []).filter((item) => item.type === "tool_call");
}

describe("RFC-0011 incident, split provider message", () => {
  it("reproduces the exact-ID collision deterministically", () => {
    const first = replayThroughCurrentCapture(
      "sdk-0.3.207-cli-2.1.218-split-thinking-toolsearch",
    );
    const second = replayThroughCurrentCapture(
      "sdk-0.3.207-cli-2.1.218-split-thinking-toolsearch",
    );

    expect(first.error).toBeInstanceOf(Error);
    expect(first.error?.message).toMatch(/is already bound to item/);
    expect(second.error?.message).toBe(first.error?.message);
  });

  it("publishes a second tool row before detecting the collision", () => {
    const { snapshots } = replayThroughCurrentCapture(
      "sdk-0.3.207-cli-2.1.218-split-thinking-toolsearch",
    );
    const lastBeforeError = snapshots[snapshots.length - 1];

    // Invariant 8 and criterion 9: a rejected batch must leave no new item.
    // The fragment-local index minted a second declaration and the renderer
    // already saw it.
    expect(toolItems(lastBeforeError)).toHaveLength(2);
    expect(new Set(toolItems(lastBeforeError).map((item) => item.id)).size).toBe(2);
  });

  it("derives a provider block identity from a fragment-local array position", () => {
    const translator = new ClaudeCodeSdkMessageTranslator({
      createSegmentId: (index) => `segment-${index}`,
      toolCorrelation: "provider_id",
    });
    const fixture = loadFixture("sdk-0.3.207-cli-2.1.218-split-thinking-toolsearch");
    const blockIdsByToolId = new Map<string, Set<string>>();

    for (const frame of fixture.frames) {
      for (const event of translator.translate(frame)) {
        if (event.type === "tool_call_start" && event.providerBlockId) {
          const key = event.declarationKey;
          const bucket = blockIdsByToolId.get(key) ?? new Set<string>();
          bucket.add(event.providerBlockId);
          blockIdsByToolId.set(key, bucket);
        }
      }
    }

    // Invariant 2 and criterion 3. The partial stream event carried the real
    // provider block index 2; the one-element completed fragment reported 0.
    const declared = [...blockIdsByToolId.values()].flatMap((set) => [...set]);
    expect(declared).toContain("block-2");
    expect(declared).toContain("block-0");
  });

  // Criterion 1, fixed in phase 4 once the assembler and atomic publication land.
  it.fails("captures the split provider message without an identity error", () => {
    const { error } = replayThroughCurrentCapture(
      "sdk-0.3.207-cli-2.1.218-split-thinking-toolsearch",
    );
    expect(error).toBeNull();
  });

  // Criterion 2, fixed in phase 4.
  it.fails("produces exactly one tool item for one provider declaration", () => {
    const { snapshots } = replayThroughCurrentCapture(
      "sdk-0.3.207-cli-2.1.218-split-thinking-toolsearch",
    );
    expect(toolItems(snapshots[snapshots.length - 1])).toHaveLength(1);
  });

  it("reproduces identically through the legacy stream-json transport", () => {
    const sdk = replayThroughCurrentCapture(
      "sdk-0.3.207-cli-2.1.218-split-thinking-toolsearch",
    );
    const legacy = replayThroughCurrentCapture(
      "legacy-cli-2.1.218-split-thinking-toolsearch",
    );
    expect(legacy.error?.message).toBe(sdk.error?.message);
  });
});

describe("RFC-0011 incident, related protocol shapes", () => {
  it("loses the partial text position when a completed fragment renumbers it", () => {
    const { error, snapshots } = replayThroughCurrentCapture(
      "sdk-0.3.207-cli-2.1.218-split-thinking-text",
    );
    expect(error).toBeNull();

    // The text block occupied provider index 1 behind an invisible thinking
    // block. The one-element completed fragment relabelled it block-0, so the
    // streamed prose item was replaced rather than reconciled (invariant 2).
    const last = snapshots[snapshots.length - 1];
    const prose = (last?.items ?? []).filter((item) => item.type === "prose");
    expect(prose).toHaveLength(1);
  });

  it("collides on two consecutive tools in one provider message", () => {
    const { error } = replayThroughCurrentCapture(
      "sdk-0.3.207-cli-2.1.218-two-consecutive-tools",
    );
    expect(error?.message).toMatch(/is already bound to item/);
  });

  // Criterion 6, fixed in phase 3. Two positions claiming one exact ID inside
  // one frame must publish no fact at all.
  it.fails("publishes nothing when one frame claims one tool ID twice", () => {
    const { error, snapshots } = replayThroughCurrentCapture(
      "sdk-0.3.207-cli-2.1.218-intra-frame-duplicate-tool-id",
    );
    expect(error).toBeNull();
    expect(toolItems(snapshots[snapshots.length - 1])).toHaveLength(0);
  });

  it("mints a plugin fallback ID for a declaration it could not identify", () => {
    const fixture = loadFixture("sdk-0.3.207-cli-2.1.218-malformed-tool-declaration");
    const translator = new ClaudeCodeSdkMessageTranslator({
      createSegmentId: (index) => `segment-${index}`,
      toolCorrelation: "provider_id",
    });
    const builder = new AssistantTurnBuilder({ turnId: "turn-malformed" });
    for (const frame of fixture.frames) {
      for (const event of translator.translate(frame)) {
        applyAssistantStreamEvent(builder, event, 0);
      }
    }

    // Criterion 25 in the plan's settled decisions: a fallback ID is valid only
    // where the provider truly omitted one, and never on a rejected batch. The
    // current segment finaliser mints one unconditionally.
    const tools = toolItems(builder.snapshot());
    expect(tools).toHaveLength(0);
  });
});
