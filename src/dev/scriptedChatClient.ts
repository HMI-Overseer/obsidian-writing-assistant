import type { ChatRequest } from "../shared/chatRequest";
import type { ProviderOption, SamplingParams } from "../shared/types";
import type { AssistantCaptureBatch } from "../api/assistantCapture";
import { createCaptureBatch } from "../api/assistantCapture";
import type { ChatClient } from "../api/chatClient";
import type {
  AssistantStreamAttemptContext,
  AssistantStreamRun,
} from "../api/assistantStreamRun";
import { createStreamMetadataGate } from "../api/assistantStreamRun";
import { createOwnedStreamRun } from "../api/assistantStreamRuntime";
import type { CompletionResult } from "../api/usageTypes";
import type { DriverScript } from "./driverScript";
import { DRIVER_FRAME_DELAY_MS } from "./driverScript";

/**
 * The deterministic provider the live scenario driver installs (RFC-0013).
 *
 * It goes through {@link createOwnedStreamRun} and {@link createCaptureBatch} rather than
 * around them, which is the whole reason this is the right seam. Two properties follow:
 *
 * - Cancellation is real. `run.cancel(reason)` and the attempt's lease signal behave exactly as
 *   ADR-0032 specifies, so an abort-mid-turn scenario exercises settlement instead of a fake
 *   that resolves when asked.
 * - Capture identity is real. Frames carry a provider-sourced `frameKey`, so ADR-0031
 *   redelivery and conflict handling are live and a script can drive them.
 *
 * A hand-rolled fake would have to reimplement both, and would then be evidence about itself.
 */

function pause(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

export class ScriptedChatClient implements ChatClient {
  /**
   * @param provider the provider the factory was asked for. Carried onto settlement
   *   diagnostics so a scripted run names the provider the app believed it was using, rather
   *   than a fixed label that would be wrong for every scenario but one.
   */
  constructor(
    private readonly script: DriverScript,
    private readonly provider: ProviderOption,
  ) {}

  complete(): Promise<CompletionResult> {
    return Promise.resolve({
      text: this.script.completionText ?? "",
      usage: null,
    });
  }

  stream(
    _request: ChatRequest,
    _model: string,
    _params: SamplingParams,
    attempt: AssistantStreamAttemptContext,
  ): AssistantStreamRun {
    const metadata = createStreamMetadataGate();
    const script = this.script;

    async function* source(): AsyncGenerator<AssistantCaptureBatch> {
      try {
        for (const frame of script.frames) {
          await pause(frame.delayMs ?? DRIVER_FRAME_DELAY_MS);
          yield createCaptureBatch({
            leaseId: attempt.leaseId,
            frameKey: frame.frameKey,
            // Authored keys stand in for wire identity, so a repeated key is a scripted
            // redelivery rather than ordinary repeated content (ADR-0031).
            frameKeySource: "provider",
            facts: frame.facts,
            ...(frame.providerMessageKey === undefined
              ? {}
              : { providerMessageKey: frame.providerMessageKey }),
            ...(frame.supersedes === undefined ? {} : { supersedes: frame.supersedes }),
          });
        }
      } finally {
        // Settled here rather than left to the run's own `settleRemaining()`, so the terminal
        // facts a scenario observes are the script's and not the fallbacks. Replay evidence in
        // particular: the gate's fallback is `failedAttemptEvidence()`, whose lowered reason is
        // "stream_attempt_failed_before_commit", and a scripted attempt that ran to its last
        // frame did not fail. A transcript that says otherwise is the exact class of quiet lie
        // this instrument exists to remove.
        metadata.stopReason.settle("end_turn");
        metadata.usage.settle(null);
        metadata.replayCapsule.settle(null);
        metadata.replayEvidence.settle({
          // Authored frames carry a provider message key, so arrival order within a message is
          // real evidence; nothing here can be resumed or replayed cold. Tool correlation is
          // declared absent rather than inferred, which understates a script that emits
          // `tool_call_identity`; refine it when a tool-bearing script exists to refine against.
          tier: "textual",
          capabilities: {
            captureOrder: "segment",
            toolCorrelation: "none",
            coldReplay: "textual",
            nativeResume: false,
          },
          loweredReason: "scripted_driver_provider",
        });
      }
    }

    return createOwnedStreamRun({
      attempt,
      provider: this.provider,
      open: source,
      metadata,
    });
  }
}

/**
 * The script the next {@link ../providers/registry.createChatClient} call answers with.
 *
 * It stays installed until replaced or cleared, so a multi-turn scenario replays the same
 * script per turn without re-arming between them.
 */
let installedScript: DriverScript | null = null;

export function installScriptedProvider(script: DriverScript | null): void {
  installedScript = script;
}

/** The scripted client to use, or null when no script is installed. */
export function activeScriptedChatClient(provider: ProviderOption): ChatClient | null {
  return installedScript ? new ScriptedChatClient(installedScript, provider) : null;
}

/** The installed script's id, for the run manifest. */
export function installedScriptId(): string | null {
  return installedScript?.id ?? null;
}
