import { describe, it, expect } from "vitest";
import {
  buildClaudeCodePrompt,
  buildDeltaPrompt,
  thinkingBudget,
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
    expect(prompt).toBe("User: Only this");
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
});

describe("thinkingBudget", () => {
  it("maps no reasoning to a zero budget so the first token isn't delayed by thinking", () => {
    expect(thinkingBudget(null)).toBe(0);
    expect(thinkingBudget("off")).toBe(0);
  });

  it("scales the budget with the reasoning level", () => {
    expect(thinkingBudget("low")).toBeGreaterThan(0);
    expect(thinkingBudget("low")).toBeLessThan(thinkingBudget("medium"));
    expect(thinkingBudget("medium")).toBeLessThan(thinkingBudget("high"));
  });

  it("treats a bare 'on' as a non-zero default", () => {
    expect(thinkingBudget("on")).toBeGreaterThan(0);
  });
});
