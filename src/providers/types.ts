import type {
  ProviderOption,
  ProviderTurnCapabilities,
  ReasoningLevel,
} from "../shared/types";

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
}

export interface ProviderDescriptor {
  id: ProviderOption;
  label: string;
  kind: ProviderKind;
  billingModel: BillingModel;
  authType: AuthType;
  defaultContextStrategy: ContextStrategy;
  supportedParams: SamplingParamSupport;
  /**
   * Reasoning levels this provider's models accept, the descriptor-fallback
   * layer of {@link ./reasoningLevels.resolveReasoningLevels} (per-model
   * discovery/catalog data wins where available). Empty array = reasoning
   * unsupported (no UI rendered, nothing sent).
   */
  reasoningLevels: ReasoningLevel[];
  supportsModelDiscovery: boolean;
  supportsToolUse: boolean;
  /** Maximum ordered-turn fidelity. One request may persist a lower actual tier. */
  turnCapabilities: ProviderTurnCapabilities;
  /** null = fixed URL (e.g. Anthropic). Non-null = configurable default. */
  defaultBaseUrl: string | null;
  requiresBaseUrl: boolean;
}
