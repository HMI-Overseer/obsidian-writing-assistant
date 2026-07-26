import { describe, expect, it } from "vitest";
import type { AssistantTurnRecord } from "../../../../src/shared/types";
import {
  projectRegexEditPreview,
} from "../../../../src/chat/messages/regexEditPreview";

function turn(text: string): AssistantTurnRecord {
  return {
    schemaVersion: 1,
    id: "turn-regex",
    status: "streaming",
    segments: [{ id: "segment-1" }],
    items: text
      ? [
          {
            type: "prose",
            id: "prose-1",
            segmentId: "segment-1",
            text,
          },
        ]
      : [],
  };
}

describe("regex edit preview projection", () => {
  it("derives complete and incomplete edit status from canonical prose only", () => {
    const source = turn(
      "Intro\n<<<<<<< SEARCH\nold\n=======\nnew\n>>>>>>> REPLACE" +
        "\n<<<<<<< SEARCH\nunfinished",
    );
    const before = structuredClone(source);

    expect(projectRegexEditPreview(source)).toEqual({
      completeBlockCount: 1,
      hasIncompleteBlock: true,
    });
    expect(source).toEqual(before);
  });

  it("stays absent until canonical prose contains an edit marker", () => {
    expect(projectRegexEditPreview(turn(""))).toBeNull();
    expect(projectRegexEditPreview(turn("Ordinary prose"))).toBeNull();
  });
});
