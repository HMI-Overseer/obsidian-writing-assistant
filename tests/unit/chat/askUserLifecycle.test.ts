import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/providers/brandIcons", () => ({
  registerBrandIcons: vi.fn(),
  unregisterBrandIcons: vi.fn(),
}));

import WritingAssistantChat from "../../../src/main";
import { ChatConversationController } from "../../../src/chat/ChatConversationController";
import { ChatGenerationOrchestrator } from "../../../src/chat/ChatGenerationOrchestrator";
import { ChatView } from "../../../src/chat/ChatView";
import { AskInteractionCoordinator } from "../../../src/chat/interactions/AskInteractionCoordinator";
import type {
  ComposerInteraction,
  ComposerInteractionHostPort,
} from "../../../src/chat/interactions/ComposerInteractionHost";
import type { ChatSessionStore } from "../../../src/chat/conversation/ChatSessionStore";

const REQUEST = {
  questions: [{
    question: "Which direction?",
    header: "Direction",
    options: [
      { label: "North", description: "Take the northern route." },
      { label: "South", description: "Take the southern route." },
    ],
    multiSelect: false,
  }],
};

class LifecycleHost implements ComposerInteractionHostPort {
  interaction: ComposerInteraction | null = null;
  destroyCalls = 0;

  mount(interaction: ComposerInteraction): boolean {
    this.interaction = interaction;
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
    this.destroyCalls++;
    const interaction = this.interaction;
    this.interaction = null;
    interaction?.onCancel();
  }
}

function pendingInteraction() {
  const abortController = new AbortController();
  const host = new LifecycleHost();
  const coordinator = new AskInteractionCoordinator(host, abortController.signal, () => 4);
  const promise = coordinator.ask(REQUEST, {
    interactionId: "ask-1",
    toolCallId: "tool-1",
    signal: abortController.signal,
  });
  return { abortController, host, coordinator, promise };
}

function conversationController(
  store: ChatSessionStore,
  stopGeneration: () => void,
): ChatConversationController {
  return new ChatConversationController({
    getStore: () => store,
    getDrawer: () => null,
    getOrchestrator: () => ({
      getIsGenerating: () => true,
      stopGeneration,
    }) as unknown as ChatGenerationOrchestrator,
    syncConversationUi: () => Promise.resolve(),
    refreshAvailability: () => Promise.resolve(),
  });
}

describe("ask_user lifecycle routing", () => {
  beforeEach(() => vi.clearAllMocks());

  it("new conversation aborts and settles the pending ask before switching state", async () => {
    const pending = pendingInteraction();
    const stopGeneration = vi.fn(() => pending.abortController.abort());
    const store = {
      getConversations: () => [],
      getActiveConversationId: () => "conversation-1",
      persistActiveConversation: vi.fn(() => Promise.resolve()),
      newConversation: vi.fn(() => Promise.resolve()),
    } as unknown as ChatSessionStore;
    const controller = conversationController(store, stopGeneration);
    const rejected = expect(pending.promise).rejects.toMatchObject({
      name: "AbortError",
    });

    await controller.startNewConversation();
    await rejected;

    expect(stopGeneration).toHaveBeenCalledTimes(1);
    expect(pending.coordinator.hasPending()).toBe(false);
    expect(pending.host.interaction).toBeNull();
  });

  it("conversation switch aborts and settles the pending ask before loading the target", async () => {
    const pending = pendingInteraction();
    const stopGeneration = vi.fn(() => pending.abortController.abort());
    const store = {
      getActiveConversationId: () => "conversation-1",
      persistActiveConversation: vi.fn(() => Promise.resolve()),
      switchToConversation: vi.fn(() => Promise.resolve(true)),
    } as unknown as ChatSessionStore;
    const controller = conversationController(store, stopGeneration);
    const rejected = expect(pending.promise).rejects.toMatchObject({
      name: "AbortError",
    });

    await controller.switchConversation("conversation-2");
    await rejected;

    expect(stopGeneration).toHaveBeenCalledTimes(1);
    expect(pending.coordinator.hasPending()).toBe(false);
    expect(pending.host.interaction).toBeNull();
  });

  it("double Stop aborts the active generation only once", () => {
    const orchestrator = new ChatGenerationOrchestrator({} as never);
    const abortController = new AbortController();
    const onAbort = vi.fn();
    abortController.signal.addEventListener("abort", onAbort);
    const seam = orchestrator as unknown as {
      activeAbortController: AbortController | null;
    };
    seam.activeAbortController = abortController;

    orchestrator.stopGeneration();
    orchestrator.stopGeneration();

    expect(onAbort).toHaveBeenCalledTimes(1);
    expect(seam.activeAbortController).toBeNull();
  });

  it("view cleanup destroys the host and settles a pending ask", async () => {
    const pending = pendingInteraction();
    const stopGeneration = vi.fn();
    const rejected = expect(pending.promise).rejects.toMatchObject({
      name: "AbortError",
    });

    ChatView.prototype.prepareForPluginUnload.call({
      orchestrator: { stopGeneration },
      interactionHost: pending.host,
    } as never);
    await rejected;

    expect(stopGeneration).toHaveBeenCalledTimes(1);
    expect(pending.host.destroyCalls).toBe(1);
    expect(pending.coordinator.hasPending()).toBe(false);
  });

  it("plugin unload asks every live chat view to clean up before services", () => {
    const view = Object.create(ChatView.prototype) as ChatView;
    const prepareForPluginUnload = vi.fn();
    view.prepareForPluginUnload = prepareForPluginUnload;
    const inlineDiffDestroy = vi.fn();
    const servicesDestroy = vi.fn();

    WritingAssistantChat.prototype.onunload.call({
      app: {
        workspace: {
          getLeavesOfType: () => [{ view }],
        },
      },
      inlineDiff: { destroy: inlineDiffDestroy },
      services: { destroy: servicesDestroy },
    } as never);

    expect(prepareForPluginUnload).toHaveBeenCalledTimes(1);
    expect(inlineDiffDestroy).toHaveBeenCalledTimes(1);
    expect(servicesDestroy).toHaveBeenCalledTimes(1);
    expect(prepareForPluginUnload.mock.invocationCallOrder[0]).toBeLessThan(
      servicesDestroy.mock.invocationCallOrder[0],
    );
  });
});
