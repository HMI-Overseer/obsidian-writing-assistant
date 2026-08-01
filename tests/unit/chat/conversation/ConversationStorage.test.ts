import { describe, it, expect, vi, beforeEach } from "vitest";
import type { App } from "obsidian";
import { ConversationStorage } from "../../../../src/chat/conversation/ConversationStorage";
import type { Conversation } from "../../../../src/shared/types";

const DIR = "plugin/conversations";
const MAIN = `${DIR}/c1.json`;
const TMP = `${MAIN}.tmp`;

function makeConversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: "c1",
    title: "Hello",
    createdAt: 1,
    updatedAt: 2,
    modelId: "m",
    modelName: "M",
    messages: [],
    draft: "",
    ...overrides,
  };
}

/** In-memory adapter modelling Obsidian's DataAdapter, incl. its non-overwriting rename. */
function makeStorage() {
  const files = new Map<string, string>();
  const dirs = new Set<string>();
  const adapter = {
    write: vi.fn(async (p: string, data: string) => {
      files.set(p, data);
    }),
    read: vi.fn(async (p: string) => {
      const v = files.get(p);
      if (v === undefined) throw new Error(`ENOENT: ${p}`);
      return v;
    }),
    exists: vi.fn(async (p: string) => files.has(p) || dirs.has(p)),
    remove: vi.fn(async (p: string) => {
      files.delete(p);
    }),
    rename: vi.fn(async (from: string, to: string) => {
      if (!files.has(from)) throw new Error(`ENOENT: ${from}`);
      if (files.has(to)) throw new Error(`EEXIST: ${to}`); // adapter.rename does not overwrite
      files.set(to, files.get(from) as string);
      files.delete(from);
    }),
    mkdir: vi.fn(async (p: string) => {
      dirs.add(p);
    }),
  };
  const app = { vault: { adapter } } as unknown as App;
  return { storage: new ConversationStorage(app, "plugin"), files, adapter };
}

describe("ConversationStorage", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("writes through a temp file then swaps it over the target (no half-written live file)", async () => {
    const { storage, files, adapter } = makeStorage();
    await storage.save(makeConversation());

    // Temp written first, then renamed onto the target; no leftover temp.
    expect(adapter.write).toHaveBeenCalledWith(TMP, expect.any(String));
    expect(adapter.rename).toHaveBeenCalledWith(TMP, MAIN);
    expect(files.has(TMP)).toBe(false);
    expect(files.has(MAIN)).toBe(true);
  });

  it("round-trips a saved conversation", async () => {
    const { storage } = makeStorage();
    await storage.save(makeConversation({ title: "Chapter one" }));
    const loaded = await storage.load("c1");
    expect(loaded?.title).toBe("Chapter one");
  });

  it("normalizes legacy revisions during load without eagerly rewriting the file", async () => {
    const { storage, files, adapter } = makeStorage();
    files.set(
      MAIN,
      JSON.stringify(
        makeConversation({
          messages: [
            {
              id: "assistant-1",
              role: "assistant",
              content: "Legacy response.",
            },
          ],
        }),
      ),
    );

    const loaded = await storage.load("c1");

    expect(loaded?.messages[0].revisions?.[0]).toMatchObject({
      kind: "legacy",
      content: "Legacy response.",
    });
    expect(adapter.write).not.toHaveBeenCalled();
    expect(adapter.rename).not.toHaveBeenCalled();
    expect(files.get(MAIN)).not.toContain("\"revisions\"");
  });

  it("overwrites cleanly on re-save, leaving no temp behind", async () => {
    const { storage, files } = makeStorage();
    await storage.save(makeConversation({ title: "v1" }));
    await storage.save(makeConversation({ title: "v2" }));
    expect(files.has(TMP)).toBe(false);
    expect((await storage.load("c1"))?.title).toBe("v2");
  });

  it("returns null for a conversation that was never saved", async () => {
    const { storage } = makeStorage();
    expect(await storage.load("missing")).toBeNull();
  });

  it("recovers from a leftover temp when the swap was interrupted (main missing)", async () => {
    const { storage, files } = makeStorage();
    // Simulate a crash after the temp was written but before/while the rename ran.
    files.set(TMP, JSON.stringify(makeConversation({ title: "recovered" })));

    const loaded = await storage.load("c1");

    expect(loaded?.title).toBe("recovered");
    // The recovered temp is promoted to the live path.
    expect(files.has(MAIN)).toBe(true);
    expect(files.has(TMP)).toBe(false);
  });

  it("recovers from a valid temp when the main file is corrupt", async () => {
    const { storage, files } = makeStorage();
    files.set(MAIN, "{ truncated json");
    files.set(TMP, JSON.stringify(makeConversation({ title: "good copy" })));

    const loaded = await storage.load("c1");

    expect(loaded?.title).toBe("good copy");
  });

  it("distinguishes a corrupt file from a missing one (logs instead of vanishing silently)", async () => {
    const { storage, files } = makeStorage();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    files.set(MAIN, "{ truncated json");

    const loaded = await storage.load("c1");

    expect(loaded).toBeNull();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("corrupt"));
  });

  it("does not log for a plainly missing file", async () => {
    const { storage } = makeStorage();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await storage.load("missing");
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("delete removes both the live file and any leftover temp", async () => {
    const { storage, files } = makeStorage();
    await storage.save(makeConversation());
    files.set(TMP, "leftover");

    await storage.delete("c1");

    expect(files.has(MAIN)).toBe(false);
    expect(files.has(TMP)).toBe(false);
  });
});

/**
 * Two saves of one conversation at the same time (RFC-0013 finding 8).
 *
 * `save()` is write-tmp-then-swap with one tmp path per conversation, and nothing serialised the
 * callers, so two overlapping saves of the same id shared that tmp file. The driver reproduced both
 * halves of the race on the release build: the loser renames onto a destination the winner has
 * already created (`Destination file already exists!`), or finds its own tmp already consumed
 * (`ENOENT: rename '<id>.json.tmp'`).
 *
 * That is not academic. The turn's final persist runs in `generateLlmResponse`'s `finally`, and
 * when it lost this race the rejection skipped `setIsGenerating(false)` and left the composer stuck
 * as a stop button until Obsidian was reloaded.
 *
 * Red-green: every case here was observed failing against the unserialised version.
 */
describe("two saves of the same conversation at once", () => {
  it("neither one fails, whichever order they are started in", async () => {
    const { storage } = makeStorage();
    const results = await Promise.allSettled([
      storage.save(makeConversation({ title: "first" })),
      storage.save(makeConversation({ title: "second" })),
    ]);
    expect(results.map((result) => result.status)).toStrictEqual(["fulfilled", "fulfilled"]);
  });

  it("leaves the live file whole and the temp file gone", async () => {
    const { storage, files } = makeStorage();
    await Promise.all([
      storage.save(makeConversation({ title: "first" })),
      storage.save(makeConversation({ title: "second" })),
    ]);
    expect(files.has(TMP)).toBe(false);
    expect(JSON.parse(files.get(MAIN) as string).title).toBe("second");
  });

  it("runs them one after another rather than interleaving their writes", async () => {
    // The interleaving is the defect itself: write, write, rename, rename cannot work when both
    // writes went to the same temp path.
    const { storage, adapter } = makeStorage();
    const order: string[] = [];
    adapter.write.mockImplementation(async (p: string) => {
      order.push(`write ${p}`);
      await Promise.resolve();
    });
    adapter.rename.mockImplementation(async (from: string, to: string) => {
      order.push(`rename ${from} -> ${to}`);
    });
    await Promise.all([
      storage.save(makeConversation({ title: "first" })),
      storage.save(makeConversation({ title: "second" })),
    ]);
    expect(order).toStrictEqual([
      `write ${TMP}`,
      `rename ${TMP} -> ${MAIN}`,
      `write ${TMP}`,
      `rename ${TMP} -> ${MAIN}`,
    ]);
  });

  it("a failed save does not take the next one down with it", async () => {
    // The queue must not be poisoned: one bad write would otherwise reject every later save of that
    // conversation, which is the same wedge one layer down.
    const { storage, adapter } = makeStorage();
    adapter.write.mockRejectedValueOnce(new Error("disk full"));
    const first = storage.save(makeConversation({ title: "first" }));
    const second = storage.save(makeConversation({ title: "second" }));
    await expect(first).rejects.toThrow(/disk full/);
    await expect(second).resolves.toBeUndefined();
  });

  it("still serialises saves of different conversations independently", async () => {
    const { storage, files } = makeStorage();
    await Promise.all([
      storage.save(makeConversation({ id: "c1", title: "one" })),
      storage.save(makeConversation({ id: "c2", title: "two" })),
    ]);
    expect(JSON.parse(files.get(`${DIR}/c1.json`) as string).title).toBe("one");
    expect(JSON.parse(files.get(`${DIR}/c2.json`) as string).title).toBe("two");
  });
});
