import type { App } from "obsidian";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../../../src/constants";
import { MemoryService } from "../../../src/memory/MemoryService";
import type { McpToolProvider } from "../../../src/mcp/VaultMcpServer";
import {
  ClaudeCodeGenerationHandle,
  ClaudeCodeRunSlot,
  type ClaudeCodeGenerationOwners,
  type ClaudeCodeRuntimeScope,
  type ClaudeCodeToolEvent,
} from "../../../src/services/ClaudeCodeGenerationLease";
import { ClaudeCodeService } from "../../../src/services/ClaudeCodeService";
import type { PluginSettings } from "../../../src/shared/types";
import type { GenerationAuditRecorder } from "../../../src/shared/types";
import type { AskUserResponder } from "../../../src/tools/ask/types";
import type { ToolCall, ToolResult, VaultOpReviewer } from "../../../src/tools/types";
import { DEFAULT_VAULT_OP_POLICY } from "../../../src/vault-ops/gateway";

/**
 * RFC-0011 phase 5: Claude Code callback ownership.
 *
 * The MCP tool provider is created once and captured by the SDK server or the
 * loopback server for the lifetime of the transport it serves. Before phase 5 it
 * read mutable `ClaudeCodeService` fields at call time, so a callback that arrived
 * after generation cleanup, or after a newer generation installed its own owners,
 * was answered by whatever those fields held then. It now reads one
 * {@link ClaudeCodeRunSlot}, and the lease it resolves to is captured
 * synchronously at entry.
 *
 * Every case here uses a controllable promise rather than a sleep, so "in flight"
 * is a state the test holds rather than a race it hopes for.
 */

function app(): App {
  return {
    vault: {
      configDir: ".obsidian",
      getName: () => "Vault",
      getAbstractFileByPath: () => null,
      getFileByPath: () => null,
      getFolderByPath: () => null,
      getAllLoadedFiles: () => [],
      adapter: {},
    },
    workspace: { getActiveFile: () => null },
  } as unknown as App;
}

function settings(): PluginSettings {
  return {
    ...DEFAULT_SETTINGS,
    agenticMode: true,
    memoriesEnabled: true,
    vaultOpPolicy: { ...DEFAULT_VAULT_OP_POLICY },
  };
}

interface ServiceSeam {
  createCallbackProvider(
    handle: ClaudeCodeGenerationHandle,
    slot?: ClaudeCodeRunSlot,
  ): McpToolProvider;
  sessionSlots: Map<string, ClaudeCodeRunSlot>;
  liveHandles: Set<ClaudeCodeGenerationHandle>;
  sdkUsable: Promise<boolean> | null;
}

function scope(overrides: Partial<ClaudeCodeRuntimeScope> = {}): ClaudeCodeRuntimeScope {
  return {
    leaseId: "lease-test",
    conversationId: null,
    posture: "ask",
    allowedTools: new Set([
      "write_file",
      "read",
      "replace_text",
      "ask_user",
      "remember",
    ]),
    activeFilePath: "Notes/active.md",
    correlationPosture: "provider_id",
    ...overrides,
  };
}

function harness() {
  const currentSettings = settings();
  const memoryService = new MemoryService(() => currentSettings.memories);
  const retrieve = vi.fn(async () => []);
  const ragService = {
    isReady: () => true,
    availability: () => "ready",
    retrieve,
  };
  const service = new ClaudeCodeService(
    app(),
    () => currentSettings,
    () => ragService as never,
    () => memoryService,
    async () => undefined,
  );
  const seam = service as unknown as ServiceSeam;
  seam.sdkUsable = Promise.resolve(true);

  /**
   * One callback surface, exactly as an SDK MCP server or the loopback server
   * captures it: one provider closure over one slot, for the lifetime of its
   * transport.
   */
  const surface = (
    overrides: Partial<ClaudeCodeRuntimeScope> = {},
    slot = new ClaudeCodeRunSlot(),
  ) => {
    const handle = new ClaudeCodeGenerationHandle(scope(overrides));
    const provider = seam.createCallbackProvider(handle, slot);
    return { handle, provider, slot };
  };

  return { service, seam, currentSettings, surface, retrieve };
}

function reviewer(label: string, seen: string[]): VaultOpReviewer {
  const resolve = (call: ToolCall): Promise<ToolResult> => {
    seen.push(`${label}:${call.name}`);
    return Promise.resolve({ content: `${label} approved`, isError: false });
  };
  return {
    resolveOne: resolve,
    resolveEditOne: resolve,
    resolveMemoryOne: resolve,
  };
}

function owners(
  overrides: Partial<ClaudeCodeGenerationOwners> = {},
): ClaudeCodeGenerationOwners {
  return {
    review: null,
    askResponder: null,
    askSignal: null,
    lifecycle: null,
    signal: null,
    // No durable audit unless a case installs one: a boundary with no recorder
    // crosses on liveness alone, which is what every phase 5 case asserts.
    audit: null,
    ...overrides,
  };
}

/**
 * A write-ahead recorder the test drives (RFC-0011 phase 6). `held` keeps the
 * store write in flight so "the intent is persisting" is a state the test holds.
 */
function auditRecorder(behaviour: { fail?: Error; held?: Promise<void> } = {}) {
  const order: string[] = [];
  const recorder: GenerationAuditRecorder = {
    recordIntent: async (request) => {
      order.push(`intent:${request.family}:${request.targetId}`);
      if (behaviour.held) await behaviour.held;
      if (behaviour.fail) throw behaviour.fail;
    },
    reconcileIntent: (request) => {
      order.push(`reconcile:${request.family}:${request.targetId}`);
      return Promise.resolve();
    },
  };
  return { recorder, order };
}

function vaultOpCall(id: string): ToolCall {
  return {
    id,
    name: "write_file",
    arguments: { path: "Notes/late.md", content: "late" },
  };
}

/** A promise the test resolves, so "in flight" is held rather than raced. */
function gate() {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

describe("Claude Code callback admission", () => {
  it("answers a callback under the generation that authorized it", async () => {
    const { surface } = harness();
    const seen: string[] = [];
    const { handle, provider } = surface();
    handle.activate(owners({ review: reviewer("run-a", seen) }));

    const result = await provider.callTool(vaultOpCall("toolu_during"));

    expect(seen).toEqual(["run-a:write_file"]);
    expect(result.isError ?? false).toBe(false);
  });

  // Criterion 24, promoted from `it.fails` and fixed here.
  it("refuses a callback that arrives after its generation released its owners", async () => {
    const { surface } = harness();
    const seen: string[] = [];
    const { handle, provider } = surface();
    handle.activate(owners({ review: reviewer("run-a", seen) }));
    await provider.callTool(vaultOpCall("toolu_during"));

    await handle.release();
    const late = await provider.callTool(vaultOpCall("toolu_late"));

    expect(late.isError).toBe(true);
    // The refusal names the closed surface and nothing about any other generation.
    expect(late.content).toContain("no_active_generation");
    expect(seen).toEqual(["run-a:write_file"]);
  });

  // Criterion 27, promoted from `it.fails` and fixed here.
  //
  // The mechanism the original assertion used is gone: there is no service field
  // for a second generation to overwrite. What replaces it is the topology settled
  // decision 17 requires, a surface per provider session or one-shot run, so the
  // claim itself is unchanged and now actually holds.
  it("keeps an old run's callback away from the next generation", async () => {
    const { surface } = harness();
    const seen: string[] = [];
    const runA = surface();
    runA.handle.activate(owners({ review: reviewer("run-a", seen) }));
    await runA.handle.release();

    // Generation B is a different generation on its own surface.
    const runB = surface();
    runB.handle.activate(owners({ review: reviewer("run-b", seen) }));

    await runA.provider.callTool(vaultOpCall("toolu_from_run_a"));

    expect(seen).toEqual([]);
  });

  it("keeps one conversation's surface away from another conversation's generation", async () => {
    const { surface } = harness();
    const seen: string[] = [];
    const alpha = surface({ conversationId: "conversation-alpha" });
    const beta = surface({ conversationId: "conversation-beta" });
    beta.handle.activate(owners({ review: reviewer("beta", seen) }));

    const crossed = await alpha.provider.callTool(vaultOpCall("toolu_alpha"));

    expect(crossed.isError).toBe(true);
    expect(seen).toEqual([]);
  });

  it("refuses a callback that enters before its generation activated", async () => {
    const { surface } = harness();
    const { provider } = surface();

    const early = await provider.callTool(vaultOpCall("toolu_early"));

    expect(early.isError).toBe(true);
    expect(early.content).toContain("no_active_generation");
  });

  it("refuses a callback that arrives after a forced tombstone, forever", async () => {
    const { surface } = harness();
    const seen: string[] = [];
    const { handle, provider } = surface();
    handle.activate(owners({ review: reviewer("run-a", seen) }));

    handle.tombstone();

    for (const id of ["toolu_first", "toolu_second"]) {
      const refused = await provider.callTool(vaultOpCall(id));
      expect(refused.isError).toBe(true);
      expect(refused.content).toContain("generation_tombstoned");
    }
    expect(seen).toEqual([]);
  });
});

describe("Claude Code late admission by tool family", () => {
  const cases: Array<{ family: string; call: ToolCall }> = [
    {
      family: "read",
      call: { id: "toolu_read", name: "read", arguments: { path: "Notes/a.md" } },
    },
    {
      family: "edit",
      call: {
        id: "toolu_edit",
        name: "replace_text",
        arguments: { old_text: "a", new_text: "b" },
      },
    },
    { family: "vault op", call: vaultOpCall("toolu_vault_op") },
    {
      family: "memory mutation",
      call: {
        id: "toolu_memory",
        name: "remember",
        arguments: { title: "T", content: "C" },
      },
    },
    {
      family: "ask",
      call: {
        id: "toolu_ask",
        name: "ask_user",
        arguments: {
          questions: [
            {
              question: "Which?",
              header: "Pick",
              options: [
                { label: "A", description: "a" },
                { label: "B", description: "b" },
              ],
              multiSelect: false,
            },
          ],
        },
      },
    },
  ];

  for (const { family, call } of cases) {
    it(`refuses a late ${family} callback once the generation is stopping`, async () => {
      const { surface } = harness();
      const seen: string[] = [];
      const asked = vi.fn();
      const { handle, provider } = surface();
      const lease = handle.activate(
        owners({
          review: reviewer("run-a", seen),
          askResponder: { ask: asked, cancelPending: vi.fn() } as AskUserResponder,
        }),
      );

      // Stopping, not yet settled: the window a straggler used to slip through.
      void lease.beginStopping();
      const late = await provider.callTool(call);

      expect(late.isError).toBe(true);
      expect(late.content).toContain("generation_stopping");
      expect(seen).toEqual([]);
      expect(asked).not.toHaveBeenCalled();
    });
  }
});

describe("Claude Code in-flight callback accounting", () => {
  it("lets a callback admitted before the stop finish under its own lease", async () => {
    const { surface } = harness();
    const held = gate();
    const { handle, provider } = surface();
    const lease = handle.activate(
      owners({
        review: {
          resolveOne: async () => {
            await held.promise;
            return { content: "run-a approved", isError: false };
          },
          resolveEditOne: vi.fn(),
          resolveMemoryOne: vi.fn(),
        } as unknown as VaultOpReviewer,
      }),
    );

    const pending = provider.callTool(vaultOpCall("toolu_inflight"));
    expect(lease.inFlightCount).toBe(1);

    let releaseDone = false;
    const release = handle.release().then(() => {
      releaseDone = true;
    });
    // A callback already admitted keeps the lease from settling.
    await Promise.resolve();
    expect(releaseDone).toBe(false);
    expect(lease.state).toBe("stopping");

    held.open();
    await expect(pending).resolves.toMatchObject({ content: "run-a approved" });
    await release;
    expect(releaseDone).toBe(true);
    expect(lease.state).toBe("quiescent");
    expect(lease.inFlightCount).toBe(0);
  });

  it("refuses a new callback while an earlier one is still draining", async () => {
    const { surface } = harness();
    const held = gate();
    const seen: string[] = [];
    const { handle, provider } = surface();
    handle.activate(
      owners({
        review: {
          resolveOne: async (call: ToolCall) => {
            seen.push(`run-a:${call.id}`);
            await held.promise;
            return { content: "run-a approved", isError: false };
          },
          resolveEditOne: vi.fn(),
          resolveMemoryOne: vi.fn(),
        } as unknown as VaultOpReviewer,
      }),
    );

    const pending = provider.callTool(vaultOpCall("toolu_first"));
    const release = handle.release();
    const late = await provider.callTool(vaultOpCall("toolu_second"));

    expect(late.isError).toBe(true);
    expect(seen).toEqual(["run-a:toolu_first"]);

    held.open();
    await pending;
    await release;
  });
});

describe("Claude Code effect boundaries", () => {
  it("refuses a vault op at its boundary once the generation is signalled", async () => {
    const { surface } = harness();
    const seen: string[] = [];
    const controller = new AbortController();
    const { handle, provider } = surface();
    const lease = handle.activate(
      owners({ review: reviewer("run-a", seen), signal: controller.signal }),
    );

    controller.abort();
    const stopped = await provider.callTool(vaultOpCall("toolu_after_stop"));

    // Criterion 25: the executor is never reached, so nothing was changed.
    expect(stopped.isError).toBe(true);
    expect(stopped.content).toContain("vault op review");
    expect(seen).toEqual([]);
    expect(lease.consequentialCallbackEntered).toBe(false);
  });

  it("records the boundary a callback actually crossed, and nothing else", async () => {
    const { surface } = harness();
    const seen: string[] = [];
    const { handle, provider } = surface();
    const lease = handle.activate(owners({ review: reviewer("run-a", seen) }));

    await provider.callTool({
      id: "toolu_read",
      name: "read",
      arguments: { path: "Notes/a.md" },
    });
    // Criterion 25 and settled decision 20: read-only vault work has no boundary.
    expect(lease.consequentialCallbackEntered).toBe(false);

    await provider.callTool(vaultOpCall("toolu_write"));

    expect(lease.consequentialCallbackEntered).toBe(true);
    expect([...lease.crossedBoundaries]).toEqual(["vault_op_review"]);
  });

  it("makes the intent durable before the review is reached, and reconciles after", async () => {
    const { surface } = harness();
    const seen: string[] = [];
    const held = gate();
    const audit = auditRecorder({ held: held.promise });
    const { handle, provider } = surface();
    handle.activate(
      owners({
        review: {
          resolveOne: (call: ToolCall) => {
            audit.order.push(`review:${call.name}`);
            return Promise.resolve({ content: "approved", isError: false });
          },
          resolveEditOne: vi.fn(),
          resolveMemoryOne: vi.fn(),
        } as unknown as VaultOpReviewer,
        audit: audit.recorder,
      }),
    );

    const pending = provider.callTool(vaultOpCall("toolu_write"));
    await Promise.resolve();
    // The store write is still in flight, so the review has not been reached.
    expect(audit.order).toEqual(["intent:vault_op:Notes/late.md"]);

    held.open();
    await pending;

    expect(audit.order).toEqual([
      "intent:vault_op:Notes/late.md",
      "review:write_file",
      "reconcile:vault_op:Notes/late.md",
    ]);
    expect(seen).toEqual([]);
  });

  it("refuses the mutation when its intent cannot be made durable", async () => {
    const { surface } = harness();
    const seen: string[] = [];
    const audit = auditRecorder({ fail: new Error("disk full") });
    const { handle, provider } = surface();
    const lease = handle.activate(
      owners({ review: reviewer("run-a", seen), audit: audit.recorder }),
    );

    const refused = await provider.callTool(vaultOpCall("toolu_write"));

    // Settled decision 21: the persist must complete before the effect, so a
    // store failure prevents the effect rather than being reported after it.
    expect(refused.isError).toBe(true);
    expect(refused.content).toContain("vault op review");
    expect(seen).toEqual([]);
    expect(lease.consequentialCallbackEntered).toBe(false);
  });

  it("refuses a stop that lands while the intent is persisting", async () => {
    const { surface } = harness();
    const seen: string[] = [];
    const held = gate();
    const audit = auditRecorder({ held: held.promise });
    const controller = new AbortController();
    const { handle, provider } = surface();
    const lease = handle.activate(
      owners({
        review: reviewer("run-a", seen),
        signal: controller.signal,
        audit: audit.recorder,
      }),
    );

    const pending = provider.callTool(vaultOpCall("toolu_write"));
    await Promise.resolve();
    // Before phase 6 there was no await between the boundary check and the
    // review's own registration, so this window did not exist.
    controller.abort();
    held.open();
    const refused = await pending;

    expect(refused.isError).toBe(true);
    expect(seen).toEqual([]);
    expect(lease.consequentialCallbackEntered).toBe(false);
    // Nothing happened, so the intent is closed rather than left to be read as
    // an unknown outcome.
    expect(audit.order).toEqual([
      "intent:vault_op:Notes/late.md",
      "reconcile:vault_op:Notes/late.md",
    ]);
  });

  it("refuses a mutation whose review owner is absent instead of executing it", async () => {
    const { surface } = harness();
    const { handle, provider } = surface();
    const lease = handle.activate(owners({ review: null }));

    const result = await provider.callTool(vaultOpCall("toolu_no_owner"));

    // The collect-for-later fallback is gone: a mutation with no owner is refused,
    // never routed to an executor the generation did not authorize.
    expect(result.isError).toBe(true);
    expect(result.content).toContain("no review owner");
    expect(lease.consequentialCallbackEntered).toBe(false);
  });

  it("reports a crossed boundary to the turn-run owner exactly once per callback", async () => {
    const { surface } = harness();
    const seen: string[] = [];
    const { handle, provider } = surface();
    const lease = handle.activate(owners({ review: reviewer("run-a", seen) }));
    const notified = vi.fn();
    lease.onConsequentialCallback(notified);
    lease.noteAttempt(2);

    await provider.callTool(vaultOpCall("toolu_write"));

    expect(notified).toHaveBeenCalledTimes(1);
    // The attempt rides the lease as evidence, never as its identity.
    expect(lease.attemptOrdinal).toBe(2);
    expect(lease.context.leaseId).toBe("lease-test");
  });
});

describe("Claude Code lease-owned context", () => {
  it("routes lifecycle events to the lease that admitted the callback", async () => {
    const { surface } = harness();
    const runAEvents: ClaudeCodeToolEvent[] = [];
    const runBEvents: ClaudeCodeToolEvent[] = [];
    const runA = surface();
    runA.handle.activate(
      owners({
        review: reviewer("run-a", []),
        lifecycle: (event) => runAEvents.push(event),
      }),
    );
    const runB = surface();
    runB.handle.activate(
      owners({
        review: reviewer("run-b", []),
        lifecycle: (event) => runBEvents.push(event),
      }),
    );

    await runA.provider.callTool(vaultOpCall("toolu_a"));

    expect(runAEvents.map((event) => event.phase)).toEqual(["start", "end"]);
    expect(runBEvents).toEqual([]);
  });

  it("emits no lifecycle event for a refused callback", async () => {
    const { surface } = harness();
    const events: ClaudeCodeToolEvent[] = [];
    const { handle, provider } = surface();
    handle.activate(
      owners({
        review: reviewer("run-a", []),
        lifecycle: (event) => events.push(event),
      }),
    );
    await handle.release();

    await provider.callTool(vaultOpCall("toolu_late"));

    expect(events).toEqual([]);
  });

  it("reads the active note the generation captured, not the live workspace", async () => {
    const { surface, retrieve } = harness();
    const { handle, provider } = surface({
      activeFilePath: "Notes/captured.md",
      allowedTools: new Set(["semantic_search"]),
    });
    handle.activate(owners());

    await provider.callTool({
      id: "toolu_search",
      name: "semantic_search",
      arguments: { query: "captured" },
    });

    // Criterion 23: the active note is the one the generation captured. The old
    // path re-read `workspace.getActiveFile()` at callback time, which this
    // harness leaves null, so reading it live would pass `undefined` here.
    // The third argument is the per-call result limit, absent because this call
    // named no topK.
    expect(retrieve).toHaveBeenCalledWith("captured", "Notes/captured.md", undefined);
  });

  it("enforces the lease's own allow-list rather than a later generation's", async () => {
    const { surface } = harness();
    const seen: string[] = [];
    const { handle, provider } = surface({ allowedTools: new Set(["read"]) });
    handle.activate(owners({ review: reviewer("run-a", seen) }));

    const refused = await provider.callTool(vaultOpCall("toolu_write"));

    expect(refused.isError).toBe(true);
    expect(refused.content).toContain("not permitted in this session");
    expect(seen).toEqual([]);
  });

  it("lowers observed correlation on the lease, never on the service", async () => {
    const { surface } = harness();
    const { handle, provider } = surface();
    const lease = handle.activate(owners({ review: reviewer("run-a", []) }));
    expect(lease.toolCorrelation).toBe("provider_id");

    await provider.callTool({
      id: "",
      name: "read",
      arguments: { path: "Notes/a.md" },
    });

    expect(lease.toolCorrelation).toBe("none");
    // A later exactly correlated call cannot raise it back.
    await provider.callTool({
      id: "toolu_read",
      name: "read",
      arguments: { path: "Notes/a.md" },
    });
    expect(lease.toolCorrelation).toBe("none");
  });
});

describe("Claude Code run slot", () => {
  it("refuses to hand a surface to a second generation before the first released", () => {
    const first = new ClaudeCodeGenerationHandle(scope());
    const second = new ClaudeCodeGenerationHandle(scope({ leaseId: "lease-second" }));
    const slot = new ClaudeCodeRunSlot();
    first.registerSlot(slot);
    const firstLease = first.activate(owners());

    second.registerSlot(slot);
    const secondLease = second.activate(owners());

    expect(slot.peek()).toBe(firstLease);
    expect(slot.peek()).not.toBe(secondLease);
  });

  it("hands the surface over once the first generation released it", async () => {
    const first = new ClaudeCodeGenerationHandle(scope());
    const second = new ClaudeCodeGenerationHandle(scope({ leaseId: "lease-second" }));
    const slot = new ClaudeCodeRunSlot();
    first.registerSlot(slot);
    first.activate(owners());
    await first.release();

    second.registerSlot(slot);
    const secondLease = second.activate(owners());

    expect(slot.isEmpty).toBe(false);
    expect(slot.peek()).toBe(secondLease);
  });

  it("never hands over a tombstoned surface", async () => {
    const first = new ClaudeCodeGenerationHandle(scope());
    const slot = new ClaudeCodeRunSlot();
    first.registerSlot(slot);
    first.activate(owners());
    first.tombstone();

    const second = new ClaudeCodeGenerationHandle(scope({ leaseId: "lease-second" }));
    second.registerSlot(slot);
    second.activate(owners());

    expect(slot.isTombstoned).toBe(true);
    expect(slot.admit()).toBe("generation_tombstoned");
    // Releasing the newer generation cannot resurrect it either.
    await second.release();
    expect(slot.admit()).toBe("generation_tombstoned");
  });
});

describe("ClaudeCodeService generation handles", () => {
  it("hands each generation its own handle and mutates no run state", async () => {
    const { service } = harness();

    const first = await service.getRuntime("claudecode", {
      posture: "ask",
      activeFilePath: "Notes/first.md",
    });
    const second = await service.getRuntime("claudecode", {
      posture: "auto",
      activeFilePath: "Notes/second.md",
    });

    expect(first?.generation).toBeDefined();
    expect(second?.generation).toBeDefined();
    expect(first?.generation).not.toBe(second?.generation);
    expect(first?.generation?.leaseId).not.toBe(second?.generation?.leaseId);
  });

  it("tombstones a persistent session's surface when its hard dispose runs", async () => {
    const { service, seam } = harness();
    const disposeConversation = vi.fn(() => Promise.resolve());
    (service as unknown as { sessionRegistry: { disposeConversation: unknown } })
      .sessionRegistry = { disposeConversation };
    const slot = new ClaudeCodeRunSlot();
    seam.sessionSlots.set("conversation-1", slot);

    const runtime = await service.getRuntime("claudecode", {
      posture: "ask",
      conversationId: "conversation-1",
    });
    runtime?.generation?.activate(owners());
    await runtime?.sdkSession?.hardDispose();

    // Settled decisions 18 and 15.4: the disposed session's surface refuses
    // forever, and the tombstone dies with that session rather than being kept.
    expect(slot.isTombstoned).toBe(true);
    expect(seam.sessionSlots.has("conversation-1")).toBe(false);
    expect(disposeConversation).toHaveBeenCalledWith("conversation-1");
  });

  it("retires a surface a prior generation never released, rather than sharing it", async () => {
    const { service, seam } = harness();
    const disposeConversation = vi.fn(() => Promise.resolve());
    (service as unknown as { sessionRegistry: { disposeConversation: unknown } })
      .sessionRegistry = { disposeConversation };
    const stale = new ClaudeCodeRunSlot();
    const abandoned = new ClaudeCodeGenerationHandle(scope());
    abandoned.registerSlot(stale);
    abandoned.activate(owners());
    seam.sessionSlots.set("conversation-1", stale);

    await service.getRuntime("claudecode", {
      posture: "ask",
      conversationId: "conversation-1",
    });

    expect(stale.isTombstoned).toBe(true);
    expect(seam.sessionSlots.has("conversation-1")).toBe(false);
    expect(disposeConversation).toHaveBeenCalledWith("conversation-1");
  });

  it("gives a freshly minted session its own surface, already holding the live lease", async () => {
    const { service, seam } = harness();
    let buildOptions:
      | ((controller: AbortController) => unknown)
      | undefined;
    (service as unknown as { sessionRegistry: unknown }).sessionRegistry = {
      runTurnEvents: (_id: string, req: { buildOptions: typeof buildOptions }) => {
        buildOptions = req.buildOptions;
        return (async function* () {})();
      },
    };
    const displaced = new ClaudeCodeRunSlot();
    seam.sessionSlots.set("conversation-1", displaced);

    const runtime = await service.getRuntime("claudecode", {
      posture: "ask",
      conversationId: "conversation-1",
    });
    const lease = runtime?.generation?.activate(owners());
    // Consuming the session's turn is what reaches the option factory, and the
    // factory is what a cold mint runs.
    const frames = runtime?.sdkSession?.run({
      fullPrompt: "full",
      deltaPrompt: "delta",
      model: "claude-test",
      systemPrompt: "",
      reasoning: null,
      turns: [],
    } as never);
    for await (const _frame of frames ?? []) void _frame;
    buildOptions?.(new AbortController());

    const minted = seam.sessionSlots.get("conversation-1");
    expect(minted).toBeDefined();
    expect(minted).not.toBe(displaced);
    expect(minted?.peek()).toBe(lease);
    // The surface the new session displaced belonged to the old one, so it dies
    // with it rather than answering for the new process.
    expect(displaced.isTombstoned).toBe(true);
  });

  it("gives the legacy loopback path a run-scoped server, stopped on release", async () => {
    const { service, seam } = harness();
    seam.sdkUsable = Promise.resolve(false);

    const first = await service.getRuntime("claudecode", { posture: "ask" });
    const second = await service.getRuntime("claudecode", { posture: "ask" });

    // Settled decision 17: no shared service-wide loopback provider across runs.
    expect(first?.mcp?.configJson).toBeDefined();
    expect(second?.mcp?.configJson).toBeDefined();
    expect(first?.mcp?.configJson).not.toBe(second?.mcp?.configJson);

    await first?.generation?.release();
    await second?.generation?.release();
  });

  it("tombstones every live generation on destroy", async () => {
    const { service, seam } = harness();
    (service as unknown as { sessionRegistry: { disposeAll: unknown } }).sessionRegistry = {
      disposeAll: vi.fn(),
    };
    const cancelPending = vi.fn();
    const runtime = await service.getRuntime("claudecode", { posture: "ask" });
    runtime?.generation?.activate(
      owners({
        askResponder: { ask: vi.fn(), cancelPending } as AskUserResponder,
      }),
    );

    service.destroy();

    expect(cancelPending).toHaveBeenCalledWith("destroyed");
    expect(seam.liveHandles.size).toBe(0);
    expect(runtime?.generation?.activeLease?.state).toBe("tombstoned");
  });
});
