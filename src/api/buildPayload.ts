import type { Message, SamplingParams } from "../shared/types";
import type { OpenAITool } from "../tools/formatters/openai";

/**
 * Build the JSON request body for an OpenAI-compatible chat completion.
 * Extracted as a pure function so it can be unit-tested independently
 * of the HTTP transport layer.
 */
export function buildCompletionPayload(
  model: string,
  messages: Message[],
  params: SamplingParams,
  stream: boolean,
  tools?: OpenAITool[],
  includeUsage?: boolean,
): string {
  const body: Record<string, unknown> = {
    model,
    messages,
    temperature: params.temperature,
    stream,
  };
  if (params.maxTokens !== null) body.max_tokens = params.maxTokens;
  if (params.topP !== null) body.top_p = params.topP;
  if (params.topK !== null) body.top_k = params.topK;
  if (params.minP !== null) body.min_p = params.minP;
  if (params.repeatPenalty !== null) body.repeat_penalty = params.repeatPenalty;
  if (params.reasoning !== null) body.reasoning = params.reasoning;
  if (tools && tools.length > 0) body.tools = tools;
  // Opt-in usage accounting: asks OpenAI-compatible endpoints to emit a terminal
  // chunk (empty `choices`, populated `usage`) before [DONE]. Only valid with
  // stream:true; opt-in so endpoints that ignore it (LM Studio) stay untouched.
  if (stream && includeUsage) body.stream_options = { include_usage: true };
  return JSON.stringify(body);
}
