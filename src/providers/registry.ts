import type { ProviderOption, ProviderSettingsMap } from "../shared/types";
import type { ChatClient } from "../api/chatClient";
import type { ProviderDescriptor } from "./types";
import { PROVIDER_DESCRIPTORS } from "./descriptors";
import { LMStudioClient } from "../api/LMStudioClient";
import { AnthropicClient } from "../api/AnthropicClient";
import { OpenAIClient } from "../api/OpenAIClient";

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
      return new OpenAIClient(
        providerSettings.openai.apiKey,
        providerSettings.openai.baseUrl
      );
    case "lmstudio":
      return new LMStudioClient(
        providerSettings.lmstudio.baseUrl,
        providerSettings.lmstudio.bypassCors
      );
    default:
      throw new Error(`Unknown provider: ${provider as string}`);
  }
}
