import { describe, it, expect } from "vitest";
import { toHistoryTurn } from "../../../src/chat/finalization/prepareApiMessages";
import type { AgenticStep, ConversationMessage } from "../../../src/shared/types";
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

/**
 * Claude Code cold-rebuild replay (section 4.A / section 4.C). Only under the claudecode flag does
 * an assistant turn gain its persisted tool-activity digest and interruption marker,
 * as presentation-only annotations that ride `content`; `rawContent` keeps the raw
 * streamed bytes so the live-session linearity hash is untouched (ADR-0014).
 */
describe("toHistoryTurn, Claude Code replay annotation", () => {
  const steps: AgenticStep[] = [
    { type: "tool_call", round: 0, toolName: "read_file", toolInput: "Chapters/ch3.md", resultRecord: "text" },
    {
      type: "tool_call",
      round: 0,
      toolName: "create_directory",
      toolInput: "Drafts/Arcs",
      disposition: "declined",
    },
  ];

  it("appends the agentic digest and exposes the raw text as rawContent", () => {
    const message: ConversationMessage = {
      id: "m1",
      role: "assistant",
      content: "I read the chapter and tried to make a folder.",
      provider: "claudecode",
      agenticSteps: steps,
    };
    const turn = toHistoryTurn(message, false, true);
    expect(turn.content).toBe(
      "I read the chapter and tried to make a folder.\n\n" +
        "[read_file: Chapters/ch3.md]\n\n" +
        "[create_directory: Drafts/Arcs, DECLINED by user]",
    );
    expect(turn.rawContent).toBe("I read the chapter and tried to make a folder.");
  });

  it("does NOT annotate when the claudecode flag is off (other providers unaffected)", () => {
    const message: ConversationMessage = {
      id: "m1",
      role: "assistant",
      content: "Plain reply.",
      provider: "claudecode",
      agenticSteps: steps,
    };
    // Default third arg (false): byte-identical to today, no digest, no rawContent.
    expect(toHistoryTurn(message, false)).toEqual({ role: "assistant", content: "Plain reply." });
  });

  it("degrades to today's behavior for a claudecode turn with no steps and no interruption", () => {
    const message: ConversationMessage = {
      id: "m1",
      role: "assistant",
      content: "Just prose.",
      provider: "claudecode",
    };
    expect(toHistoryTurn(message, false, true)).toEqual({ role: "assistant", content: "Just prose." });
  });

  it("replays a pre-phase-2 turn byte-identically (steps carry no capture fields)", () => {
    // An old conversation's steps predate phase-2 capture: no digest, no record, no
    // disposition. They must produce no lines so the blob matches today's exactly.
    const message: ConversationMessage = {
      id: "m1",
      role: "assistant",
      content: "Old reply.",
      provider: "claudecode",
      agenticSteps: [{ type: "tool_call", round: 0, toolName: "read_file", toolInput: "a.md" }],
    };
    expect(toHistoryTurn(message, false, true)).toEqual({ role: "assistant", content: "Old reply." });
  });

  it("marks a partial (non-empty) aborted turn as interrupted after its digest", () => {
    const message: ConversationMessage = {
      id: "m1",
      role: "assistant",
      content: "Once upon a",
      provider: "claudecode",
      interrupted: true,
      agenticSteps: [
        { type: "tool_call", round: 0, toolName: "read_file", toolInput: "a.md", resultRecord: "text" },
      ],
    };
    const turn = toHistoryTurn(message, false, true);
    expect(turn.content).toBe("Once upon a\n\n[read_file: a.md]\n\n[response interrupted by user]");
    expect(turn.rawContent).toBe("Once upon a");
  });

  it("gives an empty aborted turn a replay body of its digest + interruption marker", () => {
    const message: ConversationMessage = {
      id: "m1",
      role: "assistant",
      content: "",
      provider: "claudecode",
      interrupted: true,
      agenticSteps: [
        { type: "tool_call", round: 0, toolName: "read_file", toolInput: "a.md", resultRecord: "text" },
      ],
    };
    const turn = toHistoryTurn(message, false, true);
    expect(turn.content).toBe("[read_file: a.md]\n\n[response interrupted by user]");
    // The raw bytes the watermark banked were empty; the hash must still see "".
    expect(turn.rawContent).toBe("");
  });

  it("does not touch claudecode user turns", () => {
    const message: ConversationMessage = {
      id: "m1",
      role: "user",
      content: "read_file for me",
      provider: "claudecode",
      interrupted: true,
    };
    expect(toHistoryTurn(message, false, true)).toEqual({ role: "user", content: "read_file for me" });
  });
});
