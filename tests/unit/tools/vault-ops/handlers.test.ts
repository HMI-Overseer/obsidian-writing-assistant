import { describe, it, expect } from "vitest";
import type { App } from "obsidian";
import { TFile, TFolder } from "obsidian";
import type { ToolCall } from "../../../../src/tools/types";
import {
  executeVaultOpTool,
  buildPendingOverlay,
} from "../../../../src/tools/vault-ops/handlers";

/** A fake app whose only disk knowledge is a path→state map. */
function makeApp(states: Record<string, "file" | "dir">): App {
  return {
    vault: {
      getAbstractFileByPath(path: string) {
        const norm = path.replace(/\\/g, "/").replace(/(^\/|\/$)/g, "");
        const state = states[norm];
        if (state === "dir") {
          const folder = new TFolder();
          folder.path = norm;
          return folder;
        }
        if (state === "file") {
          const file = new TFile();
          file.path = norm;
          return file;
        }
        return null;
      },
    },
  } as unknown as App;
}

function call(name: string, args: Record<string, unknown>): ToolCall {
  return { id: `${name}-1`, name, arguments: args };
}

const NO_OVERLAY = new Map();

describe("executeVaultOpTool", () => {
  it("rejects an unknown tool name", () => {
    const app = makeApp({});
    const result = executeVaultOpTool(call("delete_everything", {}), { app, overlay: NO_OVERLAY });
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/^Error: /);
    expect(result.content).toContain('unknown vault operation tool "delete_everything"');
    expect(result.failure?.kind).toBe("invalid-args");
  });

  describe("write_file", () => {
    it("acknowledges a new file as a create", () => {
      const app = makeApp({});
      const result = executeVaultOpTool(
        call("write_file", { path: "Characters/Vex.md", content: "hi" }),
        { app, overlay: NO_OVERLAY },
      );
      expect(result.isError).toBeUndefined();
      expect(result.content).toContain("New file");
      expect(result.content).toContain("queued for review");
    });

    it("refuses a path that escapes the vault, returning an error to the model", () => {
      const app = makeApp({});
      for (const path of ["../../outside-vault.md", "C:/Windows/System32/test.md"]) {
        const result = executeVaultOpTool(
          call("write_file", { path, content: "x" }),
          { app, overlay: NO_OVERLAY },
        );
        expect(result.isError).toBe(true);
        expect(result.content).toContain("outside the vault");
        // Trimmed to a single self-correcting recovery, no doubled generic tail.
        expect(result.content).toContain("vault-relative path");
        expect(result.content).not.toContain("schema and retry");
      }
    });

    it("acknowledges an existing file as an overwrite", () => {
      const app = makeApp({ "Characters/Vex.md": "file" });
      const result = executeVaultOpTool(
        call("write_file", { path: "Characters/Vex.md", content: "hi" }),
        { app, overlay: NO_OVERLAY },
      );
      expect(result.content).toContain("Overwrite of");
    });

    it("errors when the path is a folder", () => {
      const app = makeApp({ Characters: "dir" });
      const result = executeVaultOpTool(
        call("write_file", { path: "Characters", content: "hi" }),
        { app, overlay: NO_OVERLAY },
      );
      expect(result.isError).toBe(true);
      expect(result.content).toContain("folder");
    });
  });

  describe("create_directory", () => {
    it("acknowledges a new folder", () => {
      const app = makeApp({});
      const result = executeVaultOpTool(call("create_directory", { path: "New/Folder" }), {
        app,
        overlay: NO_OVERLAY,
      });
      expect(result.content).toContain("New folder");
    });

    it("treats an existing folder as a no-op", () => {
      const app = makeApp({ "New/Folder": "dir" });
      const result = executeVaultOpTool(call("create_directory", { path: "New/Folder" }), {
        app,
        overlay: NO_OVERLAY,
      });
      expect(result.isError).toBeUndefined();
      expect(result.content).toContain("already exists");
      expect(result.content).toContain("nothing to create");
    });

    it("errors when the path is a file", () => {
      const app = makeApp({ "note.md": "file" });
      const result = executeVaultOpTool(call("create_directory", { path: "note.md" }), {
        app,
        overlay: NO_OVERLAY,
      });
      expect(result.isError).toBe(true);
    });
  });

  describe("move_file", () => {
    it("acknowledges a valid move", () => {
      const app = makeApp({ "Inbox/Draft.md": "file" });
      const result = executeVaultOpTool(
        call("move_file", { from: "Inbox/Draft.md", to: "Characters/Vex.md" }),
        { app, overlay: NO_OVERLAY },
      );
      expect(result.content).toContain("Move");
      expect(result.content).toContain("Inbox/Draft.md");
    });

    it("errors when the destination already exists", () => {
      const app = makeApp({ "Inbox/Draft.md": "file", "Characters/Vex.md": "file" });
      const result = executeVaultOpTool(
        call("move_file", { from: "Inbox/Draft.md", to: "Characters/Vex.md" }),
        { app, overlay: NO_OVERLAY },
      );
      expect(result.isError).toBe(true);
      expect(result.content).toContain("already exists");
    });

    it("errors when the source does not exist", () => {
      const app = makeApp({});
      const result = executeVaultOpTool(
        call("move_file", { from: "Inbox/Draft.md", to: "Characters/Vex.md" }),
        { app, overlay: NO_OVERLAY },
      );
      expect(result.isError).toBe(true);
    });
  });

  describe("trash_file", () => {
    it("acknowledges trashing a file", () => {
      const app = makeApp({ "Inbox/Obsolete.md": "file" });
      const result = executeVaultOpTool(call("trash_file", { path: "Inbox/Obsolete.md" }), {
        app,
        overlay: NO_OVERLAY,
      });
      expect(result.content).toContain("Trash");
    });

    it("rejects a folder (files only)", () => {
      const app = makeApp({ Inbox: "dir" });
      const result = executeVaultOpTool(call("trash_file", { path: "Inbox" }), {
        app,
        overlay: NO_OVERLAY,
      });
      expect(result.isError).toBe(true);
      expect(result.content).toContain("files only");
    });
  });
});

describe("buildPendingOverlay (intra-turn dependencies, spec §4)", () => {
  it("lets a later move see an earlier write", () => {
    const app = makeApp({}); // A is not on disk
    const overlay = buildPendingOverlay(app, [
      call("write_file", { path: "A.md", content: "x" }),
    ]);
    expect(overlay.get("A.md")).toBe("file");

    // move A→B now validates against the overlay rather than failing "source not found".
    const result = executeVaultOpTool(call("move_file", { from: "A.md", to: "B.md" }), {
      app,
      overlay,
    });
    expect(result.isError).toBeUndefined();
  });

  it("chains write → move so a follow-up move sees the moved destination", () => {
    const app = makeApp({});
    const overlay = buildPendingOverlay(app, [
      call("write_file", { path: "A.md", content: "x" }),
      call("move_file", { from: "A.md", to: "B.md" }),
    ]);
    expect(overlay.get("A.md")).toBe("absent");
    expect(overlay.get("B.md")).toBe("file");

    const result = executeVaultOpTool(call("move_file", { from: "B.md", to: "C.md" }), {
      app,
      overlay,
    });
    expect(result.isError).toBeUndefined();
  });

  it("marks created folders as dir in the overlay", () => {
    const app = makeApp({});
    const overlay = buildPendingOverlay(app, [
      call("create_directory", { path: "New/Folder" }),
    ]);
    expect(overlay.get("New/Folder")).toBe("dir");
  });
});
