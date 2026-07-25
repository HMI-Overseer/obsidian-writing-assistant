import type { App } from "obsidian";
import { describe, expect, it } from "vitest";
import { fingerprint } from "../../../../src/api/harnessSession";
import { prepareApiMessages } from "../../../../src/chat/finalization/prepareApiMessages";
import type { ChatSessionStore } from "../../../../src/chat/conversation/ChatSessionStore";
import { DEFAULT_SETTINGS } from "../../../../src/constants";
import { MemoryService } from "../../../../src/memory/MemoryService";
import { MEMORY_INDEX_HEADER } from "../../../../src/memory/indexRender";
import type { Memory, PluginSettings } from "../../../../src/shared/types";
import type { VaultOpPolicy } from "../../../../src/vault-ops/gateway";

const DENY_WRITES_POLICY: VaultOpPolicy = {
  create: "deny",
  overwrite: "deny",
  move: "deny",
  trash: "deny",
  createDir: "deny",
  edit: "deny",
  memory: "ask",
  scopes: [],
  maxAutoOps: 50,
};

function memory(overrides: Partial<Memory> = {}): Memory {
  return {
    name: "alpha",
    type: "rule",
    description: "Alpha rule.",
    enabled: true,
    ...overrides,
  };
}

function settings(overrides: Partial<PluginSettings> = {}): PluginSettings {
  return {
    ...DEFAULT_SETTINGS,
    memories: [memory()],
    vaultOpPolicy: { ...DENY_WRITES_POLICY },
    systemPromptPrefix: "Base prefix.",
    ...overrides,
  };
}

function app(): App {
  return {
    workspace: {
      getActiveFile: () => null,
    },
  } as unknown as App;
}

function store(conversationId = "conversation-1"): ChatSessionStore {
  return {
    getActiveConversationId: () => conversationId,
    getSnapshot: () => ({ messageHistory: [] }),
  } as unknown as ChatSessionStore;
}

describe("memory index delivery", () => {
  it("keeps the disabled request byte-identical to the pre-memory request", async () => {
    const currentSettings = settings({ memoriesEnabled: false, agenticMode: false });
    const memoryService = new MemoryService(() => currentSettings.memories);

    const request = await prepareApiMessages({
      app: app(),
      store: store(),
      settings: currentSettings,
      posture: "ask",
      memoryService,
      activeProvider: "anthropic",
      profileSystemPrompt: "Profile prompt.",
    });

    expect(JSON.stringify(request)).toBe(
      '{"systemPrompt":"Profile prompt.","modeTail":"Base prefix.",' +
        '"documentContext":null,"ragContext":null,"messages":[]}',
    );
  });

  it.each([
    {
      label: "a non-agentic cloud turn",
      activeProvider: "anthropic" as const,
      agenticMode: false,
      modelCapabilities: undefined,
      expectedSystemPrefix: "Profile prompt.\n\n",
      expectedModeTail: "Base prefix.",
    },
    {
      label: "a non-tool-trained local model",
      activeProvider: "lmstudio" as const,
      agenticMode: true,
      modelCapabilities: { trainedForToolUse: false },
      expectedSystemPrefix: "Base prefix.\n\nProfile prompt.\n\n",
      expectedModeTail: undefined,
    },
  ])(
    "delivers the index without tools for $label",
    async ({
      activeProvider,
      agenticMode,
      modelCapabilities,
      expectedSystemPrefix,
      expectedModeTail,
    }) => {
      const currentSettings = settings({ memoriesEnabled: true, agenticMode });
      const memoryService = new MemoryService(() => currentSettings.memories);

      const request = await prepareApiMessages({
        app: app(),
        store: store(),
        settings: currentSettings,
        posture: "ask",
        memoryService,
        activeProvider,
        modelCapabilities,
        profileSystemPrompt: "Profile prompt.",
      });

      expect(request.systemPrompt).toBe(
        expectedSystemPrefix +
          MEMORY_INDEX_HEADER +
          '\n{"name":"alpha","type":"rule","description":"Alpha rule."}',
      );
      expect(request.modeTail).toBe(expectedModeTail);
      expect(request.tools).toBeUndefined();
    },
  );

  it("keeps the memory index when built-in prompts are disabled", async () => {
    const currentSettings = settings({ memoriesEnabled: true });
    const memoryService = new MemoryService(() => currentSettings.memories);

    const request = await prepareApiMessages({
      app: app(),
      store: store(),
      settings: currentSettings,
      posture: "ask",
      memoryService,
      activeProvider: "anthropic",
      profileSystemPrompt: "Profile prompt.",
      disableBuiltinSystemPrompts: true,
    });

    expect(request.systemPrompt).toBe(
      "Profile prompt.\n\n" +
        MEMORY_INDEX_HEADER +
        '\n{"name":"alpha","type":"rule","description":"Alpha rule."}',
    );
    expect(request.modeTail).toBeUndefined();
  });

  it("omits the memory block cleanly when no record is enabled", async () => {
    const currentSettings = settings({
      memoriesEnabled: true,
      memories: [memory({ enabled: false })],
      agenticMode: false,
    });
    const memoryService = new MemoryService(() => currentSettings.memories);

    const request = await prepareApiMessages({
      app: app(),
      store: store(),
      settings: currentSettings,
      posture: "ask",
      memoryService,
      activeProvider: "anthropic",
      profileSystemPrompt: "Profile prompt.",
    });

    expect(request.systemPrompt).toBe("Profile prompt.");
    expect(request.modeTail).toBe("Base prefix.");
  });

  it("pins prompt bytes until invalidation and then changes the fingerprint", async () => {
    const currentSettings = settings({ memoriesEnabled: true });
    const memoryService = new MemoryService(() => currentSettings.memories);
    const prepare = () =>
      prepareApiMessages({
        app: app(),
        store: store(),
        settings: currentSettings,
        posture: "ask" as const,
        memoryService,
        activeProvider: "claudecode" as const,
        profileSystemPrompt: "Profile prompt.",
      });

    const first = await prepare();
    currentSettings.memories[0] = memory({ description: "Updated alpha rule." });
    const stillPinned = await prepare();
    memoryService.invalidatePinsContaining("alpha");
    const refreshed = await prepare();
    const configFor = (systemPrompt: string) => ({
      model: "claude-sonnet-4-6",
      systemPrompt,
      agenticMode: false,
      toolNames: [],
    });

    expect(stillPinned.systemPrompt).toBe(first.systemPrompt);
    expect(refreshed.systemPrompt).not.toBe(first.systemPrompt);
    expect(fingerprint(configFor(refreshed.systemPrompt))).not.toBe(
      fingerprint(configFor(first.systemPrompt)),
    );
  });
});
