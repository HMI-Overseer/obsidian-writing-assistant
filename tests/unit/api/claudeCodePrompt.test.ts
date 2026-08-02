import { describe, it, expect } from "vitest";
import {
  buildClaudeCodePrompt,
  buildDeltaPrompt,
} from "../../../src/api/ClaudeCodeClient";
import type { ChatRequest } from "../../../src/shared/chatRequest";

function makeRequest(overrides: Partial<ChatRequest> = {}): ChatRequest {
  return {
    systemPrompt: "",
    documentContext: null,
    ragContext: null,
    messages: [],
    ...overrides,
  };
}

describe("buildClaudeCodePrompt", () => {
  it("renders the conversation as a speaker transcript", () => {
    const prompt = buildClaudeCodePrompt(
      makeRequest({
        messages: [
          { role: "user", content: "Check this doc." },
          { role: "assistant", content: "Sure." },
          { role: "user", content: "Find irregularities." },
        ],
      }),
    );
    expect(prompt).toContain("User: Check this doc.");
    expect(prompt).toContain("Assistant: Sure.");
    expect(prompt).toContain("User: Find irregularities.");
  });

  it("includes the active document as a labeled block", () => {
    const prompt = buildClaudeCodePrompt(
      makeRequest({
        documentContext: { filePath: "Specs/API.md", content: "# Spec\nBody", isFull: true },
        messages: [{ role: "user", content: "Review" }],
      }),
    );
    expect(prompt).toContain("# Active document: Specs/API.md");
    expect(prompt).toContain("# Spec\nBody");
  });

  it("includes additional context and RAG blocks when present", () => {
    const prompt = buildClaudeCodePrompt(
      makeRequest({
        additionalContextItems: [{ filePath: "a.md", fileName: "a.md", content: "Alpha" }],
        ragContext: [
          { filePath: "b.md", headingPath: "Intro", content: "Beta", score: 0.9 },
        ],
        messages: [{ role: "user", content: "Go" }],
      }),
    );
    expect(prompt).toContain("# Attached context: a.md");
    expect(prompt).toContain("Alpha");
    expect(prompt).toContain("# Retrieved context");
    expect(prompt).toContain("Beta");
  });

  it("renders a note snapshot attached to a user turn", () => {
    const prompt = buildClaudeCodePrompt(
      makeRequest({
        messages: [{
          role: "user",
          content: "About this note",
          attachments: [{
            type: "note",
            id: "n1",
            filePath: "notes/topic.md",
            fileName: "topic.md",
            content: "Frozen body",
            truncated: false,
            mtimeSnapshot: 1,
          }],
        }],
      }),
    );
    expect(prompt).toContain("User: About this note");
    expect(prompt).toContain("Attached note (notes/topic.md):");
    expect(prompt).toContain("Frozen body");
  });

  it("skips empty and null turns", () => {
    const prompt = buildClaudeCodePrompt(
      makeRequest({
        messages: [
          { role: "assistant", content: null },
          { role: "user", content: "Only this" },
        ],
      }),
    );
    // The null assistant turn renders no header; only the one user turn does.
    expect(prompt.endsWith("User: Only this")).toBe(true);
    expect(prompt).not.toMatch(/^Assistant:/m);
  });

  it("opens the mint blob with the framing preamble, byte-stable across rebuilds (section 4.B)", () => {
    const request = makeRequest({
      messages: [
        { role: "user", content: "First" },
        { role: "assistant", content: "Ack" },
        { role: "user", content: "Second" },
      ],
    });
    const first = buildClaudeCodePrompt(request);
    const second = buildClaudeCodePrompt(request);
    expect(first.startsWith("The following is a prior conversation")).toBe(true);
    // Two consecutive rebuilds of the same request produce identical bytes, so the
    // preamble never becomes a linearity drift source (section 5).
    expect(first).toBe(second);
  });

  it("does not prepend a preamble to a transcript-less analyst blob", () => {
    const prompt = buildClaudeCodePrompt(
      makeRequest({
        documentContext: { filePath: "a.md", content: "Body", isFull: true },
      }),
    );
    expect(prompt).not.toContain("prior conversation");
  });

  it("escapes a line-leading User:/Assistant: label inside a turn body (section 1 symptom 3)", () => {
    const prompt = buildClaudeCodePrompt(
      makeRequest({
        messages: [
          { role: "user", content: "hi" },
          { role: "assistant", content: "Reply.\nUser: not a real turn\nAssistant: still me" },
        ],
      }),
    );
    // The literal labels are escaped so they can't be misread as turn boundaries.
    expect(prompt).toContain("\\User: not a real turn");
    expect(prompt).toContain("\\Assistant: still me");
    // Exactly one real header of each role survives at a line start.
    expect(prompt.match(/^User: /gm)?.length).toBe(1);
    expect(prompt.match(/^Assistant: /gm)?.length).toBe(1);
  });

  it("renders digest lines in a turn body verbatim (they are not speaker labels)", () => {
    const prompt = buildClaudeCodePrompt(
      makeRequest({
        messages: [
          { role: "user", content: "hi" },
          {
            role: "assistant",
            content: "Did it.\n\n[read: a.md]\n\n[create_directory: X, DECLINED by user]",
          },
        ],
      }),
    );
    expect(prompt).toContain("[read: a.md]");
    expect(prompt).toContain("[create_directory: X, DECLINED by user]");
  });

  it("prepends the mode tail to the latest user turn only", () => {
    const prompt = buildClaudeCodePrompt(
      makeRequest({
        modeTail: "Planning mode framing.",
        messages: [
          { role: "user", content: "First" },
          { role: "assistant", content: "Ack" },
          { role: "user", content: "Second" },
        ],
      }),
    );
    // Framing rides the current (last) user turn, not earlier ones.
    expect(prompt).toContain("User: Planning mode framing.\n\nSecond");
    expect(prompt).toContain("User: First");
    expect(prompt).not.toContain("Planning mode framing.\n\nFirst");
  });

  it("does not prepend the mode tail when the last turn is the assistant", () => {
    const prompt = buildClaudeCodePrompt(
      makeRequest({
        modeTail: "Mode framing.",
        messages: [
          { role: "user", content: "Hi" },
          { role: "assistant", content: "There" },
        ],
      }),
    );
    expect(prompt).not.toContain("Mode framing.");
  });
});

describe("buildDeltaPrompt", () => {
  it("returns just the latest user turn body when no mode tail is set", () => {
    const prompt = buildDeltaPrompt(
      makeRequest({
        messages: [
          { role: "user", content: "First" },
          { role: "assistant", content: "Ack" },
          { role: "user", content: "Second" },
        ],
      }),
    );
    expect(prompt).toBe("Second");
  });

  it("prepends the mode tail to the latest user turn body", () => {
    const prompt = buildDeltaPrompt(
      makeRequest({
        modeTail: "Planning mode framing.",
        messages: [
          { role: "user", content: "First" },
          { role: "assistant", content: "Ack" },
          { role: "user", content: "Second" },
        ],
      }),
    );
    expect(prompt).toBe("Planning mode framing.\n\nSecond");
  });

  it("carries no preamble or interruption marker (reuse turns never see replay surface, section 5)", () => {
    const prompt = buildDeltaPrompt(
      makeRequest({
        messages: [
          { role: "user", content: "First" },
          { role: "assistant", content: "Ack" },
          { role: "user", content: "Second" },
        ],
      }),
    );
    expect(prompt).toBe("Second");
    expect(prompt).not.toContain("prior conversation");
    expect(prompt).not.toContain("[response interrupted by user]");
  });
});
