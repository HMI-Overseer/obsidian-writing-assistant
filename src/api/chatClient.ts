import type { ChatRequest } from "../shared/chatRequest";
import type { SamplingParams } from "../shared/types";
import type {
  AssistantStreamAttemptContext,
  AssistantStreamRun,
} from "./assistantStreamRun";
import type { AssistantStreamEvent, CompletionResult } from "./usageTypes";

/** Provider-agnostic chat completion client. */
export interface ChatClient {
  /** Non-streaming completion. Returns the response text and optional usage. */
  complete(
    request: ChatRequest,
    model: string,
    params: SamplingParams,
    signal?: AbortSignal
  ): Promise<CompletionResult>;

  /**
   * Streaming completion, as one owned attempt.
   *
   * Takes the attempt context rather than a bare signal (RFC-0011 settled decision
   * 13): the lease identity and its cancellation authority are the caller's to
   * allocate, so a provider cannot mint an unrelated identity of its own, and the
   * returned run can be stopped and awaited by whoever owns the turn.
   */
  stream(
    request: ChatRequest,
    model: string,
    params: SamplingParams,
    attempt: AssistantStreamAttemptContext,
  ): AssistantStreamRun<AssistantStreamEvent>;
}
