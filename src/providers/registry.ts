import type { ProviderOption, ProviderSettingsMap } from "../shared/types";
import type { ChatClient } from "../api/chatClient";
import type { ProviderDescriptor } from "./types";
import { PROVIDER_DESCRIPTORS } from "./descriptors";
import { LMStudioClient } from "../api/LMStudioClient";
import { AnthropicClient } from "../api/AnthropicClient";

export function getProviderDescriptor(id: ProviderOption): ProviderDescriptor {
  return PROVIDER_DESCRIPTORS[id];
}

export function createChatClient(
  provider: ProviderOption,
  providerSettings: ProviderSettingsMap
): ChatClient {
  switch (provider) {
    case "anthropic":
      return new AnthropicClient(providerSettings.anthropic.apiKey);
    case "openai":
      throw new Error("OpenAI provider is not yet supported.");
    case "lmstudio":
      return new LMStudioClient(
        providerSettings.lmstudio.baseUrl,
        providerSettings.lmstudio.bypassCors
      );
    default:
      throw new Error(`Unknown provider: ${provider as string}`);
  }
}
