import { describe, test, expect, afterEach } from "vitest";
import type { App } from "obsidian";
import { GraphService } from "../../../../src/rag/graph/service";
import type { KnowledgeGraphSettings } from "../../../../src/rag/graph/types";
import type { ExtractionResult, GraphFileMeta } from "../../../../src/rag/graph/types";
import type { CompletionModel, EmbeddingModel, ProviderSettingsMap } from "../../../../src/shared/types";

/** A captured `vault.on(...)` registration we can fire by hand. */
type CapturedHandler = { name: string; handler: (...args: unknown[]) => void };

type FakeFile = { path: string; stat: { mtime: number } };

function makeApp(markdownFiles: FakeFile[] = []): { app: App; handlers: CapturedHandler[] } {
  const handlers: CapturedHandler[] = [];
  const app = {
    vault: {
      on(name: string, handler: (...args: unknown[]) => void) {
        handlers.push({ name, handler });
        return { name };
      },
      offref() {},
      getMarkdownFiles: () => markdownFiles,
      adapter: {
        exists: async () => false,
        read: async () => "",
        write: async () => {},
        remove: async () => {},
      },
    },
  } as unknown as App;
  return { app, handlers };
}

const settings: KnowledgeGraphSettings = {
  enabled: true,
  activeCompletionModelId: "c1",
  activeEmbeddingModelId: "e1",
  excludePatterns: [],
};

const completionModels: CompletionModel[] = [
  { id: "c1", name: "Chat", modelId: "chat-model", provider: "lmstudio" },
];
const embeddingModels: EmbeddingModel[] = [
  { id: "e1", name: "Embed", modelId: "embed-model", provider: "lmstudio" },
];
const providerSettings: ProviderSettingsMap = {
  lmstudio: { baseUrl: "http://localhost:1234", bypassCors: false },
  anthropic: { apiKey: "" },
  openai: { apiKey: "", baseUrl: "" },
  claudecode: { claudePath: "" },
};

function makeMeta(filePath: string, mtime = 1): GraphFileMeta {
  return { filePath, mtime, contentHash: "hash" };
}

function makeExtraction(entities: ExtractionResult["entities"]): ExtractionResult {
  return { entities, relationships: [] };
}

function fire(handlers: CapturedHandler[], name: string, ...args: unknown[]): void {
  const entry = handlers.find((h) => h.name === name);
  if (!entry) throw new Error(`no "${name}" watcher registered`);
  entry.handler(...args);
}

describe("GraphService vault watchers", () => {
  let service: GraphService | null = null;

  afterEach(() => {
    service?.destroy();
    service = null;
  });

  test("a configured graph registers rename and delete watchers", async () => {
    const { app, handlers } = makeApp();
    service = new GraphService(app, "plugin-dir");
    await service.configure(settings, completionModels, embeddingModels, providerSettings);

    expect(handlers.some((h) => h.name === "rename")).toBe(true);
    expect(handlers.some((h) => h.name === "delete")).toBe(true);
  });

  test("a disabled graph is not configured and registers no watchers", async () => {
    const { app, handlers } = makeApp();
    service = new GraphService(app, "plugin-dir");
    await service.configure(
      { ...settings, enabled: false },
      completionModels,
      embeddingModels,
      providerSettings,
    );

    expect(service.getGraph()).toBeNull();
    expect(handlers).toHaveLength(0);
  });

  test("rename re-keys the graph so the entity follows the file", async () => {
    const { app, handlers } = makeApp();
    service = new GraphService(app, "plugin-dir");
    await service.configure(settings, completionModels, embeddingModels, providerSettings);

    const graph = service.getGraph();
    expect(graph).not.toBeNull();
    graph!.addExtractions(
      "Characters/Arden.md",
      makeExtraction([{ name: "Arden", type: "character", description: "A wandering knight" }]),
      makeMeta("Characters/Arden.md"),
    );

    fire(handlers, "rename", { path: "Characters/Aldous.md" }, "Characters/Arden.md");

    expect(graph!.getEntitiesInFile("Characters/Arden.md")).toHaveLength(0);
    expect(graph!.getEntitiesInFile("Characters/Aldous.md")).toHaveLength(1);
  });

  test("delete drops entities sourced only from the removed file", async () => {
    const { app, handlers } = makeApp();
    service = new GraphService(app, "plugin-dir");
    await service.configure(settings, completionModels, embeddingModels, providerSettings);

    const graph = service.getGraph();
    graph!.addExtractions(
      "Characters/Arden.md",
      makeExtraction([{ name: "Arden", type: "character", description: "A wandering knight" }]),
      makeMeta("Characters/Arden.md"),
    );

    fire(handlers, "delete", { path: "Characters/Arden.md" });

    expect(graph!.getEntityCount()).toBe(0);
  });

  test("non-markdown rename/delete events are ignored", async () => {
    const { app, handlers } = makeApp();
    service = new GraphService(app, "plugin-dir");
    await service.configure(settings, completionModels, embeddingModels, providerSettings);

    const graph = service.getGraph();
    graph!.addExtractions(
      "Characters/Arden.md",
      makeExtraction([{ name: "Arden", type: "character", description: "A wandering knight" }]),
      makeMeta("Characters/Arden.md"),
    );

    // A folder rename (no .md extension) must not touch tracked entities.
    fire(handlers, "rename", { path: "Characters" }, "People");
    fire(handlers, "delete", { path: "attachments/cover.png" });

    expect(graph!.getEntityCount()).toBe(1);
  });

  test("shutdown unregisters the watchers (offref called for each)", async () => {
    const offrefCalls: unknown[] = [];
    const { app, handlers } = makeApp();
    (app.vault as unknown as { offref: (ref: unknown) => void }).offref = (ref) =>
      offrefCalls.push(ref);

    service = new GraphService(app, "plugin-dir");
    await service.configure(settings, completionModels, embeddingModels, providerSettings);
    const registered = handlers.length;

    service.shutdown();

    expect(registered).toBeGreaterThan(0);
    expect(offrefCalls).toHaveLength(registered);
  });
});

describe("GraphService.getStaleFileCount", () => {
  let service: GraphService | null = null;

  afterEach(() => {
    service?.destroy();
    service = null;
  });

  test("counts only tracked files whose mtime changed since build", async () => {
    const files: FakeFile[] = [
      { path: "a.md", stat: { mtime: 2 } }, // tracked at mtime 1 → changed
      { path: "b.md", stat: { mtime: 1 } }, // tracked at mtime 1 → unchanged
      { path: "c.md", stat: { mtime: 9 } }, // never tracked → not counted
    ];
    const { app } = makeApp(files);
    service = new GraphService(app, "plugin-dir");
    await service.configure(settings, completionModels, embeddingModels, providerSettings);

    const graph = service.getGraph()!;
    graph.addExtractions("a.md", makeExtraction([{ name: "A", type: "character", description: "x" }]), makeMeta("a.md", 1));
    graph.addExtractions("b.md", makeExtraction([{ name: "B", type: "character", description: "x" }]), makeMeta("b.md", 1));

    expect(service.getStaleFileCount([])).toBe(1);
  });

  test("excluded files are not counted", async () => {
    const files: FakeFile[] = [{ path: "templates/note.md", stat: { mtime: 5 } }];
    const { app } = makeApp(files);
    service = new GraphService(app, "plugin-dir");
    await service.configure(settings, completionModels, embeddingModels, providerSettings);

    const graph = service.getGraph()!;
    graph.addExtractions(
      "templates/note.md",
      makeExtraction([{ name: "T", type: "concept", description: "x" }]),
      makeMeta("templates/note.md", 1),
    );

    expect(service.getStaleFileCount(["templates/**"])).toBe(0);
  });
});
