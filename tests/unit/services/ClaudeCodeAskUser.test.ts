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
  createToolProvider(): McpToolProvider;
  runAllowedTools: Set<string>;
  liveReview: VaultOpReviewer | null;
  askUserResponder: AskUserResponder | null;
  askPending: boolean;
  sdkUsable: Promise<boolean> | null;
  sessionRegistry: { disposeAll(): void };
  mcpServer: { stop(): void } | null;
}

function harness() {
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
  return {
    currentSettings,
    service,
    seam,
    provider: seam.createToolProvider(),
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
    const { currentSettings, service, seam } = harness();

    currentSettings.agenticMode = true;
    await service.getRuntime("claudecode", { posture: "ask" });
    expect(seam.runAllowedTools.has("ask_user")).toBe(true);

    currentSettings.agenticMode = false;
    await service.getRuntime("claudecode", { posture: "ask" });
    expect(seam.runAllowedTools.has("ask_user")).toBe(false);
  });

  it("claims the latch synchronously and refuses callbacks that enter later", async () => {
    const { service, seam, provider } = harness();
    const answers = deferred<AskAnswers>();
    const responder: AskUserResponder = {
      ask: vi.fn(() => answers.promise),
      cancelPending: vi.fn(),
    };
    const resolveOne = vi.fn(async (): Promise<ToolResult> => ({
      content: "Created directory.",
      isReadOnly: false,
    }));
    seam.runAllowedTools = new Set(["ask_user", "create_directory"]);
    seam.liveReview = {
      resolveOne,
      resolveEditOne: vi.fn(),
      resolveMemoryOne: vi.fn(),
    };
    service.setAskUserResponder(responder);

    const pendingAsk = provider.callTool(call("ask_user", askArguments, "ask-1"));

    expect(seam.askPending).toBe(true);
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
    expect(seam.askPending).toBe(false);

    await expect(
      provider.callTool(call("create_directory", { path: "Drafts" }, "write-2")),
    ).resolves.toMatchObject({ content: "Created directory." });
    expect(resolveOne).toHaveBeenCalledTimes(1);
  });

  it("returns the canonical validation failure without mounting a form", async () => {
    const { service, seam, provider } = harness();
    const host = new FakeInteractionHost();
    const coordinator = new AskInteractionCoordinator(host, new AbortController().signal);
    seam.runAllowedTools = new Set(["ask_user"]);
    service.setAskUserResponder(coordinator);

    const result = await provider.callTool(
      call("ask_user", { questions: [] }, "invalid-ask"),
    );

    expect(result.failure?.kind).toBe("invalid-args");
    expect(result.content).toContain("questions_count");
    expect(host.interaction).toBeNull();
    expect(seam.askPending).toBe(false);
    coordinator.destroy();
  });

  it("abort and generation cleanup clear the form, promise, responder, and latch", async () => {
    const { service, seam, provider } = harness();
    const host = new FakeInteractionHost();
    const abortController = new AbortController();
    const coordinator = new AskInteractionCoordinator(host, abortController.signal);
    seam.runAllowedTools = new Set(["ask_user"]);
    service.setAskUserResponder(coordinator, abortController.signal);

    const pending = provider.callTool(call("ask_user", askArguments, "abort-ask"));
    await host.waitForMount();
    abortController.abort();
    const result = await pending;
    service.setAskUserResponder(null);
    coordinator.destroy();

    expect(result.content).toContain("ask_cancelled");
    expect(host.interaction).toBeNull();
    expect(coordinator.hasPending()).toBe(false);
    expect(seam.askUserResponder).toBeNull();
    expect(seam.askPending).toBe(false);
  });

  it("routes SDK and legacy loopback calls through the same responder", async () => {
    const { service, seam, provider } = harness();
    const host = new FakeInteractionHost();
    const coordinator = new AskInteractionCoordinator(host, new AbortController().signal);
    seam.runAllowedTools = new Set(["ask_user"]);
    service.setAskUserResponder(coordinator);

    const sdkAsk = buildVaultSdkTools(provider).find((tool) => tool.name === "ask_user");
    expect(sdkAsk).toBeDefined();
    const sdkPending = sdkAsk!.handler(askArguments);
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
    const handle = await server.start();
    try {
      const legacyPending = postToolCall(handle, "ask_user", askArguments);
      await host.waitForMount();
      host.submit({ [question]: "Detailed" });
      const response = await legacyPending;
      expect(response).toMatchObject({
        result: {
          content: [
            {
              type: "text",
              text: JSON.stringify({ answers: { [question]: "Detailed" } }),
            },
          ],
          isError: false,
        },
      });
    } finally {
      server.stop();
      coordinator.destroy();
    }

    expect(seam.askPending).toBe(false);
    expect(seam.askUserResponder).toBe(coordinator);
  });

  it("destroy cancels and clears the responder, latch, sessions, and loopback server", () => {
    const { service, seam } = harness();
    const responder: AskUserResponder = {
      ask: vi.fn(),
      cancelPending: vi.fn(),
    };
    const disposeAll = vi.spyOn(seam.sessionRegistry, "disposeAll");
    const stop = vi.fn();
    seam.mcpServer = { stop };
    seam.askPending = true;
    service.setAskUserResponder(responder);

    service.destroy();

    expect(responder.cancelPending).toHaveBeenCalledWith("destroyed");
    expect(seam.askUserResponder).toBeNull();
    expect(seam.askPending).toBe(false);
    expect(disposeAll).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(seam.mcpServer).toBeNull();
  });
});
