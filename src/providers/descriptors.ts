import type { ProviderOption } from "../shared/types";
import type { ProviderDescriptor } from "./types";

const lmstudio: ProviderDescriptor = {
  id: "lmstudio",
  label: "LM Studio",
  kind: "local",
  billingModel: "free",
  authType: "none",
  defaultContextStrategy: "always",
  supportedParams: {
    temperature: true,
    maxTokens: true,
    topP: true,
    topK: true,
    minP: true,
    repeatPenalty: true,
    reasoning: true,
  },
  supportsModelDiscovery: true,
  supportsToolUse: false,
  defaultBaseUrl: "http://localhost:1234/v1",
  requiresBaseUrl: true,
};

const anthropic: ProviderDescriptor = {
  id: "anthropic",
  label: "Anthropic",
  kind: "cloud",
  billingModel: "per-token",
  authType: "api-key",
  defaultContextStrategy: "on-change",
  supportedParams: {
    temperature: true,
    maxTokens: "required",
    topP: true,
    topK: true,
    minP: false,
    repeatPenalty: false,
    reasoning: true,
  },
  supportsModelDiscovery: true,
  supportsToolUse: true,
  defaultBaseUrl: null,
  requiresBaseUrl: false,
};

const openai: ProviderDescriptor = {
  id: "openai",
  label: "OpenAI",
  kind: "cloud",
  billingModel: "per-token",
  authType: "api-key",
  defaultContextStrategy: "on-change",
  supportedParams: {
    temperature: true,
    maxTokens: true,
    topP: true,
    topK: false,
    minP: false,
    repeatPenalty: false,
    reasoning: true,
  },
  supportsModelDiscovery: true,
  supportsToolUse: true,
  defaultBaseUrl: "https://api.openai.com/v1",
  requiresBaseUrl: true,
};

export const PROVIDER_DESCRIPTORS: Record<ProviderOption, ProviderDescriptor> = {
  lmstudio,
  anthropic,
  openai,
};
