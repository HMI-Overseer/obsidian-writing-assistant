import type { BubbleRefs } from "../types";
import type { ChatTranscript } from "../messages/ChatTranscript";
import { TOOL_STATUS_LABELS } from "../../tools/metadata";

const STREAMING_MARKDOWN_RENDER_DEBOUNCE_MS = 80;

export class StreamingRenderer {
  private fullResponse = "";
  private roundStartOffset = 0;
  private hasRenderedMarkdown = false;
  private lastRenderedText = "";
  private lastRenderKey = "";
  private queuedText = "";
  private toolStatusText = "";
  private renderTimer: number | null = null;
  private renderChain = Promise.resolve();

  constructor(
    private readonly bubble: BubbleRefs,
    private readonly transcript: ChatTranscript
  ) {}

  getFullResponse(): string {
    return this.fullResponse;
  }

  /**
   * Text produced by the current (most recent) round only.
   * In single-round conversations this equals getFullResponse().
   * In agentic multi-round conversations this is just the final response,
   * excluding intermediate reasoning rounds that were committed to the timeline.
   */
  getCurrentRoundResponse(): string {
    return this.fullResponse.slice(this.roundStartOffset);
  }

  hasStreamRenderedMarkdown(): boolean {
    return this.hasRenderedMarkdown;
  }

  getLastRenderedText(): string {
    return this.lastRenderedText;
  }

  appendDelta(delta: string): void {
    this.fullResponse += delta;

    if (!this.hasRenderedMarkdown) {
      this.transcript.renderPlainTextContent(this.bubble, this.getCurrentRoundResponse());
    }

    this.queueRender();
    this.transcript.scrollToBottom();
  }

  showToolStatus(toolName: string): void {
    this.toolStatusText = TOOL_STATUS_LABELS[toolName] ?? `Running ${toolName}...`;
    // Bypass the debounce so the status is visible before the tool completes.
    this.queuedText = this.getCurrentRoundResponse();
    this.renderChain = this.renderChain.then(() => this.renderOnce()).catch(() => undefined);
  }

  /**
   * Advance to a new round: clear the bubble, reset render state, and move the
   * round-start offset so getCurrentRoundResponse() reflects only the new round.
   * Called both when intermediate reasoning is committed to the timeline (before
   * tools run) and after tools complete (to clear the tool-status text).
   */
  beginNewRound(): void {
    this.toolStatusText = "";
    this.roundStartOffset = this.fullResponse.length;
    this.hasRenderedMarkdown = false;
    this.lastRenderedText = "";
    this.lastRenderKey = "";
    this.queuedText = "";
    this.bubble.contentEl.empty();
  }

  private queueRender(): void {
    this.queuedText = this.getCurrentRoundResponse();
    if (this.renderTimer !== null) return;

    this.renderTimer = window.setTimeout(() => {
      this.renderTimer = null;
      this.renderChain = this.renderChain
        .then(() => this.renderOnce())
        .catch(() => undefined);
    }, STREAMING_MARKDOWN_RENDER_DEBOUNCE_MS);
  }

  private async renderOnce(): Promise<void> {
    const textToRender = this.queuedText;
    const displayText = this.toolStatusText
      ? (textToRender
          ? `${textToRender}\n\n*${this.toolStatusText}*`
          : `*${this.toolStatusText}*`)
      : textToRender;

    if (!displayText || !this.bubble.contentEl.isConnected) return;

    const renderKey = `${textToRender}|${this.toolStatusText}`;
    if (renderKey === this.lastRenderKey) return;

    await this.transcript.renderBubbleContent(this.bubble, displayText, {
      preserveStreaming: true,
    });
    this.hasRenderedMarkdown = true;
    this.lastRenderedText = textToRender;
    this.lastRenderKey = renderKey;
    this.transcript.scrollToBottom();
  }

  async flush(): Promise<void> {
    if (this.renderTimer !== null) {
      window.clearTimeout(this.renderTimer);
      this.renderTimer = null;
    }

    this.renderChain = this.renderChain
      .then(() => this.renderOnce())
      .catch(() => undefined);

    await this.renderChain;
  }

  destroy(): void {
    if (this.renderTimer !== null) {
      window.clearTimeout(this.renderTimer);
      this.renderTimer = null;
    }
  }
}
