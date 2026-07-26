import { describe, it, expect, vi, beforeEach } from "vitest";
import { Notice } from "obsidian";
import {
  ChatBubbleActionHandler,
  type BubbleActionDeps,
} from "../../../src/chat/ChatBubbleActionHandler";

// The generation gate's only observable signal is the warning Notice, so replace
// the no-op mock class with a spyable constructor for this file.
vi.mock("obsidian", async (importOriginal) => {
  const actual = await importOriginal<typeof import("obsidian")>();
  return { ...actual, Notice: vi.fn() };
});

function makeHandler(opts: {
  isGenerating: boolean;
  persist?: () => Promise<void>;
  messages?: Array<{ id: string; role: "user" | "assistant"; content: string }>;
}) {
  const removeMessage = vi.fn();
  const switchMessageRevision = vi.fn();
  const persistActiveConversation = vi.fn(opts.persist ?? (() => Promise.resolve()));
  const getBubbleForMessage = vi.fn().mockReturnValue(null);
  const updateBubbleVersion = vi.fn().mockResolvedValue(undefined);
  const immediateUpdate = vi.fn();
  const syncConversationUi = vi.fn().mockResolvedValue(undefined);

  const snapshot = {
    messageHistory:
      opts.messages ??
      [
        { id: "m1", role: "user" as const, content: "hello" },
        { id: "m2", role: "assistant" as const, content: "hi there" },
      ],
  };

  const store = {
    getSnapshot: () => snapshot,
    removeMessage,
    switchMessageRevision,
    persistActiveConversation,
  };
  const transcript = { getBubbleForMessage, updateBubbleVersion };
  const orchestrator = { getIsGenerating: () => opts.isGenerating };

  const deps = {
    getStore: () => store,
    getTranscript: () => transcript,
    getOrchestrator: () => orchestrator,
    getContextUpdater: () => ({ immediateUpdate }),
    syncConversationUi,
    buildContextInputs: () => ({}),
  } as unknown as BubbleActionDeps;

  return {
    handler: new ChatBubbleActionHandler(deps),
    removeMessage,
    switchMessageRevision,
    getBubbleForMessage,
  };
}

describe("ChatBubbleActionHandler, generation gate (P1-12)", () => {
  beforeEach(() => {
    vi.mocked(Notice).mockClear();
  });

  describe("handleDelete", () => {
    it("refuses to delete a message while a response is generating", async () => {
      const { handler, removeMessage } = makeHandler({ isGenerating: true });
      await handler.handleDelete("m1");
      expect(removeMessage).not.toHaveBeenCalled();
      expect(vi.mocked(Notice)).toHaveBeenCalledTimes(1);
    });

    it("deletes a message when no response is generating", async () => {
      const { handler, removeMessage } = makeHandler({ isGenerating: false });
      await handler.handleDelete("m1");
      expect(removeMessage).toHaveBeenCalledWith("m1");
      expect(vi.mocked(Notice)).not.toHaveBeenCalled();
    });
  });

  describe("handleVersionChange", () => {
    it("refuses to switch versions while a response is generating", async () => {
      const { handler, switchMessageRevision } = makeHandler({ isGenerating: true });
      await handler.handleVersionChange("m2", "revision-2");
      expect(switchMessageRevision).not.toHaveBeenCalled();
      expect(vi.mocked(Notice)).toHaveBeenCalledTimes(1);
    });

    it("switches versions when no response is generating", async () => {
      const { handler, switchMessageRevision } = makeHandler({ isGenerating: false });
      await handler.handleVersionChange("m2", "revision-2");
      expect(switchMessageRevision).toHaveBeenCalledWith(
        "m2",
        "revision-2",
      );
      expect(vi.mocked(Notice)).not.toHaveBeenCalled();
    });
  });

  describe("rejection surfacing via createCallbacks (Phase 6a)", () => {
    const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

    it("surfaces a Notice when a delete rejects, rather than leaving it unhandled", async () => {
      const { handler } = makeHandler({
        isGenerating: false,
        persist: () => Promise.reject(new Error("disk full")),
      });
      const callbacks = handler.createCallbacks();
      // The callback slot is void-returning; a rejecting delete must reach the
      // user as a Notice, not float away as an unhandled rejection.
      callbacks.onDelete("m1");
      await flush();
      expect(vi.mocked(Notice)).toHaveBeenCalled();
    });

    it("shows no Notice when a delete resolves normally", async () => {
      const { handler } = makeHandler({ isGenerating: false });
      handler.createCallbacks().onDelete("m1");
      await flush();
      expect(vi.mocked(Notice)).not.toHaveBeenCalled();
    });
  });

  describe("handleEdit", () => {
    it("refuses to open the inline editor while a response is generating", () => {
      const { handler, getBubbleForMessage } = makeHandler({ isGenerating: true });
      handler.handleEdit("m1");
      expect(getBubbleForMessage).not.toHaveBeenCalled();
      expect(vi.mocked(Notice)).toHaveBeenCalledTimes(1);
    });

    it("proceeds to open the inline editor when no response is generating", () => {
      const { handler, getBubbleForMessage } = makeHandler({ isGenerating: false });
      handler.handleEdit("m1");
      expect(getBubbleForMessage).toHaveBeenCalledWith("m1");
      expect(vi.mocked(Notice)).not.toHaveBeenCalled();
    });
  });

  it("copies all visible prose from the selected assistant revision", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const message = {
      id: "m2",
      role: "assistant" as const,
      content: "stale compatibility text",
      revisions: [
        {
          revisionId: "revision-1",
          kind: "turn" as const,
          origin: "generated" as const,
          createdAt: 1,
          provider: "openai" as const,
          modelId: "gpt-test",
          turn: {
            schemaVersion: 1 as const,
            id: "turn-1",
            status: "completed" as const,
            segments: [{ id: "s1" }],
            items: [
              {
                type: "prose" as const,
                id: "p1",
                segmentId: "s1",
                text: "First visible block.",
              },
              {
                type: "prose" as const,
                id: "p2",
                segmentId: "s1",
                text: "Second visible block.",
              },
            ],
          },
        },
      ],
      activeRevisionId: "revision-1",
    };
    const { handler } = makeHandler({
      isGenerating: false,
      messages: [message],
    });

    handler.handleCopy("m2");
    await Promise.resolve();

    expect(writeText).toHaveBeenCalledWith(
      "First visible block.\n\nSecond visible block.",
    );
    vi.unstubAllGlobals();
  });
});
