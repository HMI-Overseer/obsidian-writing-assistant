import type { ChatRequest } from "../shared/chatRequest";
import type { SamplingParams } from "../shared/types";
import type { CompletionResult, StreamResult } from "./usageTypes";

/** Provider-agnostic chat completion client. */
export interface ChatClient {
  /** Non-streaming completion. Returns the response text and optional usage. */
  complete(
    request: ChatRequest,
    model: string,
    params: SamplingParams,
    signal?: AbortSignal
  ): Promise<CompletionResult>;

  /** Streaming completion. Returns text deltas and a usage promise. */
  stream(
    request: ChatRequest,
    model: string,
    params: SamplingParams,
    signal?: AbortSignal,
    /** Called as soon as the provider identifies a tool call by name, before arguments finish streaming. */
    onToolCallStreaming?: (index: number, name: string) => void,
  ): StreamResult;
}
