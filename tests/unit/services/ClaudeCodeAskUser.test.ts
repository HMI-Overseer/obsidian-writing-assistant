import * as http from "http";
import type { App } from "obsidian";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildVaultSdkTools } from "../../../src/api/sdk/sdkMcpServer";
import type {
  ComposerInteraction,
  ComposerInteractionHostPort,
} from "../../../src/chat/interactions/ComposerInteractionHost";
import { AskInteractionCoordinator } from "../../../src/chat/interactions/AskInteractionCoordinator";
import { DEFAULT_SETTINGS } from "../../../src/constants";
import { MemoryService } from "../../../src/memory/MemoryService";
import { VaultMcpServer, type McpToolProvider } from "../../../src/mcp/VaultMcpServer";
import {
  ClaudeCodeGenerationHandle,
  type ClaudeCodeGenerationLease,
  type ClaudeCodeGenerationOwners,
  type ClaudeCodeToolEvent,
} from "../../../src/services/ClaudeCodeGenerationLease";
import { ClaudeCodeService } from "../../../src/services/ClaudeCodeService";
import type { PluginSettings } from "../../../src/shared/types";
import type { AskAnswers, AskUserResponder } from "../../../src/tools/ask/types";
import type { ToolCall, ToolResult, VaultOpReviewer } from "../../../src/tools/types";
import { DEFAULT_VAULT_OP_POLICY } from "../../../src/vault-ops/gateway";

const question = "Which format should I use?";
const askArguments = {
  questions: [
    {
      question,
      header: "Output",
      options: [
        { label: "Concise", description: "Keep it short." },
        { label: "Detailed", description: "Include rationale." },
      ],
      multiSelect: false,
    },
  ],
};

function app(): App {
  return {
    vault: {
      configDir: ".obsidian",
      getName: () => "Vault",
      getAbstractFileByPath: () => null,
    },
    workspace: {
      getActiveFile: () => null,
    },
  } as unknown as App;
}

function settings(): PluginSettings {
  return {
    ...DEFAULT_SETTINGS,
    agenticMode: true,
    memoriesEnabled: false,
    vaultOpPolicy: { ...DEFAULT_VAULT_OP_POLICY },
  };
}

interface ClaudeCodeAskTestSeam {
  createCallbackProvider(handle: ClaudeCodeGenerationHandle): McpToolProvider;
  sdkUsable: Promise<boolean> | null;
  sessionRegistry: { disposeAll(): void };
}

/**
 * One callback surface for one generation (RFC-0011 phase 5). The allow-list is
 * sealed before any callback can enter; the ask responder, the review owner, and
 * the lifecycle sink are installed once, at activation.
 */
function harness(allowedTools: string[] = []) {
  const currentSettings = settings();
  let ragReady = false;
  const memoryService = new MemoryService(() => currentSettings.memories);
  const service = new ClaudeCodeService(
    app(),
    () => currentSettings,
    () => ({ isReady: () => ragReady }) as never,
    () => memoryService,
    async () => undefined,
  );
  const seam = service as unknown as ClaudeCodeAskTestSeam;
  seam.sdkUsable = Promise.resolve(true);
  const handle = new ClaudeCodeGenerationHandle({
    leaseId: "lease-ask-test",
    conversationId: null,
    posture: "ask",
    allowedTools: new Set(allowedTools),
    activeFilePath: "",
    correlationPosture: "provider_id",
  });
  const provider = seam.createCallbackProvider(handle);
  const activate = (
    owners: Partial<ClaudeCodeGenerationOwners> = {},
  ): ClaudeCodeGenerationLease =>
    handle.activate({
      review: null,
      askResponder: null,
      askSignal: null,
      lifecycle: null,
      signal: null,
      ...owners,
    });
  return {
    currentSettings,
    service,
    seam,
    handle,
    provider,
    activate,
    setRagReady: (ready: boolean) => {
      ragReady = ready;
    },
  };
}

function call(name: string, arguments_: Record<string, unknown>, id = "mcp-call"): ToolCall {
  return { id, name, arguments: arguments_ };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

class FakeInteractionHost implements ComposerInteractionHostPort {
  interaction: ComposerInteraction | null = null;
  private mountedResolve: (() => void) | null = null;

  mount(interaction: ComposerInteraction): boolean {
    this.interaction = interaction;
    this.mountedResolve?.();
    this.mountedResolve = null;
    return true;
  }

  clearIfOwner(interactionId: string): void {
    if (this.interaction?.interactionId === interactionId) {
      this.interaction = null;
    }
  }

  isActive(interactionId?: string): boolean {
    return Boolean(
      this.interaction &&
      (interactionId === undefined || this.interaction.interactionId === interactionId),
    );
  }

  destroy(): void {
    this.interaction = null;
  }

  waitForMount(): Promise<void> {
    if (this.interaction) return Promise.resolve();
    return new Promise((resolve) => {
      this.mountedResolve = resolve;
    });
  }

  submit(answers: AskAnswers): void {
    this.interaction?.onSubmit(answers);
  }
}

function postToolCall(
  handle: { url: string; token: string },
  name: string,
  arguments_: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const endpoint = new URL(handle.url);
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: "legacy-ask",
    method: "tools/call",
    params: { name, arguments: arguments_ },
  });
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        hostname: endpoint.hostname,
        port: endpoint.port,
        path: endpoint.pathname,
        method: "POST",
        headers: {
          Authorization: `Bearer ${handle.token}`,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
        });
      },
    );
    request.on("error", reject);
    request.end(body);
  });
}

describe("ClaudeCodeService ask_user", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("advertises ask_user exactly once across stable runtime combinations", async () => {
    const { currentSettings, service, provider, setRagReady } = harness();
    // The catalogue is the constant stable superset, so it is invariant across
    // every combination below; the run's allow-list is what varies, and it is
    // enforced at the callback surface rather than by shrinking this list.
    const policies = [
      { ...DEFAULT_VAULT_OP_POLICY },
      {
        create: "deny",
        overwrite: "deny",
        move: "deny",
        trash: "deny",
        createDir: "deny",
        edit: "deny",
        memory: "deny",
      },
    ] as const;

    for (const memoriesEnabled of [false, true]) {
      currentSettings.memoriesEnabled = memoriesEnabled;
      for (const ragReady of [false, true]) {
        setRagReady(ragReady);
        for (const posture of ["ask", "auto"] as const) {
          for (const policy of policies) {
            currentSettings.vaultOpPolicy = { ...policy };
            await service.getRuntime("claudecode", { posture });
            expect(
              provider.listTools().filter((tool) => tool.name === "ask_user"),
            ).toHaveLength(1);
          }
        }
      }
    }
  });

  it("allows ask_user only on agentic Claude Code runs", async () => {
    const { currentSettings, service } = harness();
    const allowedFor = async (): Promise<ReadonlySet<string>> => {
      const runtime = await service.getRuntime("claudecode", { posture: "ask" });
      const lease = runtime?.generation?.activate({
        review: null,
        askResponder: null,
        askSignal: null,
        lifecycle: null,
        signal: null,
      });
      return lease?.context.allowedTools ?? new Set<string>();
    };

    currentSettings.agenticMode = true;
    expect((await allowedFor()).has("ask_user")).toBe(true);

    currentSettings.agenticMode = false;
    expect((await allowedFor()).has("ask_user")).toBe(false);
  });

  it("claims the latch synchronously and refuses callbacks that enter later", async () => {
    const { provider, activate } = harness(["ask_user", "create_directory"]);
    const answers = deferred<AskAnswers>();
    const asked = deferred<void>();
    const responder: AskUserResponder = {
      ask: vi.fn(() => {
        asked.resolve();
        return answers.promise;
      }),
      cancelPending: vi.fn(),
    };
    const resolveOne = vi.fn(async (): Promise<ToolResult> => ({
      content: "Created directory.",
      isReadOnly: false,
    }));
    const lease = activate({
      askResponder: responder,
      review: {
        resolveOne,
        resolveEditOne: vi.fn(),
        resolveMemoryOne: vi.fn(),
      } as unknown as VaultOpReviewer,
    });

    const pendingAsk = provider.callTool(call("ask_user", askArguments, "ask-1"));

    // The barrier is still claimed synchronously, which is what makes a sibling
    // arriving in the same tick a skipped sibling rather than a second question.
    expect(lease.askPending).toBe(true);
    // The interaction itself now opens one durable-intent write later: since
    // RFC-0011 phase 6 the ask crosses an effect boundary first, so this awaits
    // the responder's own signal rather than assuming the same tick.
    await asked.promise;
    expect(responder.ask).toHaveBeenCalledTimes(1);

    const blockedTool = await provider.callTool(
      call("create_directory", { path: "Drafts" }, "write-1"),
    );
    const repeatedAsk = await provider.callTool(
      call("ask_user", askArguments, "ask-2"),
    );

    expect(blockedTool.failure?.kind).toBe("precondition");
    expect(blockedTool.content).toContain("ask_sibling_skipped");
    expect(repeatedAsk.failure?.kind).toBe("precondition");
    expect(repeatedAsk.content).toContain("ask_concurrent");
    expect(resolveOne).not.toHaveBeenCalled();

    answers.resolve({ [question]: "Detailed" });
    await expect(pendingAsk).resolves.toMatchObject({
      content: JSON.stringify({ answers: { [question]: "Detailed" } }),
      isReadOnly: true,
    });
    expect(lease.askPending).toBe(false);

    await expect(
      provider.callTool(call("create_directory", { path: "Drafts" }, "write-2")),
    ).resolves.toMatchObject({ content: "Created directory." });
    expect(resolveOne).toHaveBeenCalledTimes(1);
  });

  it("returns the canonical validation failure without mounting a form", async () => {
    const { provider, activate } = harness(["ask_user"]);
    const host = new FakeInteractionHost();
    const coordinator = new AskInteractionCoordinator(host, new AbortController().signal);
    const lease = activate({ askResponder: coordinator });

    const result = await provider.callTool(
      call("ask_user", { questions: [] }, "invalid-ask"),
    );

    expect(result.failure?.kind).toBe("invalid-args");
    expect(result.content).toContain("questions_count");
    expect(host.interaction).toBeNull();
    expect(lease.askPending).toBe(false);
    coordinator.destroy();
  });

  it("abort and generation cleanup clear the form, promise, responder, and latch", async () => {
    const { handle, provider, activate } = harness(["ask_user"]);
    const host = new FakeInteractionHost();
    const abortController = new AbortController();
    const coordinator = new AskInteractionCoordinator(host, abortController.signal);
    const events: ClaudeCodeToolEvent[] = [];
    const lease = activate({
      askResponder: coordinator,
      askSignal: abortController.signal,
      signal: abortController.signal,
      lifecycle: (event) => events.push(event),
    });

    const pending = provider.callTool(call("ask_user", askArguments, "abort-ask"));
    await host.waitForMount();
    abortController.abort();
    const result = await pending;
    coordinator.destroy();
    await handle.release();

    expect(result.content).toContain("ask_cancelled");
    expect(host.interaction).toBeNull();
    expect(coordinator.hasPending()).toBe(false);
    expect(lease.state).toBe("quiescent");
    expect(lease.askPending).toBe(false);
    expect(events.at(-1)).toMatchObject({
      phase: "end",
      toolName: "ask_user",
      askStatus: "cancelled",
    });
  });

  it("refuses a legacy ask callback without mounting a form or latch", async () => {
    const { provider, activate } = harness(["ask_user"]);
    const host = new FakeInteractionHost();
    const abortController = new AbortController();
    const coordinator = new AskInteractionCoordinator(host, abortController.signal);
    const lease = activate({
      askResponder: coordinator,
      askSignal: abortController.signal,
    });
    const server = new VaultMcpServer("writing_assistant", provider);
    const serverHandle = await server.start();

    try {
      const response = await postToolCall(serverHandle, "ask_user", askArguments);

      expect(response).toMatchObject({
        result: {
          isError: true,
        },
      });
      expect(JSON.stringify(response)).toContain("exact provider correlation");
      expect(host.interaction).toBeNull();
      expect(coordinator.hasPending()).toBe(false);
      expect(lease.askPending).toBe(false);
    } finally {
      server.stop();
      coordinator.destroy();
    }
  });

  it("routes an exactly correlated SDK call and refuses legacy loopback", async () => {
    const { provider, activate } = harness(["ask_user"]);
    const host = new FakeInteractionHost();
    const coordinator = new AskInteractionCoordinator(host, new AbortController().signal);
    const lease = activate({ askResponder: coordinator });

    const sdkAsk = buildVaultSdkTools(provider).find((tool) => tool.name === "ask_user");
    expect(sdkAsk).toBeDefined();
    const sdkPending = sdkAsk!.handler(askArguments, {
      _meta: {
        "claudecode/toolUseId": "toolu-sdk-ask",
      },
    });
    await host.waitForMount();
    host.submit({ [question]: "Concise" });
    await expect(sdkPending).resolves.toMatchObject({
      content: [
        {
          type: "text",
          text: JSON.stringify({ answers: { [question]: "Concise" } }),
        },
      ],
    });

    const server = new VaultMcpServer("writing_assistant", provider);
    const serverHandle = await server.start();
    try {
      const response = await postToolCall(serverHandle, "ask_user", askArguments);
      expect(response).toMatchObject({
        result: {
          isError: true,
        },
      });
      expect(JSON.stringify(response)).toContain("exact provider correlation");
    } finally {
      server.stop();
      coordinator.destroy();
    }

    expect(lease.askPending).toBe(false);
    expect(lease.context.askResponder).toBe(coordinator);
  });

  it("destroy cancels the responder, tombstones the surface, and disposes sessions", async () => {
    const { service, seam } = harness();
    const responder: AskUserResponder = {
      ask: vi.fn(),
      cancelPending: vi.fn(),
    };
    const disposeAll = vi.spyOn(seam.sessionRegistry, "disposeAll");
    const stop = vi.spyOn(VaultMcpServer.prototype, "stop");
    seam.sdkUsable = Promise.resolve(false);
    // The legacy loopback bridge, which is now run-scoped rather than one shared
    // service-wide server (settled decision 17).
    const runtime = await service.getRuntime("claudecode", { posture: "ask" });
    const lease = runtime?.generation?.activate({
      review: null,
      askResponder: responder,
      askSignal: null,
      lifecycle: null,
      signal: null,
    });

    service.destroy();

    expect(responder.cancelPending).toHaveBeenCalledWith("destroyed");
    expect(lease?.state).toBe("tombstoned");
    expect(lease?.askPending).toBe(false);
    expect(disposeAll).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("destroy settles a real pending ask before disposing every transport resource", async () => {
    const { service, seam, provider, activate } = harness(["ask_user"]);
    const host = new FakeInteractionHost();
    const abortController = new AbortController();
    const coordinator = new AskInteractionCoordinator(host, abortController.signal);
    const disposeAll = vi.spyOn(seam.sessionRegistry, "disposeAll");
    const lease = activate({
      askResponder: coordinator,
      askSignal: abortController.signal,
      lifecycle: vi.fn(),
      review: {
        resolveOne: vi.fn(),
        resolveEditOne: vi.fn(),
        resolveMemoryOne: vi.fn(),
      } as unknown as VaultOpReviewer,
    });
    const pending = provider.callTool(call("ask_user", askArguments, "destroy-ask"));
    await host.waitForMount();

    // This surface belongs to a handle the test built, so unload reaches it the
    // way it reaches a real one: through the lease it holds.
    lease.tombstone();
    service.destroy();
    const result = await pending;

    expect(result.content).toContain("ask_cancelled");
    expect(host.interaction).toBeNull();
    expect(coordinator.hasPending()).toBe(false);
    expect(lease.state).toBe("tombstoned");
    expect(lease.askPending).toBe(false);
    expect(disposeAll).toHaveBeenCalledTimes(1);
  });
});
