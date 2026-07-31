import type { ProviderOption, ProviderSettingsMap } from "../shared/types";
import type { ChatClient } from "../api/chatClient";
import type { ProviderDescriptor } from "./types";
import { PROVIDER_DESCRIPTORS } from "./descriptors";
import { LMStudioClient } from "../api/LMStudioClient";
import { AnthropicClient } from "../api/AnthropicClient";
import { OpenAIClient } from "../api/OpenAIClient";
import { ClaudeCodeClient } from "../api/ClaudeCodeClient";
import type { ClaudeCodeRuntime } from "../api/ClaudeCodeClient";
import { activeScriptedChatClient } from "../dev/scriptedChatClient";

export function getProviderDescriptor(id: ProviderOption): ProviderDescriptor {
  return PROVIDER_DESCRIPTORS[id];
}

export function createChatClient(
  provider: ProviderOption,
  providerSettings: ProviderSettingsMap,
  /** Extra runtime context only the Claude Code provider needs (vault root, MCP server). */
  claudeCodeRuntime?: ClaudeCodeRuntime
): ChatClient {
  // The live scenario driver's one interception point (RFC-0013). Every call site reaches a
  // provider through this factory, so a scripted run needs no per-caller wiring, and a release
  // build compiles the branch out along with the module behind it.
  if (DEV_DRIVER) {
    const scripted = activeScriptedChatClient(provider);
    if (scripted) return scripted;
  }

  switch (provider) {
    case "anthropic":
      return new AnthropicClient(providerSettings.anthropic.apiKey);
    case "openai":
      return new OpenAIClient(
        providerSettings.openai.apiKey,
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
