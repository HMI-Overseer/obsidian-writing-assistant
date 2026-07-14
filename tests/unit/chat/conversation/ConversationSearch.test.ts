import { describe, it, expect, vi } from "vitest";
import {
  ConversationSearch,
  type ConversationSearchDeps,
  normalizeForSearch,
} from "../../../../src/chat/conversation/ConversationSearch";
import type {
  Conversation,
  ConversationMessage,
  ConversationMeta,
} from "../../../../src/shared/types";

function meta(overrides: Partial<ConversationMeta> = {}): ConversationMeta {
  return {
    id: "c1",
    title: "Untitled dragon",
    createdAt: 1,
    updatedAt: 2,
    modelId: "m",
    modelName: "Claude",
    messageCount: 2,
    ...overrides,
  };
}

function message(content: string, overrides: Partial<ConversationMessage> = {}): ConversationMessage {
  return { id: `m-${content.slice(0, 4)}`, role: "user", content, ...overrides };
}

function conversation(id: string, messages: ConversationMessage[]): Conversation {
  return {
    id,
    title: "",
    createdAt: 1,
    updatedAt: 2,
    modelId: "m",
    modelName: "Claude",
    messages,
    draft: "",
    approvalPosture: "ask",
  };
}

/** Build a search with a stubbed active thread and disk store. Returns the search + the load spy. */
function makeSearch(
  overrides: Partial<ConversationSearchDeps> & { store?: Record<string, Conversation> } = {},
) {
  const store = overrides.store ?? {};
  const loadConversation = vi.fn(async (id: string) => store[id] ?? null);
  const deps: ConversationSearchDeps = {
    getActiveId: overrides.getActiveId ?? (() => null),
    getActiveMessages: overrides.getActiveMessages ?? (() => []),
    loadConversation: overrides.loadConversation ?? loadConversation,
  };
  return { search: new ConversationSearch(deps), loadConversation };
}

describe("normalizeForSearch", () => {
  it("lowercases and strips diacritics", () => {
    expect(normalizeForSearch("Café CRÈME")).toBe("cafe creme");
  });

  it("leaves CJK runs intact (no word segmentation)", () => {
    expect(normalizeForSearch("你好世界")).toBe("你好世界");
  });
});

describe("ConversationSearch.search", () => {
  it("returns every meta unchanged for an empty query", async () => {
    const { search, loadConversation } = makeSearch();
    const metas = [meta({ id: "a" }), meta({ id: "b" })];

    const hits = await search.search("   ", metas);

    expect(hits.map((h) => h.meta.id)).toEqual(["a", "b"]);
    expect(hits.every((h) => h.snippet === undefined)).toBe(true);
    // A blank query must never touch disk.
    expect(loadConversation).not.toHaveBeenCalled();
  });

  it("matches the title case- and diacritic-insensitively, without a snippet", async () => {
    const { search, loadConversation } = makeSearch();

    const hits = await search.search("DRAGON", [meta({ title: "Untitled dragón" })]);

    expect(hits).toHaveLength(1);
    expect(hits[0].snippet).toBeUndefined();
    // Title matched, so the body is never loaded.
    expect(loadConversation).not.toHaveBeenCalled();
  });

  it("matches the model name", async () => {
    const { search } = makeSearch();
    const hits = await search.search("claude", [meta({ title: "nothing here" })]);
    expect(hits).toHaveLength(1);
  });

  it("finds a body-only match and returns a snippet with surrounding context", async () => {
    const store = {
      c1: conversation("c1", [
        message("A crimson cathedral rose slowly from the drifting mist beyond the far ridge."),
      ]),
    };
    const { search } = makeSearch({ store });

    const hits = await search.search("cathedral", [meta({ id: "c1", title: "no match", modelName: "no" })]);

    expect(hits).toHaveLength(1);
    expect(hits[0].snippet).toContain("cathedral");
    expect(hits[0].snippet).toContain("crimson");
  });

  it("clips a long body on both sides with an ellipsis", async () => {
    const filler = "word ".repeat(20);
    const store = {
      c1: conversation("c1", [message(`${filler}TARGET${filler}`)]),
    };
    const { search } = makeSearch({ store });

    const hits = await search.search("TARGET", [meta({ id: "c1", title: "no", modelName: "no" })]);

    // The snippet preserves the raw casing of the body for natural display.
    expect(hits[0].snippet).toContain("TARGET");
    expect(hits[0].snippet.startsWith("…")).toBe(true);
    expect(hits[0].snippet.endsWith("…")).toBe(true);
  });

  it("excludes conversations with no match anywhere", async () => {
    const store = { c1: conversation("c1", [message("nothing relevant")]) };
    const { search } = makeSearch({ store });

    const hits = await search.search("unicorn", [meta({ id: "c1", title: "no", modelName: "no" })]);

    expect(hits).toHaveLength(0);
  });

  it("searches the active thread from live memory, never from disk", async () => {
    const { search, loadConversation } = makeSearch({
      getActiveId: () => "c1",
      getActiveMessages: () => [message("an unsaved sentence about wyverns")],
    });

    const hits = await search.search("wyverns", [meta({ id: "c1", title: "no", modelName: "no" })]);

    expect(hits).toHaveLength(1);
    // The active thread's unsaved body was found without any disk read.
    expect(loadConversation).not.toHaveBeenCalled();
  });

  it("ignores error messages in the body", async () => {
    const store = {
      c1: conversation("c1", [message("API failure: boom", { isError: true })]),
    };
    const { search } = makeSearch({ store });

    const hits = await search.search("boom", [meta({ id: "c1", title: "no", modelName: "no" })]);

    expect(hits).toHaveLength(0);
  });

  it("preserves input order in the results", async () => {
    const store = {
      a: conversation("a", [message("shared keyword")]),
      b: conversation("b", [message("shared keyword")]),
    };
    const { search } = makeSearch({ store });

    const hits = await search.search("keyword", [
      meta({ id: "a", title: "no", modelName: "no" }),
      meta({ id: "b", title: "no", modelName: "no" }),
    ]);

    expect(hits.map((h) => h.meta.id)).toEqual(["a", "b"]);
  });
});

describe("ConversationSearch caching", () => {
  it("loads a non-active conversation once across repeated searches", async () => {
    const store = { c1: conversation("c1", [message("a memorable phrase")]) };
    const { search, loadConversation } = makeSearch({ store });
    const metas = [meta({ id: "c1", title: "no", modelName: "no" })];

    await search.search("memorable", metas);
    await search.search("phrase", metas);

    expect(loadConversation).toHaveBeenCalledTimes(1);
  });

  it("re-loads after invalidate(id)", async () => {
    const store = { c1: conversation("c1", [message("a memorable phrase")]) };
    const { search, loadConversation } = makeSearch({ store });
    const metas = [meta({ id: "c1", title: "no", modelName: "no" })];

    await search.search("memorable", metas);
    search.invalidate("c1");
    await search.search("memorable", metas);

    expect(loadConversation).toHaveBeenCalledTimes(2);
  });

  it("re-loads everything after clear()", async () => {
    const store = { c1: conversation("c1", [message("a memorable phrase")]) };
    const { search, loadConversation } = makeSearch({ store });
    const metas = [meta({ id: "c1", title: "no", modelName: "no" })];

    await search.search("memorable", metas);
    search.clear();
    await search.search("memorable", metas);

    expect(loadConversation).toHaveBeenCalledTimes(2);
  });

  it("reflects edited body after invalidation", async () => {
    const store = { c1: conversation("c1", [message("old text")]) };
    const { search } = makeSearch({ store });
    const metas = [meta({ id: "c1", title: "no", modelName: "no" })];

    expect(await search.search("fresh", metas)).toHaveLength(0);

    store.c1 = conversation("c1", [message("fresh text")]);
    // Without invalidation the stale cache still misses.
    expect(await search.search("fresh", metas)).toHaveLength(0);

    search.invalidate("c1");
    expect(await search.search("fresh", metas)).toHaveLength(1);
  });
});
