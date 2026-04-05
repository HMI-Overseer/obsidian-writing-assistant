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
  return JSON.stringify(body);
}
