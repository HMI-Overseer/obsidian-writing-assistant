// The deterministic provider, installed without changing a line of the plugin (RFC-0013).
//
// The seam is still `createChatClient()`, which is the only place all eight callers pass
// through. What changed is how the driver reaches it. It used to be a compile-time-guarded
// branch inside `src/providers/registry.ts`, which meant the instrument owned four call sites in
// production source and a `DEV_DRIVER` define, and meant a scripted run needed a build nobody
// ships.
//
// Instead the driver appends an epilogue to the copy of `main.js` it installs into the scratch
// vault. esbuild emits a flat, unminified CJS bundle, so `createChatClient` is a top-level
// function declaration, and a function declaration is a *mutable binding*: reassigning it from
// the same file scope redirects every call site at once. The same scope is where the ownership
// runtime lives, so the scripted client is built out of the bundle's own
// `createOwnedStreamRun`, `createCaptureBatch`, and `createStreamMetadataGate` rather than a
// reimplementation of them.
//
// What this buys, against the alternative of intercepting `window.fetch`:
//
//   - frames stay provider-neutral facts, so one script drives any provider and RFC unresolved
//     question 1 stays dissolved. Wire-level interception would make every frame per-provider.
//   - Claude Code is reachable. It is a subprocess, not HTTP, so no wire-level route touches it,
//     and Claude Code harness defects are the RFC's own motivating example.
//   - cancellation and capture identity are real: ADR-0032 settlement and ADR-0031 redelivery
//     are the production code paths, not a fake that resolves when asked.
//
// What it costs, stated rather than papered over:
//
//   - it binds to the shape of esbuild's output: flat scope, not minified, these four names.
//     Every one of them is asserted textually before the run launches, so a rename fails the
//     run naming the identifier it could not find. That assertion is the load-bearing part; it
//     is what recovers the property plan decision D3 wanted from the compiler.
//   - the installed artifact is the release artifact *plus* this epilogue, and the manifest says
//     so. Nothing is appended unless a script is armed, so a sandbox run with no script installs
//     the release build untouched.

import { createHash } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";

/**
 * Bundle identifiers the epilogue reaches for. All four are top-level function declarations in
 * the CJS bundle; the assertion below is what turns a rename into a loud failure.
 */
export const REQUIRED_BUNDLE_IDENTIFIERS = [
  "createChatClient",
  "createOwnedStreamRun",
  "createCaptureBatch",
  "createStreamMetadataGate",
];

/**
 * The scripted `ChatClient`, as a self-contained function.
 *
 * Self-contained on purpose: {@link buildEpilogue} ships it by `toString()`, so it may close
 * over nothing but its own parameters. That is also what keeps it testable, because a unit test
 * hands it the *real* production runtime rather than a stand-in, and therefore tests the same
 * function the renderer runs.
 *
 * @param internals the bundle's own ownership runtime.
 * @param script a validated driver script.
 * @param provider the provider the factory was asked for. Carried onto settlement diagnostics so
 *   a scripted run names the provider the app believed it was using.
 */
export function makeScriptedChatClient(internals, script, provider) {
  const { createOwnedStreamRun, createCaptureBatch, createStreamMetadataGate } = internals;
  const DEFAULT_FRAME_DELAY_MS = 40;
  /** Weakest first, so the minimum over a round's identity facts is what it may claim. */
  const CORRELATION_RANK = { none: 0, plugin_id: 1, provider_id: 2 };

  const pause = (ms) =>
    ms <= 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms));

  /**
   * The weakest tool correlation this round's own facts declare, or null when it declares none.
   *
   * Stage 1 hard-coded "none" with a note to refine it once a tool-bearing script existed. This
   * is that refinement, and it is derived rather than asserted: a round that binds every
   * declaration to a provider-supplied id has exactly the correlation evidence an Anthropic or
   * OpenAI translator claims, and a prose-only round still has none.
   */
  const roundCorrelation = (frames) => {
    let weakest = null;
    for (const frame of frames) {
      for (const fact of frame.facts) {
        if (fact.type !== "tool_call_identity") continue;
        const rank = CORRELATION_RANK[fact.correlation] ?? 0;
        if (weakest === null || rank < CORRELATION_RANK[weakest]) weakest = fact.correlation;
      }
    }
    return weakest;
  };

  // One `stream()` call is one round. The cursor advances only when a round ran to its last
  // frame, so a retried attempt that yielded nothing replays the same round rather than skipping
  // it, and an aborted round is not silently consumed.
  let nextRound = 0;

  return {
    complete() {
      return Promise.resolve({ text: script.completionText ?? "", usage: null });
    },

    stream(_request, _model, _params, attempt) {
      const metadata = createStreamMetadataGate();

      async function* source() {
        const index = nextRound;
        const frames = script.rounds[index];
        if (!frames) {
          // Loud, and named. The alternative is replaying round one forever, which spins the
          // agentic loop to its round cap and produces a transcript nobody authored.
          throw new Error(
            `dev/driver scripted provider: the app opened round ${index + 1} of the script ` +
              `"${script.id}", which has ${script.rounds.length}. A round ends at a turn_end ` +
              `fact. Either add the round the app is asking for, or end the last one with no ` +
              `tool call so the agentic loop stops there.`,
          );
        }
        const correlation = roundCorrelation(frames);
        let exhausted = false;
        try {
          for (const frame of frames) {
            // Presentation only: it makes streaming observable in a screenshot rather than
            // instantaneous. No wait in the driver depends on it.
            await pause(frame.delayMs ?? DEFAULT_FRAME_DELAY_MS);
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
          exhausted = true;
        } finally {
          if (exhausted) nextRound = index + 1;
          // Settled here rather than left to the run's own `settleRemaining()`, so the terminal
          // facts a scenario observes are the script's and not the fallbacks. Replay evidence in
          // particular: the gate's fallback is `failedAttemptEvidence()`, whose lowered reason is
          // "stream_attempt_failed_before_commit", and a scripted attempt that ran to its last
          // frame did not fail. A transcript that says otherwise is the exact class of quiet lie
          // this instrument exists to remove.
          //
          // The stop reason is this round's own: a round that binds a tool call stopped for tool
          // use, and one that does not ended the turn. The loop reads it for the truncation guard
          // and the empty-response diagnostics, so a constant here would misreport both.
          metadata.stopReason.settle(correlation === null ? "end_turn" : "tool_use");
          metadata.usage.settle(null);
          metadata.replayCapsule.settle(null);
          metadata.replayEvidence.settle({
            // Authored frames carry a provider message key, so arrival order within a message is
            // real evidence; nothing here can be resumed or replayed cold.
            tier: "textual",
            capabilities: {
              captureOrder: "segment",
              toolCorrelation: correlation ?? "none",
              coldReplay: "textual",
              nativeResume: false,
            },
            loweredReason: "scripted_driver_provider",
          });
        }
      }

      return createOwnedStreamRun({ attempt, provider, open: source, metadata });
    },
  };
}

/**
 * Checks the bundle carries every identifier the epilogue reaches for.
 *
 * Textual, and deliberately anchored to the start of a line, because that is what a flat
 * unminified CJS bundle emits and what stops being true first if the build ever minifies or the
 * name changes. Returns the identifiers it could not find.
 */
export function missingBundleIdentifiers(source) {
  return REQUIRED_BUNDLE_IDENTIFIERS.filter(
    (name) => !new RegExp(`^function ${name}\\(`, "m").test(source),
  );
}

/**
 * The text appended to the installed bundle.
 *
 * A block statement, so its own bindings stay out of the bundle's scope while the assignment to
 * `createChatClient` still lands on the bundle's binding. Inert until a script is armed: with
 * none, the wrapper forwards to the original factory unchanged.
 */
export function buildEpilogue() {
  return `
// ─── appended by dev/driver at seed time (RFC-0013). Not part of any build. ───
{
  // The backstop behind installEpilogue's textual assertion. \`typeof\` on an undeclared name is
  // the one reference form that does not throw, so this reports every missing identifier at once
  // instead of dying on the first.
  const __lmsaMissing = [];
  if (typeof createChatClient !== "function") __lmsaMissing.push("createChatClient");
  if (typeof createOwnedStreamRun !== "function") __lmsaMissing.push("createOwnedStreamRun");
  if (typeof createCaptureBatch !== "function") __lmsaMissing.push("createCaptureBatch");
  if (typeof createStreamMetadataGate !== "function") {
    __lmsaMissing.push("createStreamMetadataGate");
  }
  if (__lmsaMissing.length > 0) {
    throw new Error(
      "dev/driver epilogue: the bundle no longer carries " + __lmsaMissing.join(", ") + ".",
    );
  }

  const __lmsaMakeScriptedChatClient = ${makeScriptedChatClient.toString()};
  const __lmsaOriginalCreateChatClient = createChatClient;

  // A top-level function declaration is a mutable binding, so this one assignment redirects
  // every call site in the bundle. It forwards to the original whenever nothing is armed.
  createChatClient = function (provider, providerSettings, claudeCodeRuntime) {
    const script = globalThis.__lmsaDriverScript;
    if (script) {
      return __lmsaMakeScriptedChatClient(
        { createOwnedStreamRun, createCaptureBatch, createStreamMetadataGate },
        script,
        provider,
      );
    }
    return __lmsaOriginalCreateChatClient(provider, providerSettings, claudeCodeRuntime);
  };

  globalThis.__lmsaDriverEpilogue = true;
}
`;
}

/**
 * Appends the epilogue to an installed bundle, after asserting the bundle's shape.
 *
 * Only ever called on the scratch vault's copy. The repository's own `main.js` is the
 * maintainer's live plugin and is never written to by the driver.
 */
export function installEpilogue(installedMainJs) {
  const source = readFileSync(installedMainJs, "utf8");
  const missing = missingBundleIdentifiers(source);
  if (missing.length > 0) {
    throw new Error(
      `The built main.js no longer carries ${missing.join(", ")} as a top-level function ` +
        `declaration, so the driver cannot install a scripted provider. Either the identifier ` +
        `was renamed, or the build now minifies. Fix dev/driver/lib/scriptedProvider.mjs.`,
    );
  }

  const epilogue = buildEpilogue();
  appendFileSync(installedMainJs, epilogue);
  return {
    identifiers: [...REQUIRED_BUNDLE_IDENTIFIERS],
    epilogueSha256: createHash("sha256").update(epilogue).digest("hex"),
  };
}
