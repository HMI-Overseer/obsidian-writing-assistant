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
  if (tools && tools.length > 0) {
    body.tools = tools;
    // Force one tool call per assistant turn. The in-loop approval gate (ask mode)
    // pauses on each tool call and feeds the user's approve/decline back to the model
    // before it writes the next one; that gate is only a real per-tool gate when a
    // round holds a single call. Without this, a model emitting parallel calls (e.g.
    // five create_directory ops at once) commits to the whole batch up front, so the
    // serial approval UI can no longer let the model respond to feedback between them.
    // Engines that don't honor this OpenAI-compatible field fall back to the round cap.
    body.parallel_tool_calls = false;
  }
  // Opt-in usage accounting: asks OpenAI-compatible endpoints to emit a terminal
  // chunk (empty `choices`, populated `usage`) before [DONE]. Only valid with
  // stream:true; opt-in so endpoints that ignore it (LM Studio) stay untouched.
  if (stream && includeUsage) body.stream_options = { include_usage: true };
  return JSON.stringify(body);
}
