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

const claudecode: ProviderDescriptor = {
  id: "claudecode",
  label: "Claude Code",
  kind: "cloud",
  billingModel: "per-token",
  authType: "none",
  defaultContextStrategy: "on-change",
  // Claude Code takes no sampling parameters, it runs its own agent harness.
  supportedParams: {
    temperature: false,
    maxTokens: false,
    topP: false,
    topK: false,
    minP: false,
    repeatPenalty: false,
    reasoning: false,
  },
  supportsModelDiscovery: true,
  // Claude Code is tool-centric, so it reports as tool-capable. NOTE: it receives
  // the plugin's tools through the in-process MCP server, NOT via request.tools,
  // `prepareApiMessages` deliberately skips attaching CanonicalToolDefinition tools
  // for this provider so the plugin's own tool loop/timeline stays out of the way.
  supportsToolUse: true,
  defaultBaseUrl: null,
  requiresBaseUrl: false,
};

export const PROVIDER_DESCRIPTORS: Record<ProviderOption, ProviderDescriptor> = {
  lmstudio,
  anthropic,
  openai,
  claudecode,
};

/**
 * Icon id per provider. Lives at the descriptor layer so the Providers tab
 * cards and the chat model selector rail share one source per fact. These are
 * brand logomarks registered into Obsidian's icon library by
 * `registerBrandIcons()` (brandIcons.ts) at plugin load, not Lucide names.
 */
export const PROVIDER_ICONS: Record<ProviderOption, string> = {
  lmstudio: "lmsa-brand-lmstudio",
  anthropic: "lmsa-brand-anthropic",
  openai: "lmsa-brand-openai",
  claudecode: "lmsa-brand-claudecode",
};
