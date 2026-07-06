import { describe, it, expect } from "vitest";
import { toHistoryTurn } from "../../../src/chat/finalization/prepareApiMessages";
import type { ConversationMessage } from "../../../src/shared/types";
import type { DiffHunk, EditProposal, EditStatus } from "../../../src/editing/editTypes";

function makeHunk(id: string, rawBlock: string, searchText: string, status: EditStatus): DiffHunk {
  return {
    id,
    status,
    resolvedEdit: {
      id: `re-${id}`,
      editBlock: { id: `b-${id}`, searchText, replaceText: "new text", rawBlock },
      matchOffset: 0,
      matchLength: searchText.length,
      matchedText: searchText,
      startLine: 1,
      endLine: 1,
      contextBefore: [],
      contextAfter: [],
      confidence: 1,
      matchType: "exact",
    },
  };
}

function makeProposal(hunks: DiffHunk[]): EditProposal {
  return {
    id: "p1",
    targetFilePath: "notes/chapter-3.md",
    documentSnapshot: "The opening paragraph.",
    snapshotTimestamp: 1,
    hunks,
    prose: "",
  };
}

describe("toHistoryTurn", () => {
  it("passes plain messages through untouched, with no rawContent", () => {
    const message: ConversationMessage = { id: "m1", role: "assistant", content: "Hello." };
    expect(toHistoryTurn(message, false)).toEqual({ role: "assistant", content: "Hello." });
  });

  it("annotates tool-call edit turns and exposes the raw text as rawContent", () => {
    const message: ConversationMessage = {
      id: "m1",
      role: "assistant",
      content: "I trimmed the opening.",
      editProposals: [makeProposal([makeHunk("h1", "", "The opening", "accepted")])],
      toolCalls: [{ id: "t1", name: "propose_edit", arguments: {} }],
    };
    const turn = toHistoryTurn(message, false);
    expect(turn.content).toContain("[Edit in chapter-3.md:");
    expect(turn.content).toContain("[Edit outcome: 1 accepted, 0 rejected out of 1 proposed changes]");
    expect(turn.rawContent).toBe("I trimmed the opening.");
  });

  it("annotates regex edit turns without rawContent (no in-band disposition channel)", () => {
    const rawBlock = "<<<SEARCH\nThe opening\n===\nA leaner opening\n>>>REPLACE";
    const message: ConversationMessage = {
      id: "m1",
      role: "assistant",
      content: `Here you go:\n\n${rawBlock}`,
      editProposals: [makeProposal([makeHunk("h1", rawBlock, "The opening", "accepted")])],
    };
    const turn = toHistoryTurn(message, false);
    expect(turn.content).toContain("[ACCEPTED, applied to document]");
    expect(turn.rawContent).toBeUndefined();
  });

  it("drops image attachments for non-vision models but keeps note snapshots", () => {
    const message: ConversationMessage = {
      id: "m1",
      role: "user",
      content: "About this note",
      attachments: [
        { type: "image", id: "i1", mimeType: "image/png", data: "aGk=" },
        {
          type: "note",
          id: "n1",
          filePath: "notes/topic.md",
          fileName: "topic.md",
          content: "Frozen body",
          truncated: false,
          mtimeSnapshot: 1,
        },
      ],
    };
    expect(toHistoryTurn(message, false).attachments?.map((a) => a.type)).toEqual(["note"]);
    expect(toHistoryTurn(message, true).attachments?.map((a) => a.type)).toEqual(["image", "note"]);
  });
});
