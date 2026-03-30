import type { ProviderOption } from "../shared/types";

export type ProviderKind = "local" | "cloud";
export type BillingModel = "free" | "per-token";
export type AuthType = "none" | "api-key";
export type ContextStrategy = "always" | "on-change";

export interface SamplingParamSupport {
  temperature: boolean;
  /** true = optional, "required" = must always be sent with a default */
  maxTokens: boolean | "required";
  topP: boolean;
  topK: boolean;
  minP: boolean;
  repeatPenalty: boolean;
  reasoning: boolean;
}

export interface ProviderDescriptor {
  id: ProviderOption;
  label: string;
  kind: ProviderKind;
  billingModel: BillingModel;
  authType: AuthType;
  defaultContextStrategy: ContextStrategy;
  supportedParams: SamplingParamSupport;
  supportsModelDiscovery: boolean;
  supportsToolUse: boolean;
  /** null = fixed URL (e.g. Anthropic). Non-null = configurable default. */
  defaultBaseUrl: string | null;
  requiresBaseUrl: boolean;
}
