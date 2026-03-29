import type { ChatRequest } from "../shared/chatRequest";
import type { SamplingParams } from "../shared/types";

/** Provider-agnostic chat completion client. */
export interface ChatClient {
  /** Non-streaming completion. Returns the full response text. */
  complete(
    request: ChatRequest,
    model: string,
    params: SamplingParams,
    signal?: AbortSignal
  ): Promise<string>;

  /** Streaming completion. Yields text deltas. */
  stream(
    request: ChatRequest,
    model: string,
    params: SamplingParams,
    signal?: AbortSignal
  ): AsyncGenerator<string>;
}
