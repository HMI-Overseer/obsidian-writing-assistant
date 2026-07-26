import { describe, expect, it } from "vitest";
import {
  collectInlineEdits,
  type InlineEditTarget,
} from "../../../../src/chat/messages/inlineEditSession";

const targets: InlineEditTarget[] = [
  { proseItemId: "prose-1", originalText: "Before." },
  { proseItemId: "prose-2", originalText: "After." },
];

describe("collectInlineEdits", () => {
  it("returns only the targets whose text actually changed", () => {
    expect(
      collectInlineEdits(targets, ["Before.", "Rewritten after."]),
    ).toEqual([{ proseItemId: "prose-2", text: "Rewritten after." }]);
  });

  it("keeps every changed target in turn order", () => {
    expect(
      collectInlineEdits(targets, ["Rewritten before.", "Rewritten after."]),
    ).toEqual([
      { proseItemId: "prose-1", text: "Rewritten before." },
      { proseItemId: "prose-2", text: "Rewritten after." },
    ]);
  });

  it("trims each value before comparing and committing", () => {
    expect(
      collectInlineEdits(targets, ["  Before.  ", "  Rewritten.\n"]),
    ).toEqual([{ proseItemId: "prose-2", text: "Rewritten." }]);
  });

  it("treats an emptied editor as unchanged rather than as a deletion", () => {
    expect(collectInlineEdits(targets, ["", "   "])).toEqual([]);
    expect(collectInlineEdits(targets, ["", "Rewritten."])).toEqual([
      { proseItemId: "prose-2", text: "Rewritten." },
    ]);
  });

  it("returns nothing when no value changed", () => {
    expect(collectInlineEdits(targets, ["Before.", "After."])).toEqual([]);
  });

  it("carries a single surface with no prose item id", () => {
    const single: InlineEditTarget[] = [{ originalText: "Legacy content." }];

    expect(collectInlineEdits(single, ["Edited content."])).toEqual([
      { text: "Edited content." },
    ]);
  });

  it("ignores a target with no matching value", () => {
    expect(collectInlineEdits(targets, ["Rewritten before."])).toEqual([
      { proseItemId: "prose-1", text: "Rewritten before." },
    ]);
  });
});
