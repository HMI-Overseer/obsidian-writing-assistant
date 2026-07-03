import { describe, it, expect } from "vitest";
import { TFile } from "obsidian";
import type { App } from "obsidian";
import {
  getDraggedVaultMarkdownFiles,
  getDroppedVaultMarkdownFiles,
  isMarkdownDropFile,
} from "../../../../src/chat/composer/vaultDrag";

function tfile(path: string, extension = "md"): TFile {
  return Object.assign(new TFile(), {
    path,
    name: path.split("/").pop() ?? path,
    extension,
  });
}

/**
 * Build a fake App. `files` are resolvable by exact path (vault.getFileByPath); `links`
 * are resolvable by link target (metadataCache.getFirstLinkpathDest).
 */
function makeApp(opts: {
  draggable?: unknown;
  files?: TFile[];
  links?: Record<string, TFile>;
}): App {
  const byPath = new Map((opts.files ?? []).map((f) => [f.path, f]));
  const links = opts.links ?? {};
  return {
    dragManager: { draggable: opts.draggable ?? null },
    vault: {
      getFileByPath: (p: string) => byPath.get(p) ?? null,
    },
    metadataCache: {
      getFirstLinkpathDest: (link: string) => links[link] ?? null,
    },
  } as unknown as App;
}

function dropEvent(text: string): DragEvent {
  return {
    dataTransfer: {
      getData: (type: string) => (type === "text/plain" ? text : ""),
    },
  } as unknown as DragEvent;
}

describe("getDraggedVaultMarkdownFiles", () => {
  it("resolves the single dragged markdown file against the vault", () => {
    const file = tfile("Notes/idea.md");
    const app = makeApp({ draggable: { file }, files: [file] });
    expect(getDraggedVaultMarkdownFiles(app)).toEqual([file]);
  });

  it("keeps only markdown from a multi-file selection", () => {
    const md = tfile("a.md");
    const markdown = tfile("b.markdown", "markdown");
    const png = tfile("c.png", "png");
    const app = makeApp({
      draggable: { files: [md, markdown, png] },
      files: [md, markdown, png],
    });
    expect(getDraggedVaultMarkdownFiles(app)).toEqual([md, markdown]);
  });

  it("deduplicates when the same file appears in both slots", () => {
    const file = tfile("dup.md");
    const app = makeApp({ draggable: { file, files: [file] }, files: [file] });
    expect(getDraggedVaultMarkdownFiles(app)).toEqual([file]);
  });

  it("ignores candidates whose path does not resolve to a vault file", () => {
    const app = makeApp({ draggable: { file: { path: "ghost.md" } }, files: [] });
    expect(getDraggedVaultMarkdownFiles(app)).toEqual([]);
  });

  it("returns an empty list when there is no active drag", () => {
    expect(getDraggedVaultMarkdownFiles(makeApp({ draggable: null }))).toEqual([]);
    expect(getDraggedVaultMarkdownFiles({} as unknown as App)).toEqual([]);
  });
});

describe("getDroppedVaultMarkdownFiles — dataTransfer fallback", () => {
  it("prefers the drag manager when it is populated", () => {
    const file = tfile("Notes/idea.md");
    const app = makeApp({ draggable: { file }, files: [file] });
    expect(getDroppedVaultMarkdownFiles(app, dropEvent("ignored"))).toEqual([file]);
  });

  it("resolves a wikilink from the drop text when the manager is empty", () => {
    const file = tfile("Notes/The Witness.md");
    const app = makeApp({ draggable: null, links: { "The Witness": file } });
    expect(getDroppedVaultMarkdownFiles(app, dropEvent("[[The Witness]]"))).toEqual([file]);
  });

  it("resolves an obsidian:// URL from the drop text", () => {
    const file = tfile("Notes/The Witness.md");
    const app = makeApp({ draggable: null, files: [file] });
    const url = "obsidian://open?vault=Harbingers&file=Notes%2FThe%20Witness.md";
    expect(getDroppedVaultMarkdownFiles(app, dropEvent(url))).toEqual([file]);
  });

  it("resolves a plain vault path from the drop text", () => {
    const file = tfile("Notes/idea.md");
    const app = makeApp({ draggable: null, files: [file] });
    expect(getDroppedVaultMarkdownFiles(app, dropEvent("Notes/idea.md"))).toEqual([file]);
  });

  it("returns an empty list when nothing resolves", () => {
    const app = makeApp({ draggable: null });
    expect(getDroppedVaultMarkdownFiles(app, dropEvent("[[Missing]]"))).toEqual([]);
  });
});

describe("isMarkdownDropFile", () => {
  it("accepts .md and .markdown regardless of case", () => {
    expect(isMarkdownDropFile({ name: "chapter.md", type: "" })).toBe(true);
    expect(isMarkdownDropFile({ name: "OUTLINE.MARKDOWN", type: "" })).toBe(true);
  });

  it("accepts a text/markdown MIME type", () => {
    expect(isMarkdownDropFile({ name: "noext", type: "text/markdown" })).toBe(true);
  });

  it("rejects images and other files", () => {
    expect(isMarkdownDropFile({ name: "photo.png", type: "image/png" })).toBe(false);
    expect(isMarkdownDropFile({ name: "data.json", type: "application/json" })).toBe(false);
  });
});
