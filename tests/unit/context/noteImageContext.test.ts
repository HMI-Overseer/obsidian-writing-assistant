import { describe, test, expect } from "vitest";
import { extractEmbeddedImageRefs, resolveNoteImageContext } from "../../../src/context/noteImageContext";

function makeFile(path: string) {
  const parts = path.split("/");
  const name = parts[parts.length - 1];
  const dot = name.lastIndexOf(".");
  return {
    path,
    name,
    extension: dot >= 0 ? name.slice(dot + 1) : "",
    parent: parts.length > 1 ? { path: parts.slice(0, -1).join("/") } : null,
  };
}

describe("extractEmbeddedImageRefs", () => {
  test("preserves embed order across wikilinks and markdown images", () => {
    const refs = extractEmbeddedImageRefs(
      "Before ![[map.png|400]] middle ![Scene](images/scene.webp) after"
    );

    expect(refs).toEqual([
      { kind: "wikilink", target: "map.png" },
      { kind: "markdown", target: "images/scene.webp" },
    ]);
  });
});

describe("resolveNoteImageContext", () => {
  test("resolves local note images, skips remote links, and de-duplicates repeats", async () => {
    const noteFile = makeFile("notes/Story.md");
    const mapFile = makeFile("notes/map.png");
    const sceneFile = makeFile("notes/images/scene.webp");

    const binaryByPath = new Map<string, Uint8Array>([
      [mapFile.path, new Uint8Array([1, 2, 3])],
      [sceneFile.path, new Uint8Array([4, 5, 6])],
    ]);

    const app = {
      metadataCache: {
        getFirstLinkpathDest: (linkpath: string, sourcePath: string) => {
          if (sourcePath !== noteFile.path) return null;
          if (linkpath === "map.png") return mapFile;
          if (linkpath === "images/scene.webp") return sceneFile;
          if (linkpath === "notes/images/scene.webp") return sceneFile;
          return null;
        },
      },
      vault: {
        readBinary: async (file: { path: string }) =>
          binaryByPath.get(file.path)?.buffer ?? new ArrayBuffer(0),
        getFileByPath: (path: string) => {
          if (path === mapFile.path) return mapFile;
          if (path === sceneFile.path) return sceneFile;
          return null;
        },
      },
    };

    const result = await resolveNoteImageContext(app as never, [{
      file: noteFile as never,
      rawContent: [
        "![[map.png]]",
        "![Scene](images/scene.webp)",
        "![Remote](https://example.com/image.png)",
        "![[map.png]]",
      ].join("\n"),
    }]);

    expect(result).toEqual([
      {
        noteFilePath: "notes/Story.md",
        imageFilePath: "notes/map.png",
        fileName: "map.png",
        mimeType: "image/png",
        data: "AQID",
      },
      {
        noteFilePath: "notes/Story.md",
        imageFilePath: "notes/images/scene.webp",
        fileName: "scene.webp",
        mimeType: "image/webp",
        data: "BAUG",
      },
    ]);
  });
});
