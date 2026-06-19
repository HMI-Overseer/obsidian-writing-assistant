import { describe, it, expect } from "vitest";
import {
  WRITABLE_FILE_EXTENSIONS,
  hasWritableExtension,
  unsupportedTypeMessage,
} from "../../../../src/tools/vault-ops/writableFileTypes";

describe("hasWritableExtension", () => {
  it("accepts the allowlisted Obsidian document types (case-insensitive)", () => {
    for (const path of [
      "a.md",
      "Notes/B.md",
      "deep/Folder/note.md",
      "X.MD",
      "archive.tar.md", // multi-dot — the final extension is what counts
      "Board.canvas",
      "Maps/World.CANVAS",
    ]) {
      expect(hasWritableExtension(path), path).toBe(true);
    }
  });

  it("refuses a missing extension (forgotten .md)", () => {
    for (const path of ["NoExtension", "Sandbox/NoExtension", "Notes/draft"]) {
      expect(hasWritableExtension(path), path).toBe(false);
    }
  });

  it("refuses executable / script / non-document types (allowlist is closed by default)", () => {
    for (const path of [
      "run.bat",
      "Sandbox/payload.exe",
      "tool.cmd",
      "script.ps1",
      "install.sh",
      "app.js",
      "page.html",
      "data.json",
      "snippet.css",
      "notes.txt",
    ]) {
      expect(hasWritableExtension(path), path).toBe(false);
    }
  });

  it("refuses edge shapes that are not a real document name", () => {
    expect(hasWritableExtension(".md")).toBe(false); // dotfile with no stem
    expect(hasWritableExtension("note.")).toBe(false); // trailing dot, no extension
    expect(hasWritableExtension("v1.2/draft")).toBe(false); // dot is in a folder, file has none
    expect(hasWritableExtension("")).toBe(false);
  });

  it("matches the disk extension regardless of backslash separators", () => {
    expect(hasWritableExtension("Sandbox\\Sub\\note.md")).toBe(true);
    expect(hasWritableExtension("Sandbox\\Sub\\run.bat")).toBe(false);
  });
});

describe("unsupportedTypeMessage", () => {
  it("names the offending path and the allowed types (self-correcting)", () => {
    const msg = unsupportedTypeMessage("Sandbox/run.bat");
    expect(msg).toContain("Sandbox/run.bat");
    expect(msg).toContain("unsupported file type");
    for (const ext of WRITABLE_FILE_EXTENSIONS) expect(msg).toContain(ext);
  });
});
