import type { BubbleRefs } from "../types";
import type { ChatTranscript } from "../messages/ChatTranscript";

const STREAMING_MARKDOWN_RENDER_DEBOUNCE_MS = 80;

const TOOL_STATUS_LABELS: Record<string, string> = {
  search_vault: "Searching vault...",
  read_note: "Reading note...",
};

export class StreamingRenderer {
  private fullResponse = "";
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

  hasStreamRenderedMarkdown(): boolean {
    return this.hasRenderedMarkdown;
  }

  getLastRenderedText(): string {
    return this.lastRenderedText;
  }

  appendDelta(delta: string): void {
    this.fullResponse += delta;

    if (!this.hasRenderedMarkdown) {
      this.transcript.renderPlainTextContent(this.bubble, this.fullResponse);
    }

    this.queueRender();
    this.transcript.scrollToBottom();
  }

  showToolStatus(toolName: string): void {
    this.toolStatusText = TOOL_STATUS_LABELS[toolName] ?? `Running ${toolName}...`;
    // Bypass the debounce so the status is visible before the tool completes.
    this.queuedText = this.fullResponse;
    this.renderChain = this.renderChain.then(() => this.renderOnce()).catch(() => undefined);
  }

  beginNewRound(): void {
    this.toolStatusText = "";
    // Render immediately so the status clears as soon as the next round starts.
    this.queuedText = this.fullResponse;
    this.renderChain = this.renderChain.then(() => this.renderOnce()).catch(() => undefined);
  }

  private queueRender(): void {
    this.queuedText = this.fullResponse;
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
