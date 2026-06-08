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
  test("extracts only Obsidian image embeds", () => {
    const refs = extractEmbeddedImageRefs(
      "Before ![[map.png|400]] middle ![Scene](images/scene.webp) after"
    );

    expect(refs).toEqual([
      { target: "map.png" },
    ]);
  });
});

describe("resolveNoteImageContext", () => {
  test("resolves only Obsidian local image embeds and de-duplicates repeats", async () => {
    const noteFile = makeFile("notes/Story.md");
    const mapFile = makeFile("notes/map.png");

    const binaryByPath = new Map<string, Uint8Array>([
      [mapFile.path, new Uint8Array([1, 2, 3])],
    ]);

    const app = {
      metadataCache: {
        getFirstLinkpathDest: (linkpath: string, sourcePath: string) => {
          if (sourcePath !== noteFile.path) return null;
          if (linkpath === "map.png") return mapFile;
          return null;
        },
      },
      vault: {
        readBinary: async (file: { path: string }) =>
          binaryByPath.get(file.path)?.buffer ?? new ArrayBuffer(0),
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
    ]);
  });
});
