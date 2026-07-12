import type { CompletionResult } from "../../src/api/usageTypes";
import type { ChatRequest } from "../../src/shared/chatRequest";
import type { SandboxResponseNormalizer } from "../sandbox/types";

export const TOOL_RESULT_CONTROL_TOKEN_PREFIX = "<|channel>thought\n<channel|>";

function followsToolResult(request: ChatRequest): boolean {
  return request.messages.at(-1)?.role === "tool";
}

export const TOOL_RESULT_CONTROL_TOKEN_PREFIX_NORMALIZER: SandboxResponseNormalizer = {
  id: "tool-result-control-token-prefix",
  version: 1,
  normalize(request: ChatRequest, response: CompletionResult): CompletionResult {
    if (!followsToolResult(request) || !response.text.startsWith(TOOL_RESULT_CONTROL_TOKEN_PREFIX)) {
      return response;
    }
    return {
      ...response,
      text: response.text.slice(TOOL_RESULT_CONTROL_TOKEN_PREFIX.length),
    };
  },
};
