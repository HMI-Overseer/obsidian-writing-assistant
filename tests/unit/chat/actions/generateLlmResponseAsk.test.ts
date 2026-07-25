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
  EditStreamingRenderer: class {},
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
import type { AskAnswers } from "../../../../src/tools/ask/types";
import type { ToolCall } from "../../../../src/tools/types";
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

function harness(finalization: "append" | "replace" = "append") {
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
      claudeCode: {
        setLiveReview: vi.fn(),
        setToolListener: vi.fn(),
        takeCollectedEdits: () => [],
        takeCollectedVaultOps: () => [],
      },
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
      posture: "ask" as const,
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

  it("keeps the model suspended until submit and persists completed guidance", async () => {
    const state = harness();
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
  });

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
    state.interactionHost.submit({ [question]: "Detailed" });
    await pending;

    expect(state.interactionHost.interaction).toBeNull();
    expect(state.interactionHost.clearIfOwner).toHaveBeenCalledTimes(1);
    expect(state.messages).toHaveLength(0);
    expect(state.activeControllers.at(-1)).toBeNull();
  });
});
