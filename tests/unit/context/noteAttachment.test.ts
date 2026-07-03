import { describe, it, expect } from "vitest";
import { snapshotNoteAttachments } from "../../../src/context/noteAttachment";
import type { NoteAttachment } from "../../../src/shared/types";

type SnapshotApp = Parameters<typeof snapshotNoteAttachments>[0];

describe("snapshotNoteAttachments — external (inline content) items", () => {
  it("uses inline content without touching the vault", async () => {
    const app = {
      workspace: { getActiveFile: () => null },
      vault: {
        getFileByPath: () => {
          throw new Error("inline items must not resolve against the vault");
        },
        read: () => {
          throw new Error("inline items must not read the vault");
        },
      },
    } as unknown as SnapshotApp;

    const result = await snapshotNoteAttachments(app, {
      activeNoteAttached: false,
      extraContextItems: [
        { filePath: "external.md", fileName: "external.md", content: "hello world" },
      ],
      maxContextChars: 100,
      // Images are resolved from a vault TFile; inline items skip that path even when on.
      includeImages: true,
    });

    expect(result).toHaveLength(1);
    const note = result[0] as NoteAttachment;
    expect(note.type).toBe("note");
    expect(note.filePath).toBe("external.md");
    expect(note.fileName).toBe("external.md");
    expect(note.content).toBe("hello world");
    expect(note.truncated).toBe(false);
    expect(note.mtimeSnapshot).toBe(0);
  });

  it("truncates inline content that exceeds the character budget", async () => {
    const app = {
      workspace: { getActiveFile: () => null },
      vault: {},
    } as unknown as SnapshotApp;

    const result = await snapshotNoteAttachments(app, {
      activeNoteAttached: false,
      extraContextItems: [{ filePath: "big.md", fileName: "big.md", content: "x".repeat(500) }],
      maxContextChars: 50,
      includeImages: false,
    });

    const note = result[0] as NoteAttachment;
    expect(note.truncated).toBe(true);
    expect(note.content.length).toBeLessThan(500);
  });

  it("still reads vault-backed items from disk", async () => {
    const app = {
      workspace: { getActiveFile: () => null },
      vault: {
        getFileByPath: (p: string) =>
          p === "vault/note.md" ? { path: p, basename: "note", stat: { mtime: 42 } } : null,
        read: () => Promise.resolve("vault body"),
      },
    } as unknown as SnapshotApp;

    const result = await snapshotNoteAttachments(app, {
      activeNoteAttached: false,
      extraContextItems: [{ filePath: "vault/note.md", fileName: "note.md" }],
      maxContextChars: 100,
      includeImages: false,
    });

    const note = result[0] as NoteAttachment;
    expect(note.content).toBe("vault body");
    expect(note.mtimeSnapshot).toBe(42);
  });
});
