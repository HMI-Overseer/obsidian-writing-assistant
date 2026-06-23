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

function makeHandler(opts: { isGenerating: boolean }) {
  const removeMessage = vi.fn();
  const switchMessageVersion = vi.fn();
  const persistActiveConversation = vi.fn().mockResolvedValue(undefined);
  const getBubbleForMessage = vi.fn().mockReturnValue(null);
  const updateBubbleVersion = vi.fn().mockResolvedValue(undefined);
  const immediateUpdate = vi.fn();
  const syncConversationUi = vi.fn().mockResolvedValue(undefined);

  const snapshot = {
    messageHistory: [
      { id: "m1", role: "user", content: "hello" },
      { id: "m2", role: "assistant", content: "hi there" },
    ],
  };

  const store = {
    getSnapshot: () => snapshot,
    removeMessage,
    switchMessageVersion,
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
    switchMessageVersion,
    getBubbleForMessage,
  };
}

describe("ChatBubbleActionHandler — generation gate (P1-12)", () => {
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
      const { handler, switchMessageVersion } = makeHandler({ isGenerating: true });
      await handler.handleVersionChange("m2", 1);
      expect(switchMessageVersion).not.toHaveBeenCalled();
      expect(vi.mocked(Notice)).toHaveBeenCalledTimes(1);
    });

    it("switches versions when no response is generating", async () => {
      const { handler, switchMessageVersion } = makeHandler({ isGenerating: false });
      await handler.handleVersionChange("m2", 1);
      expect(switchMessageVersion).toHaveBeenCalledWith("m2", 1);
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
});
