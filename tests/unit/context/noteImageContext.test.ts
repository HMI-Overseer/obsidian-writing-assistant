import { describe, test, expect } from "vitest";
import { extractEmbeddedImageRefs, resolveNoteImageContext } from "../../../src/context/noteImageContext";
import { MAX_NOTE_CONTEXT_IMAGE_SIZE_BYTES } from "../../../src/constants";

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
  test("extracts wikilink embeds, stripping size and heading suffixes", () => {
    const refs = extractEmbeddedImageRefs("Before ![[map.png|400]] and ![[castle.jpg#crop]]");

    expect(refs).toEqual([
      { target: "map.png" },
      { target: "castle.jpg" },
    ]);
  });

  test("extracts local markdown embeds but never remote URLs", () => {
    const refs = extractEmbeddedImageRefs(
      [
        "![Scene](images/scene.webp)",
        "![Remote](https://example.com/image.png)",
        "![Protocol-relative](//cdn.example.com/x.png)",
      ].join("\n")
    );

    expect(refs).toEqual([{ target: "images/scene.webp" }]);
  });

  test("decodes encoded markdown targets and unwraps angle brackets", () => {
    const refs = extractEmbeddedImageRefs(
      "![A](my%20map.png) ![B](<assets/old map.png>) ![C](/rooted.png) ![D](pic.png#anchor)"
    );

    expect(refs).toEqual([
      { target: "my map.png" },
      { target: "assets/old map.png" },
      { target: "rooted.png" },
      { target: "pic.png" },
    ]);
  });
});

describe("resolveNoteImageContext", () => {
  test("resolves wikilink and markdown embeds through metadataCache and de-duplicates", async () => {
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
      {
        noteFilePath: "notes/Story.md",
        imageFilePath: "notes/images/scene.webp",
        fileName: "scene.webp",
        mimeType: "image/webp",
        data: "BAUG",
      },
    ]);
  });

  test("skips images exceeding the per-image size limit", async () => {
    const noteFile = makeFile("notes/Story.md");
    const hugeFile = makeFile("notes/huge.png");

    const app = {
      metadataCache: {
        getFirstLinkpathDest: (linkpath: string) =>
          linkpath === "huge.png" ? hugeFile : null,
      },
      vault: {
        readBinary: async () =>
          new Uint8Array(MAX_NOTE_CONTEXT_IMAGE_SIZE_BYTES + 1).buffer,
      },
    };

    const result = await resolveNoteImageContext(app as never, [{
      file: noteFile as never,
      rawContent: "![[huge.png]]",
    }]);

    expect(result).toEqual([]);
  });
});
