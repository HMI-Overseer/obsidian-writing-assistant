import { describe, it, expect } from "vitest";
import {
  toHistoryTurns as projectHistoryTurns,
  toRequestHistoryTurns as projectRequestHistoryTurns,
} from "../../../src/chat/finalization/prepareApiMessages";
import {
  normalizeConversation,
} from "../../../src/chat/conversation/conversationUtils";
import type { AgenticStep, ConversationMessage } from "../../../src/shared/types";
import type { DiffHunk, EditProposal, EditStatus } from "../../../src/editing/editTypes";

function loadMessage(
  message: ConversationMessage,
): ConversationMessage {
  if (message.role === "user") return message;
  const normalized = normalizeConversation({
    id: "conversation-fixture",
    title: "Fixture",
    createdAt: 1,
    updatedAt: 1,
    modelId: "openai:gpt-fixture",
    modelName: "GPT fixture",
    messages: [message],
    draft: "",
  });
  if (!normalized?.messages[0]) {
    throw new Error("Fixture assistant message did not normalize.");
  }
  return normalized.messages[0];
}

function toHistoryTurns(
  message: ConversationMessage,
  supportsVision: boolean,
  provider?: "anthropic" | "openai" | "lmstudio" | "claudecode",
) {
  return projectHistoryTurns(
    loadMessage(message),
    supportsVision,
    provider,
  );
}

function toRequestHistoryTurns(
  messages: ConversationMessage[],
  supportsVision: boolean,
) {
  return projectRequestHistoryTurns(
    messages.map(loadMessage),
    supportsVision,
  );
}

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

describe("toHistoryTurns legacy compatibility", () => {
  it("passes plain messages through untouched, with no rawContent", () => {
    const message: ConversationMessage = { id: "m1", role: "assistant", content: "Hello." };
    expect(toHistoryTurns(message, false)).toEqual([
      { role: "assistant", content: "Hello." },
    ]);
  });

  it("annotates tool-call edit turns and exposes the raw text as rawContent", () => {
    const message: ConversationMessage = {
      id: "m1",
      role: "assistant",
      content: "I trimmed the opening.",
      editProposals: [makeProposal([makeHunk("h1", "", "The opening", "accepted")])],
      toolCalls: [{ id: "t1", name: "edit", arguments: {} }],
    };
    const [turn] = toHistoryTurns(message, false);
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
    const [turn] = toHistoryTurns(message, false);
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
    expect(toHistoryTurns(message, false)[0].attachments?.map((a) => a.type)).toEqual(["note"]);
    expect(toHistoryTurns(message, true)[0].attachments?.map((a) => a.type)).toEqual(["image", "note"]);
  });

  it.each(["anthropic", "openai", "lmstudio"] as const)(
    "replays only exact ask guidance for direct %s history",
    (provider) => {
      const message: ConversationMessage = {
        id: "m-ask",
        role: "assistant",
        content: "I continued with your choice.",
        provider,
        agenticSteps: [
          {
            type: "tool_call",
            round: 0,
            toolName: "read",
            resultRecord: "ordinary direct tool result",
          },
          {
            type: "tool_call",
            round: 1,
            toolName: "ask_user",
            resultRecord: '{"answers":{"Format":"Detailed"}}',
            resultDigest: "[stale display digest]",
            askGuidance: {
              questions: [
                {
                  question: "Format",
                  header: "Output",
                  answer: "Detailed",
                },
              ],
            },
          },
        ],
      };

      const [turn] = toHistoryTurns(message, false, provider);

      expect(turn.content).toBe(
        "I continued with your choice.\n\n" +
          '[ask_user guidance: {"questions":[{"question":"Format","header":"Output","answer":"Detailed"}]}]',
      );
      expect(turn.content).not.toContain("read");
      expect(turn.content).not.toContain("stale display digest");
      expect(turn.rawContent).toBeUndefined();
    },
  );
});

describe("toRequestHistoryTurns error filtering", () => {
  it("emits a guidance-only assistant turn when error prose is filtered", () => {
    const message: ConversationMessage = {
      id: "m-error",
      role: "assistant",
      content: "Error: provider failed after submission.",
      isError: true,
      agenticSteps: [
        {
          type: "tool_call",
          round: 0,
          toolName: "ask_user",
          askStatus: "completed",
          askGuidance: {
            questions: [
              {
                question: "Format",
                header: "Output",
                answer: "Detailed",
              },
            ],
          },
        },
      ],
    };

    expect(toRequestHistoryTurns([message], false)).toEqual([
      {
        role: "assistant",
        content:
          '[ask_user guidance: {"questions":[{"question":"Format","header":"Output","answer":"Detailed"}]}]',
      },
    ]);
  });

  it("still drops ordinary error messages without completed ask guidance", () => {
    const message: ConversationMessage = {
      id: "m-error",
      role: "assistant",
      content: "Error: provider failed.",
      isError: true,
    };

    expect(toRequestHistoryTurns([message], false)).toEqual([]);
  });
});

/**
 * Claude Code cold-rebuild replay (section 4.A / section 4.C). Only under the claudecode flag does
 * an assistant turn gain its persisted tool-activity digest and interruption marker,
 * as presentation-only annotations that ride `content`; `rawContent` keeps the raw
 * streamed bytes so the live-session linearity hash is untouched (ADR-0014).
 */
describe("toHistoryTurns, Claude Code replay annotation", () => {
  const steps: AgenticStep[] = [
    { type: "tool_call", round: 0, toolName: "read", toolInput: "Chapters/ch3.md", resultRecord: "text" },
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
    const [turn] = toHistoryTurns(message, false, "claudecode");
    expect(turn.content).toBe(
      "I read the chapter and tried to make a folder.\n\n" +
        "[read: Chapters/ch3.md]\n\n" +
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
    expect(toHistoryTurns(message, false)).toEqual([
      { role: "assistant", content: "Plain reply." },
    ]);
  });

  it("degrades to today's behavior for a claudecode turn with no steps and no interruption", () => {
    const message: ConversationMessage = {
      id: "m1",
      role: "assistant",
      content: "Just prose.",
      provider: "claudecode",
    };
    expect(toHistoryTurns(message, false, "claudecode")).toEqual([
      { role: "assistant", content: "Just prose." },
    ]);
  });

  it("replays a pre-phase-2 turn byte-identically (steps carry no capture fields)", () => {
    // An old conversation's steps predate phase-2 capture: no digest, no record, no
    // disposition. They must produce no lines so the blob matches today's exactly.
    const message: ConversationMessage = {
      id: "m1",
      role: "assistant",
      content: "Old reply.",
      provider: "claudecode",
      agenticSteps: [{ type: "tool_call", round: 0, toolName: "read", toolInput: "a.md" }],
    };
    expect(toHistoryTurns(message, false, "claudecode")).toEqual([
      { role: "assistant", content: "Old reply." },
    ]);
  });

  it("marks a partial (non-empty) aborted turn as interrupted after its digest", () => {
    const message: ConversationMessage = {
      id: "m1",
      role: "assistant",
      content: "Once upon a",
      provider: "claudecode",
      interrupted: true,
      agenticSteps: [
        { type: "tool_call", round: 0, toolName: "read", toolInput: "a.md", resultRecord: "text" },
      ],
    };
    const [turn] = toHistoryTurns(message, false, "claudecode");
    expect(turn.content).toBe("Once upon a\n\n[read: a.md]\n\n[response interrupted by user]");
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
        { type: "tool_call", round: 0, toolName: "read", toolInput: "a.md", resultRecord: "text" },
      ],
    };
    const [turn] = toHistoryTurns(message, false, "claudecode");
    expect(turn.content).toBe("[read: a.md]\n\n[response interrupted by user]");
    // The raw bytes the watermark banked were empty; the hash must still see "".
    expect(turn.rawContent).toBe("");
  });

  it("does not touch claudecode user turns", () => {
    const message: ConversationMessage = {
      id: "m1",
      role: "user",
      content: "read for me",
      provider: "claudecode",
      interrupted: true,
    };
    expect(toHistoryTurns(message, false, "claudecode")).toEqual([
      { role: "user", content: "read for me" },
    ]);
  });

  it("replays ask guidance exactly once and keeps Claude Code rawContent unchanged", () => {
    const message: ConversationMessage = {
      id: "m-ask",
      role: "assistant",
      content: "Continuing.",
      provider: "claudecode",
      agenticSteps: [
        {
          type: "tool_call",
          round: 0,
          toolName: "ask_user",
          resultRecord: '{"answers":{"Format":"Detailed"}}',
          resultDigest: "[stale ask digest]",
          askGuidance: {
            questions: [
              {
                question: "Format",
                header: "Output",
                answer: "Detailed",
              },
            ],
          },
        },
      ],
    };

    const [turn] = toHistoryTurns(message, false, "claudecode");
    const guidance =
      '[ask_user guidance: {"questions":[{"question":"Format","header":"Output","answer":"Detailed"}]}]';

    expect(turn.content).toBe(`Continuing.\n\n${guidance}`);
    expect(turn.content.split(guidance)).toHaveLength(2);
    expect(turn.rawContent).toBe("Continuing.");
  });

  it("keeps the raw-prose watermark byte-exact across every current replay annotation", () => {
    const raw = "  First line.\r\n\r\nFinal line with trailing spaces.  ";
    const message: ConversationMessage = {
      id: "m-characterization-watermark",
      role: "assistant",
      content: raw,
      provider: "claudecode",
      interrupted: true,
      agenticSteps: [
        {
          type: "tool_call",
          round: 0,
          toolName: "read",
          toolCallId: "read-characterization",
          resultRecord: "synthetic result",
        },
        {
          type: "tool_call",
          round: 1,
          toolName: "ask_user",
          toolCallId: "ask-characterization",
          askGuidance: {
            questions: [
              {
                question: "Continue?",
                header: "Next",
                answer: "Yes",
              },
            ],
          },
        },
      ],
    };

    const [turn] = toHistoryTurns(message, false, "claudecode");

    expect(turn.content).toContain("[read");
    expect(turn.content).toContain("[ask_user guidance:");
    expect(turn.content).toContain("[response interrupted by user]");
    expect(turn.rawContent).toBe(raw);
  });
});
