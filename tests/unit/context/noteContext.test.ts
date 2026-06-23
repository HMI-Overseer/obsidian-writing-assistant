import { describe, it, expect } from "vitest";
import { truncateNoteText, getActiveNoteText } from "../../../src/context/noteContext";

const TRUNCATION_MARKER = "[...note truncated...]";

describe("truncateNoteText", () => {
  it("returns content unchanged when within budget (head)", () => {
    const text = "short note";
    expect(truncateNoteText(text, 100)).toBe(text);
  });

  it("returns content unchanged when within budget (tail)", () => {
    const text = "short note";
    expect(truncateNoteText(text, 100, "tail")).toBe(text);
  });

  it("returns content unchanged at the exact boundary", () => {
    const text = "x".repeat(50);
    expect(truncateNoteText(text, 50)).toBe(text);
    expect(truncateNoteText(text, 50, "tail")).toBe(text);
  });

  it("head-keep retains the opening and marks the cut at the end", () => {
    const text = "BEGINNING" + "x".repeat(100) + "ENDING";
    const result = truncateNoteText(text, 20);
    expect(result.startsWith("BEGINNING")).toBe(true);
    expect(result.endsWith(TRUNCATION_MARKER)).toBe(true);
    expect(result).not.toContain("ENDING");
  });

  it("tail-keep retains the ending and marks the cut at the start", () => {
    const text = "BEGINNING" + "x".repeat(100) + "ENDING";
    const result = truncateNoteText(text, 20, "tail");
    expect(result.startsWith(TRUNCATION_MARKER)).toBe(true);
    expect(result.endsWith("ENDING")).toBe(true);
    expect(result).not.toContain("BEGINNING");
  });

  it("tail-keep preserves exactly the last maxContextChars characters of the note", () => {
    const text = "abcdefghijklmnopqrstuvwxyz";
    const result = truncateNoteText(text, 5, "tail");
    expect(result).toBe(`${TRUNCATION_MARKER}\n\nvwxyz`);
  });
});

describe("getActiveNoteText", () => {
  function fakeApp(content: string) {
    return {
      workspace: { getActiveFile: () => ({ name: "chapter.md" }) },
      vault: { read: () => Promise.resolve(content) },
    } as unknown as Parameters<typeof getActiveNoteText>[0];
  }

  it("returns null when there is no active file", async () => {
    const app = {
      workspace: { getActiveFile: () => null },
      vault: { read: () => Promise.resolve("") },
    } as unknown as Parameters<typeof getActiveNoteText>[0];
    expect(await getActiveNoteText(app, 100)).toBeNull();
  });

  it("forwards tail-keep so the note ending survives truncation", async () => {
    const text = "OPENING" + "y".repeat(100) + "CLOSING";
    const app = fakeApp(text);
    const result = await getActiveNoteText(app, 20, "tail");
    expect(result).not.toBeNull();
    expect(result?.endsWith("CLOSING")).toBe(true);
    expect(result?.startsWith(TRUNCATION_MARKER)).toBe(true);
  });

  it("defaults to head-keep", async () => {
    const text = "OPENING" + "y".repeat(100) + "CLOSING";
    const app = fakeApp(text);
    const result = await getActiveNoteText(app, 20);
    expect(result?.startsWith("OPENING")).toBe(true);
    expect(result?.endsWith(TRUNCATION_MARKER)).toBe(true);
  });
});
