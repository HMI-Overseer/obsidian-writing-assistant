import { describe, expect, it } from "vitest";
import {
  AssistantTurnRenderSequencer,
} from "../../../../src/chat/messages/AssistantTurnRenderSequencer";

describe("AssistantTurnRenderSequencer", () => {
  it("suppresses an older async markdown completion for the same item", () => {
    const sequencer = new AssistantTurnRenderSequencer();
    const stale = sequencer.begin("prose-1");
    const latest = sequencer.begin("prose-1");

    expect(sequencer.isCurrent(stale)).toBe(false);
    expect(sequencer.isCurrent(latest)).toBe(true);
  });

  it("keeps independent prose item renders independent", () => {
    const sequencer = new AssistantTurnRenderSequencer();
    const first = sequencer.begin("prose-1");
    const second = sequencer.begin("prose-2");

    expect(sequencer.isCurrent(first)).toBe(true);
    expect(sequencer.isCurrent(second)).toBe(true);
  });

  it("invalidates detached item hosts and all work on cleanup", () => {
    const sequencer = new AssistantTurnRenderSequencer();
    const detached = sequencer.begin("prose-1");
    const destroyed = sequencer.begin("prose-2");

    sequencer.invalidate("prose-1");
    expect(sequencer.isCurrent(detached)).toBe(false);

    sequencer.destroy();
    expect(sequencer.isCurrent(destroyed)).toBe(false);
    expect(() => sequencer.begin("prose-3")).toThrow(/destroyed/u);
  });
});
