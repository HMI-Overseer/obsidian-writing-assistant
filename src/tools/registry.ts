import type { ProviderOption } from "../shared/types";
import { PROVIDER_DESCRIPTORS } from "../providers/descriptors";

export function shouldUseToolCall(
  provider: ProviderOption,
  modelCapabilities?: { trainedForToolUse?: boolean },
): boolean {
  if (provider === "lmstudio") {
    return modelCapabilities?.trainedForToolUse === true;
  }
  return PROVIDER_DESCRIPTORS[provider].supportsToolUse;
}
