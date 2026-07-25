import type { App } from "obsidian";
import { describe, expect, it } from "vitest";
import { prepareApiMessages } from "../../../../src/chat/finalization/prepareApiMessages";
import type { ChatSessionStore } from "../../../../src/chat/conversation/ChatSessionStore";
import { DEFAULT_SETTINGS } from "../../../../src/constants";
import { MemoryService } from "../../../../src/memory/MemoryService";
import type {
  ApprovalPosture,
  PluginSettings,
  ProviderOption,
} from "../../../../src/shared/types";
import { ASK_USER_SYSTEM_GUIDANCE } from "../../../../src/tools/ask/systemPrompt";
import { DEFAULT_VAULT_OP_POLICY, type VaultOpPolicy } from "../../../../src/vault-ops/gateway";

const DENY_ALL: VaultOpPolicy = {
  ...DEFAULT_VAULT_OP_POLICY,
  create: "deny",
  overwrite: "deny",
  move: "deny",
  trash: "deny",
  createDir: "deny",
  edit: "deny",
  memory: "deny",
};

function app(): App {
  return {
    workspace: {
      getActiveFile: () => null,
    },
  } as unknown as App;
}

function store(): ChatSessionStore {
  return {
    getActiveConversationId: () => "conversation-1",
    getSnapshot: () => ({ messageHistory: [] }),
  } as unknown as ChatSessionStore;
}

function settings(
  agenticMode: boolean,
  policy: VaultOpPolicy = DEFAULT_VAULT_OP_POLICY,
): PluginSettings {
  return {
    ...DEFAULT_SETTINGS,
    agenticMode,
    vaultOpPolicy: { ...policy },
    systemPromptPrefix: "Base prefix.",
  };
}

async function prepare(options: {
  provider: ProviderOption;
  agenticMode: boolean;
  posture?: ApprovalPosture;
  policy?: VaultOpPolicy;
  trainedForToolUse?: boolean;
  disableBuiltinSystemPrompts?: boolean;
  anthropicCacheEnabled?: boolean;
}) {
  const currentSettings = settings(options.agenticMode, options.policy);
  return prepareApiMessages({
    app: app(),
    store: store(),
    settings: currentSettings,
    posture: options.posture ?? "ask",
    memoryService: new MemoryService(() => currentSettings.memories),
    activeProvider: options.provider,
    modelCapabilities:
      options.provider === "lmstudio"
        ? { trainedForToolUse: options.trainedForToolUse }
        : undefined,
    disableBuiltinSystemPrompts: options.disableBuiltinSystemPrompts,
    anthropicCacheEnabled: options.anthropicCacheEnabled,
  });
}

describe("ask_user direct request preparation", () => {
  it.each(["anthropic", "openai"] as const)(
    "exposes ask_user only for agentic %s requests",
    async (provider) => {
      const enabled = await prepare({ provider, agenticMode: true });
      const disabled = await prepare({ provider, agenticMode: false });

      expect(enabled.tools?.map((tool) => tool.name)).toContain("ask_user");
      expect(disabled.tools).toBeUndefined();
    },
  );

  it.each([
    { trainedForToolUse: true, present: true },
    { trainedForToolUse: false, present: false },
    { trainedForToolUse: undefined, present: false },
  ])(
    "uses only LM Studio trainedForToolUse=$trainedForToolUse",
    async ({ trainedForToolUse, present }) => {
      const request = await prepare({
        provider: "lmstudio",
        agenticMode: true,
        trainedForToolUse,
      });
      const names = request.tools?.map((tool) => tool.name) ?? [];

      expect(names.includes("ask_user")).toBe(present);
      if (!present) expect(request.tools).toBeUndefined();
    },
  );

  it("keeps ask_user in Anthropic Layer 2 and marks it non-deferred", async () => {
    const request = await prepare({
      provider: "anthropic",
      agenticMode: true,
      anthropicCacheEnabled: true,
    });

    expect(request.tools?.map((tool) => tool.name)).toContain("ask_user");
    expect(request.toolSearch?.nonDeferredToolNames).toContain("ask_user");
  });

  it("keeps ask_user available under every posture and vault policy", async () => {
    for (const posture of ["ask", "auto"] as const) {
      for (const policy of [DEFAULT_VAULT_OP_POLICY, DENY_ALL]) {
        const request = await prepare({
          provider: "anthropic",
          agenticMode: true,
          posture,
          policy,
        });
        expect(request.allowedToolNames).toContain("ask_user");
      }
    }
  });

  it("adds built-in ask guidance only when built-in prompts are enabled", async () => {
    const enabled = await prepare({ provider: "openai", agenticMode: true });
    const disabled = await prepare({
      provider: "openai",
      agenticMode: true,
      disableBuiltinSystemPrompts: true,
    });

    expect(enabled.systemPrompt).toContain(ASK_USER_SYSTEM_GUIDANCE);
    expect(disabled.systemPrompt).not.toContain(ASK_USER_SYSTEM_GUIDANCE);
    expect(disabled.tools?.find((tool) => tool.name === "ask_user")?.description).toBeTruthy();
  });
});
