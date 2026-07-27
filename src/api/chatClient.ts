import type { ChatRequest } from "../shared/chatRequest";
import type { SamplingParams } from "../shared/types";
import type {
  AssistantStreamAttemptContext,
  AssistantStreamRun,
} from "./assistantStreamRun";
import type { CompletionResult } from "./usageTypes";

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
   * Streaming completion, as one owned attempt yielding capture batches.
   *
   * Takes the attempt context rather than a bare signal: the lease identity and
   * its cancellation authority are the caller's to
   * allocate, so a provider cannot mint an unrelated identity of its own, and the
   * returned run can be stopped and awaited by whoever owns the turn (ADR-0032).
   *
   * The unit is one transport frame's worth of facts (ADR-0031). A
   * provider may derive several facts from one frame, but no consumer can observe
   * them outside their batch, which is what lets the turn builder commit or reject
   * a frame whole.
   */
  stream(
    request: ChatRequest,
    model: string,
    params: SamplingParams,
    attempt: AssistantStreamAttemptContext,
  ): AssistantStreamRun;
}
