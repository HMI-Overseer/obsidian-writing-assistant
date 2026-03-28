import type { ChatComposer } from "./composer/ChatComposer";
import type { ChatSessionStore } from "./conversation/ChatSessionStore";
import type { ChatTranscript } from "./messages/ChatTranscript";

export class ChatGenerationController {
  private isGenerating = false;
  private activeAbortController: AbortController | null = null;

  constructor(
    private readonly getComposer: () => ChatComposer | null,
    private readonly getStore: () => ChatSessionStore | null,
    private readonly getTranscript: () => ChatTranscript | null
  ) {}

  getIsGenerating(): boolean {
    return this.isGenerating;
  }

  setIsGenerating(generating: boolean): void {
    this.isGenerating = generating;
    this.getComposer()?.setSendingState(generating);

    const snapshot = this.getStore()?.getSnapshot();
    this.getTranscript()?.setEmptyStateVisible(
      Boolean(snapshot && snapshot.messageHistory.length === 0 && !generating)
    );
  }

  setActiveAbortController(controller: AbortController | null): void {
    this.activeAbortController = controller;
  }

  stopGeneration(): void {
    if (!this.activeAbortController) return;
    this.activeAbortController.abort();
    this.activeAbortController = null;
  }
}
