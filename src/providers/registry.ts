import type { ProviderOption, ProviderSettingsMap } from "../shared/types";
import type { ChatClient } from "../api/chatClient";
import type { ProviderDescriptor } from "./types";
import type { CredentialStore } from "./credentials";
import { PROVIDER_DESCRIPTORS } from "./descriptors";
import { LMStudioClient } from "../api/LMStudioClient";
import { AnthropicClient } from "../api/AnthropicClient";
import { OpenAIClient } from "../api/OpenAIClient";
import { ClaudeCodeClient } from "../api/ClaudeCodeClient";
import type { ClaudeCodeRuntime } from "../api/ClaudeCodeClient";

export function getProviderDescriptor(id: ProviderOption): ProviderDescriptor {
  return PROVIDER_DESCRIPTORS[id];
}

export function createChatClient(
  provider: ProviderOption,
  providerSettings: ProviderSettingsMap,
  /** Where keyed providers get their credential. Passed, not reached for, so tests need no global. */
  credentials: CredentialStore,
  /** Extra runtime context only the Claude Code provider needs (vault root, MCP server). */
  claudeCodeRuntime?: ClaudeCodeRuntime
): ChatClient {
  switch (provider) {
    case "anthropic":
      return new AnthropicClient(() => credentials.resolve("anthropic"));
    case "openai":
      return new OpenAIClient(
        () => credentials.resolve("openai"),
        providerSettings.openai.baseUrl
      );
    case "lmstudio":
      return new LMStudioClient(
        providerSettings.lmstudio.baseUrl,
        providerSettings.lmstudio.bypassCors
      );
    case "claudecode":
      return new ClaudeCodeClient(providerSettings.claudecode.claudePath, claudeCodeRuntime);
    default:
      throw new Error(`Unknown provider: ${provider as string}`);
  }
}
