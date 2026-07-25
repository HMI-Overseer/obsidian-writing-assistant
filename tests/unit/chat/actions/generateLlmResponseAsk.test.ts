import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../../src/chat/finalization/prepareApiMessages", () => ({
  prepareApiMessages: vi.fn(),
}));

vi.mock("../../../../src/shared/profileUtils", () => ({
  getActiveProfile: () => ({
    systemPrompt: "",
    disableBuiltinSystemPrompts: false,
    anthropicCacheSettings: { enabled: false },
  }),
}));

vi.mock("../../../../src/chat/finalization/buildSamplingParams", () => ({
  buildSamplingParams: () => ({}),
}));

vi.mock("../../../../src/providers/reasoningLevels", () => ({
  resolveModelReasoning: () => null,
}));

vi.mock("../../../../src/chat/streaming/StreamingRenderer", () => ({
  StreamingRenderer: class {
    private response = "";

    appendDelta(delta: string): void {
      this.response += delta;
    }

    showToolStatus(): void {}
    beginNewRound(): void {}
    flush(): Promise<void> {
      return Promise.resolve();
    }
    getCurrentRoundResponse(): string {
      return this.response;
    }
    getFullResponse(): string {
      return this.response;
    }
    hasStreamRenderedMarkdown(): boolean {
      return false;
    }
    getLastRenderedText(): string {
      return "";
    }
    destroy(): void {}
  },
}));

vi.mock("../../../../src/chat/streaming/EditStreamingRenderer", () => ({
  EditStreamingRenderer: class {
    private response = "";

    appendDelta(delta: string): void {
      this.response += delta;
    }

    showToolStatus(): void {}
    beginNewRound(): void {}
    flush(): Promise<void> {
      return Promise.resolve();
    }
    getFullResponse(): string {
      return this.response;
    }
    destroy(): void {}
  },
}));

vi.mock("../../../../src/chat/messages/AgenticTimeline", () => ({
  AgenticTimeline: class {
    private readonly steps: unknown[] = [];

    addPendingToolCall(): void {}
    addStep(step: unknown): void {
      this.steps.push(step);
    }
    setStepResult(): void {}
    addReasoningDelta(): void {}
    commitLiveReasoning(): void {}
    discardLiveReasoning(): void {}
    finalize(): void {}
    getSteps(): unknown[] {
      return [...this.steps];
    }
  },
}));

vi.mock("../../../../src/chat/actions/liveVaultReview", () => ({
  LiveVaultReview: class {
    cancelPending(): void {}
    detachEditPanel(): void {}
    getProposal(): null {
      return null;
    }
    getAppliedRecord(): null {
      return null;
    }
    getEditProposals(): never[] {
      return [];
    }
    getEditAppliedRecords(): never[] {
      return [];
    }
  },
}));

import type { Component } from "obsidian";
import type { ChatClient } from "../../../../src/api/chatClient";
import { createAbortError } from "../../../../src/api/httpTransport";
import type { StreamResult } from "../../../../src/api/usageTypes";
import { generateLlmResponse } from "../../../../src/chat/actions/generateLlmResponse";
import type { ChatSessionStore } from "../../../../src/chat/conversation/ChatSessionStore";
import type {
  ComposerInteraction,
  ComposerInteractionHostPort,
} from "../../../../src/chat/interactions/ComposerInteractionHost";
import type { ChatTranscript } from "../../../../src/chat/messages/ChatTranscript";
import { prepareApiMessages } from "../../../../src/chat/finalization/prepareApiMessages";
import { DEFAULT_SETTINGS } from "../../../../src/constants";
import type WritingAssistantChat from "../../../../src/main";
import type { ChatRequest } from "../../../../src/shared/chatRequest";
import type {
  AgenticStep,
  CompletionModel,
  ConversationMessage,
} from "../../../../src/shared/types";
import { ASK_USER_TOOL } from "../../../../src/tools/ask/definition";
import {
  askCancellationFailure,
  buildAskUserResult,
} from "../../../../src/tools/ask/result";
import type { AskAnswers, AskUserResponder } from "../../../../src/tools/ask/types";
import { formatAgenticReplayLines } from "../../../../src/tools/resultDigest";
import type { ToolCall } from "../../../../src/tools/types";
import type { ClaudeCodeToolEvent } from "../../../../src/services/ClaudeCodeService";
import { DEFAULT_VAULT_OP_POLICY } from "../../../../src/vault-ops/gateway";

const question = "Which format should I use?";
const askCall: ToolCall = {
  id: "ask-1",
  name: "ask_user",
  arguments: {
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
  },
};

interface RoundScript {
  deltas?: string[];
  toolCalls?: ToolCall[] | null;
  error?: Error;
  waitForAbort?: boolean;
}

class FakeInteractionHost implements ComposerInteractionHostPort {
  interaction: ComposerInteraction | null = null;
  readonly clearIfOwner = vi.fn((interactionId: string) => {
    if (this.interaction?.interactionId === interactionId) {
      this.interaction = null;
    }
  });
  readonly destroy = vi.fn();
  private resolveMounted!: () => void;
  readonly mounted = new Promise<void>((resolve) => {
    this.resolveMounted = resolve;
  });

  mount(interaction: ComposerInteraction): boolean {
    this.interaction = interaction;
    this.resolveMounted();
    return true;
  }

  isActive(interactionId?: string): boolean {
    return Boolean(
      this.interaction &&
      (interactionId === undefined || this.interaction.interactionId === interactionId),
    );
  }

  submit(answers: AskAnswers): void {
    this.interaction?.onSubmit(answers);
  }
}

function makeClient(rounds: RoundScript[]): ChatClient & {
  stream: ReturnType<typeof vi.fn>;
  roundStarted: (round: number) => Promise<void>;
} {
  let index = 0;
  const startedRounds = new Set<number>();
  const roundResolvers = new Map<number, () => void>();
  const roundPromises = new Map<number, Promise<void>>();
  const roundStarted = (round: number) => {
    if (startedRounds.has(round)) return Promise.resolve();
    let promise = roundPromises.get(round);
    if (!promise) {
      promise = new Promise<void>((resolve) => {
        roundResolvers.set(round, resolve);
      });
      roundPromises.set(round, promise);
    }
    return promise;
  };
  const stream = vi.fn(
    (
      _request: ChatRequest,
      _model: string,
      _params: unknown,
      signal: AbortSignal,
      onToolCall?: (index: number, name: string) => void,
    ): StreamResult => {
      const roundIndex = index++;
      startedRounds.add(roundIndex);
      roundResolvers.get(roundIndex)?.();
      const script = rounds[roundIndex];
      if (script.toolCalls) {
        for (const [toolIndex, toolCall] of script.toolCalls.entries()) {
          onToolCall?.(toolIndex, toolCall.name);
        }
      }
      const deltas = (async function* () {
        for (const delta of script.deltas ?? []) yield delta;
        if (script.waitForAbort) {
          await new Promise<void>((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(createAbortError()), {
              once: true,
            });
          });
        }
        if (script.error) throw script.error;
      })();
      return {
        deltas,
        usage: Promise.resolve(null),
        toolCalls: Promise.resolve(script.toolCalls ?? null),
        stopReason: Promise.resolve(
          script.toolCalls ? "tool_use" : "end_turn",
        ),
      } as unknown as StreamResult;
    },
  );
  return {
    complete: vi.fn(),
    stream,
    roundStarted,
  } as unknown as ChatClient & {
    stream: ReturnType<typeof vi.fn>;
    roundStarted: (round: number) => Promise<void>;
  };
}

interface FakeClaudeCodeBridge {
  setAskUserResponder: ReturnType<typeof vi.fn>;
  setLiveReview: ReturnType<typeof vi.fn>;
  setToolListener: ReturnType<typeof vi.fn>;
  takeCollectedEdits(): ToolCall[];
  takeCollectedVaultOps(): ToolCall[];
  getAskUserResponder(): AskUserResponder | null;
  emitToolEvent(event: ClaudeCodeToolEvent): void;
}

function makeClaudeCodeClient(
  bridge: FakeClaudeCodeBridge,
  options: { failAfterSubmit?: boolean; responseText?: string } = {},
): ChatClient {
  return {
    complete: vi.fn(),
    stream: vi.fn(
      (
        _request: ChatRequest,
        _model: string,
        _params: unknown,
        signal?: AbortSignal,
      ): StreamResult => {
        const deltas = (async function* () {
          const responder = bridge.getAskUserResponder();
          if (!responder || !signal) {
            throw new Error("Claude Code ask responder was not installed before streaming.");
          }

          bridge.emitToolEvent({
            phase: "start",
            toolName: "ask_user",
            toolCallId: askCall.id,
          });
          let content = "The tool threw an unexpected error.";
          let isError = true;
          try {
            const answers = await responder.ask(askCall.arguments, {
              interactionId: "claude-code-ask",
              toolCallId: askCall.id,
              signal,
            });
            const result = buildAskUserResult(answers);
            content = result.content;
            isError = false;
          } finally {
            bridge.emitToolEvent({
              phase: "end",
              toolName: "ask_user",
              args: askCall.arguments,
              isError,
              content,
              toolCallId: askCall.id,
              askStatus: isError ? "skipped" : "completed",
            });
          }

          if (options.failAfterSubmit) {
            throw new Error("Claude Code provider failed after submission");
          }
          if (options.responseText) yield options.responseText;
        })();
        return {
          deltas,
          usage: Promise.resolve(null),
          toolCalls: Promise.resolve(null),
          stopReason: Promise.resolve("end_turn"),
        };
      },
    ),
  } as ChatClient;
}

function makeCleanInterruptClaudeCodeClient(
  bridge: FakeClaudeCodeBridge,
): ChatClient {
  return {
    complete: vi.fn(),
    stream: vi.fn(
      (
        _request: ChatRequest,
        _model: string,
        _params: unknown,
        signal?: AbortSignal,
      ): StreamResult => {
        const deltas = (async function* () {
          const responder = bridge.getAskUserResponder();
          if (!responder || !signal) {
            throw new Error("Claude Code ask responder was not installed before streaming.");
          }

          bridge.emitToolEvent({
            phase: "start",
            toolName: "ask_user",
            toolCallId: askCall.id,
          });
          try {
            await responder.ask(askCall.arguments, {
              interactionId: "claude-code-clean-interrupt",
              toolCallId: askCall.id,
              signal,
            });
          } catch (error) {
            if (!(error instanceof Error) || error.name !== "AbortError") throw error;
            bridge.emitToolEvent({
              phase: "end",
              toolName: "ask_user",
              args: askCall.arguments,
              isError: true,
              content: askCancellationFailure("stopped").content,
              toolCallId: askCall.id,
              askStatus: "cancelled",
            });
          }
        })();
        return {
          deltas,
          usage: Promise.resolve(null),
          toolCalls: Promise.resolve(null),
          stopReason: Promise.resolve("end_turn"),
        };
      },
    ),
  } as ChatClient;
}

function makeEarlySettlingClaudeCodeClient(
  bridge: FakeClaudeCodeBridge,
  onCallbackSettled: (error: Error) => void,
): ChatClient {
  return {
    complete: vi.fn(),
    stream: vi.fn(
      (
        _request: ChatRequest,
        _model: string,
        _params: unknown,
        signal?: AbortSignal,
      ): StreamResult => {
        const deltas = (async function* () {
          const responder = bridge.getAskUserResponder();
          if (!responder || !signal) {
            throw new Error("Claude Code ask responder was not installed before streaming.");
          }

          bridge.emitToolEvent({
            phase: "start",
            toolName: "ask_user",
            toolCallId: askCall.id,
          });
          void responder.ask(askCall.arguments, {
            interactionId: "legacy-early-settlement",
            toolCallId: askCall.id,
            signal,
          }).catch((error: unknown) => {
            onCallbackSettled(
              error instanceof Error ? error : new Error(String(error)),
            );
          });
        })();
        return {
          deltas,
          usage: Promise.resolve(null),
          toolCalls: Promise.resolve(null),
          stopReason: Promise.resolve("end_turn"),
        };
      },
    ),
  } as ChatClient;
}

function harness(
  finalization: "append" | "replace" = "append",
  posture: "ask" | "auto" = "ask",
) {
  const messages: ConversationMessage[] = [];
  const store = {
    persistActiveConversation: vi.fn(() => Promise.resolve()),
    appendMessage: vi.fn((message: ConversationMessage) => messages.push(message)),
    setLastAssistantResponse: vi.fn(),
    finalizeRegeneration: vi.fn(),
    restoreRegeneration: vi.fn(),
  } as unknown as ChatSessionStore;
  const bubble = {
    bodyEl: {
      addClass: vi.fn(),
      removeClass: vi.fn(),
    },
    timelineEl: {},
    contentEl: { isConnected: false },
  };
  const transcript = {
    createBubble: vi.fn(() => bubble),
    registerBubble: vi.fn(),
    renderBubbleContent: vi.fn(() => Promise.resolve()),
    renderPlainTextContent: vi.fn(),
  } as unknown as ChatTranscript;
  const interactionHost = new FakeInteractionHost();
  const activeControllers: Array<AbortController | null> = [];
  const settings = {
    ...DEFAULT_SETTINGS,
    agenticMode: true,
    memoriesEnabled: false,
    vaultOpPolicy: {
      ...DEFAULT_VAULT_OP_POLICY,
      create: "deny" as const,
      overwrite: "deny" as const,
      move: "deny" as const,
      trash: "deny" as const,
      createDir: "deny" as const,
      edit: "deny" as const,
      memory: "deny" as const,
    },
  };
  let askUserResponder: AskUserResponder | null = null;
  let toolListener: ((event: ClaudeCodeToolEvent) => void) | null = null;
  const claudeCode: FakeClaudeCodeBridge = {
    setAskUserResponder: vi.fn((responder: AskUserResponder | null) => {
      askUserResponder = responder;
    }),
    setLiveReview: vi.fn(),
    setToolListener: vi.fn((listener: ((event: ClaudeCodeToolEvent) => void) | null) => {
      toolListener = listener;
    }),
    takeCollectedEdits: () => [],
    takeCollectedVaultOps: () => [],
    getAskUserResponder: () => askUserResponder,
    emitToolEvent: (event) => {
      toolListener?.(event);
    },
  };
  const plugin = {
    settings,
    app: {
      workspace: {
        getActiveFile: () => null,
      },
      vault: {
        adapter: {},
        getName: () => "Vault",
        getAbstractFileByPath: () => null,
        getRoot: () => null,
      },
    },
    services: {
      ragService: {
        availability: () => "no-backend",
      },
      memoryService: {},
      modelAvailability: {
        getTrainedForToolUse: () => undefined,
        getVision: () => true,
        resolveContextWindow: () => undefined,
        reportContextWindow: vi.fn(),
      },
      claudeCode,
    },
  } as unknown as WritingAssistantChat;
  const oldMessage: ConversationMessage = {
    id: "old",
    role: "assistant",
    content: "Old answer.",
  };

  return {
    messages,
    store,
    transcript,
    interactionHost,
    activeControllers,
    claudeCode,
    options: {
      plugin,
      owner: {} as Component,
      store,
      transcript,
      activeModel: {
        provider: "openai",
        modelId: "gpt-test",
        name: "Test",
      } as CompletionModel,
      posture,
      interactionHost,
      finalization:
        finalization === "append"
          ? { kind: "append" as const }
          : { kind: "replace" as const, oldMessage },
      setIsGenerating: vi.fn(),
      setActiveAbortController: (controller: AbortController | null) => {
        activeControllers.push(controller);
      },
    },
  };
}

function completedAskStep(message: ConversationMessage): AgenticStep | undefined {
  return message.agenticSteps?.find((step) => step.toolName === "ask_user");
}

describe("generateLlmResponse ask_user integration", () => {
  beforeEach(() => {
    vi.mocked(prepareApiMessages).mockResolvedValue({
      systemPrompt: "",
      documentContext: null,
      ragContext: null,
      messages: [],
      tools: [ASK_USER_TOOL],
      allowedToolNames: ["ask_user"],
    });
  });

  it.each(["ask", "auto"] as const)(
    "keeps the model suspended under %s posture until submit",
    async (posture) => {
      const state = harness("append", posture);
      const client = makeClient([
        { toolCalls: [askCall] },
        { deltas: ["Done."] },
      ]);

      const pending = generateLlmResponse({ ...state.options, client });
      await state.interactionHost.mounted;

      expect(client.stream).toHaveBeenCalledTimes(1);
      state.interactionHost.submit({ [question]: "Detailed" });
      await pending;

      expect(client.stream).toHaveBeenCalledTimes(2);
      expect(state.messages).toHaveLength(1);
      expect(completedAskStep(state.messages[0])).toMatchObject({
        askStatus: "completed",
        askGuidance: {
          questions: [
            {
              question,
              header: "Output",
              answer: "Detailed",
            },
          ],
        },
      });
      expect(state.interactionHost.clearIfOwner).toHaveBeenCalledTimes(1);
      expect(state.activeControllers.at(-1)).toBeNull();
    },
  );

  it("persists zero-text completion after submitted guidance", async () => {
    const state = harness();
    const pending = generateLlmResponse({
      ...state.options,
      client: makeClient([
        { toolCalls: [askCall] },
        { deltas: [] },
      ]),
    });
    await state.interactionHost.mounted;
    state.interactionHost.submit({ [question]: "Concise" });
    await pending;

    expect(state.messages).toHaveLength(1);
    expect(state.messages[0].content).toBe("");
    expect(completedAskStep(state.messages[0])?.askGuidance).toBeDefined();
  });

  it("persists submitted guidance when the provider fails afterward", async () => {
    const state = harness();
    const pending = generateLlmResponse({
      ...state.options,
      client: makeClient([
        { toolCalls: [askCall] },
        { error: new Error("provider failed") },
      ]),
    });
    await state.interactionHost.mounted;
    state.interactionHost.submit({ [question]: "Detailed" });
    await pending;

    expect(state.messages).toHaveLength(1);
    expect(state.messages[0].isError).toBe(true);
    expect(completedAskStep(state.messages[0])?.askGuidance).toBeDefined();
    expect(state.interactionHost.interaction).toBeNull();
    expect(state.interactionHost.clearIfOwner).toHaveBeenCalledTimes(1);
    expect(state.activeControllers.at(-1)).toBeNull();
  });

  it("persists submitted guidance when Stop wins during the next provider round", async () => {
    const state = harness();
    const client = makeClient([
      { toolCalls: [askCall] },
      { waitForAbort: true },
    ]);
    const pending = generateLlmResponse({ ...state.options, client });
    await state.interactionHost.mounted;
    state.interactionHost.submit({ [question]: "Detailed" });
    await client.roundStarted(1);

    state.activeControllers[0]?.abort();
    await pending;

    expect(state.messages).toHaveLength(1);
    expect(state.messages[0].interrupted).toBe(true);
    expect(completedAskStep(state.messages[0])?.askGuidance).toBeDefined();
  });

  it("keeps replacement-attempt guidance in regeneration metadata", async () => {
    const state = harness("replace");
    const pending = generateLlmResponse({
      ...state.options,
      client: makeClient([
        { toolCalls: [askCall] },
        { deltas: ["Replacement."] },
      ]),
    });
    await state.interactionHost.mounted;
    state.interactionHost.submit({ [question]: "Detailed" });
    await pending;

    expect(state.store.finalizeRegeneration).toHaveBeenCalledWith(
      expect.objectContaining({ id: "old" }),
      "Replacement.",
      expect.objectContaining({
        agenticSteps: expect.arrayContaining([
          expect.objectContaining({
            toolName: "ask_user",
            askStatus: "completed",
          }),
        ]),
      }),
    );
  });

  it("lets abort win before submit and clears the mounted interaction", async () => {
    const state = harness();
    const pending = generateLlmResponse({
      ...state.options,
      client: makeClient([{ toolCalls: [askCall] }]),
    });
    await state.interactionHost.mounted;

    state.activeControllers[0]?.abort();
    state.activeControllers[0]?.abort();
    state.interactionHost.submit({ [question]: "Detailed" });
    await pending;

    expect(state.interactionHost.interaction).toBeNull();
    expect(state.interactionHost.clearIfOwner).toHaveBeenCalledTimes(1);
    expect(state.messages).toHaveLength(0);
    expect(state.activeControllers.at(-1)).toBeNull();
  });

  it("binds the Claude Code responder for the generation and clears it on Stop", async () => {
    const state = harness();
    state.options.activeModel = {
      provider: "claudecode",
      modelId: "claude-sonnet-test",
      name: "Claude test",
    };
    const pending = generateLlmResponse({
      ...state.options,
      client: makeClaudeCodeClient(state.claudeCode),
    });
    await state.interactionHost.mounted;

    expect(state.claudeCode.getAskUserResponder()).not.toBeNull();
    expect(state.claudeCode.setAskUserResponder).toHaveBeenCalledTimes(1);

    state.activeControllers[0]?.abort();
    await pending;

    expect(state.interactionHost.interaction).toBeNull();
    expect(state.claudeCode.getAskUserResponder()).toBeNull();
    expect(state.claudeCode.setAskUserResponder).toHaveBeenLastCalledWith(null);
    expect(state.activeControllers.at(-1)).toBeNull();
  });

  it("classifies a clean SDK Stop as an interrupted generation", async () => {
    const state = harness();
    state.options.activeModel = {
      provider: "claudecode",
      modelId: "claude-sonnet-test",
      name: "Claude test",
    };
    const pending = generateLlmResponse({
      ...state.options,
      client: makeCleanInterruptClaudeCodeClient(state.claudeCode),
    });
    await state.interactionHost.mounted;

    state.activeControllers[0]?.abort();
    state.activeControllers[0]?.abort();
    await pending;

    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]).toMatchObject({
      content: "",
      interrupted: true,
      agenticSteps: expect.arrayContaining([
        expect.objectContaining({
          toolName: "ask_user",
          askStatus: "cancelled",
        }),
      ]),
    });
    expect(state.interactionHost.interaction).toBeNull();
    expect(state.claudeCode.getAskUserResponder()).toBeNull();
    expect(state.activeControllers.at(-1)).toBeNull();
  });

  it("cleans up safely when a legacy query settles before its ask callback", async () => {
    const state = harness();
    state.options.activeModel = {
      provider: "claudecode",
      modelId: "claude-sonnet-test",
      name: "Claude test",
    };
    let settleCallback!: (error: Error) => void;
    const callbackSettled = new Promise<Error>((resolve) => {
      settleCallback = resolve;
    });

    await generateLlmResponse({
      ...state.options,
      client: makeEarlySettlingClaudeCodeClient(
        state.claudeCode,
        settleCallback,
      ),
    });
    const callbackError = await callbackSettled;

    expect(callbackError).toMatchObject({
      name: "AbortError",
      message: "The request was aborted.",
    });
    expect(state.interactionHost.interaction).toBeNull();
    expect(state.interactionHost.clearIfOwner).toHaveBeenCalledTimes(1);
    expect(state.claudeCode.getAskUserResponder()).toBeNull();
    expect(state.activeControllers.at(-1)).toBeNull();
  });

  it("persists and replays Claude Code guidance when the provider fails after submit", async () => {
    const state = harness();
    state.options.activeModel = {
      provider: "claudecode",
      modelId: "claude-sonnet-test",
      name: "Claude test",
    };
    const pending = generateLlmResponse({
      ...state.options,
      client: makeClaudeCodeClient(state.claudeCode, { failAfterSubmit: true }),
    });
    await state.interactionHost.mounted;
    state.interactionHost.submit({ [question]: "Detailed" });
    await pending;

    expect(state.messages).toHaveLength(1);
    expect(state.messages[0].isError).toBe(true);
    expect(completedAskStep(state.messages[0])?.askGuidance).toBeDefined();
    const guidance =
      '[ask_user guidance: {"questions":[{"question":"Which format should I use?","header":"Output","answer":"Detailed"}]}]';
    expect(formatAgenticReplayLines(state.messages[0].agenticSteps ?? [])).toEqual([
      guidance,
    ]);
  });
});
