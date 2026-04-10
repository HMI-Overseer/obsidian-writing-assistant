import type { ProviderOption } from "../shared/types";
import { PROVIDER_DESCRIPTORS } from "../providers/descriptors";

/**
 * Returns true if the given provider + model combination supports tool/function calling.
 * This is a pure capability check — callers are responsible for gating on `agenticMode`
 * and `preferToolUse` before deciding which tool set to include in a request.
 */
export function shouldUseToolCall(
  provider: ProviderOption,
  modelCapabilities?: { trainedForToolUse?: boolean },
): boolean {
  if (provider === "lmstudio") {
    return modelCapabilities?.trainedForToolUse === true;
  }
  return PROVIDER_DESCRIPTORS[provider].supportsToolUse;
}
