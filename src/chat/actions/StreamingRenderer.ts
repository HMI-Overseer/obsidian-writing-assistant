import type { BubbleRefs } from "../types";
import type { ChatTranscript } from "../messages/ChatTranscript";

const STREAMING_MARKDOWN_RENDER_DEBOUNCE_MS = 80;

export class StreamingRenderer {
  private fullResponse = "";
  private hasRenderedMarkdown = false;
  private lastRenderedText = "";
  private queuedText = "";
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

  private queueRender(): void {
    this.queuedText = this.fullResponse;
    if (this.renderTimer !== null) return;

    this.renderTimer = window.setTimeout(() => {
      this.renderTimer = null;
      this.renderChain = this.renderChain
        .then(async () => {
          const textToRender = this.queuedText;
          if (
            !textToRender ||
            textToRender === this.lastRenderedText ||
            !this.bubble.contentEl.isConnected
          ) {
            return;
          }

          await this.transcript.renderBubbleContent(this.bubble, textToRender, {
            preserveStreaming: true,
          });
          this.hasRenderedMarkdown = true;
          this.lastRenderedText = textToRender;
          this.transcript.scrollToBottom();
        })
        .catch(() => undefined);
    }, STREAMING_MARKDOWN_RENDER_DEBOUNCE_MS);
  }

  async flush(): Promise<void> {
    if (this.renderTimer !== null) {
      window.clearTimeout(this.renderTimer);
      this.renderTimer = null;
    }

    this.renderChain = this.renderChain
      .then(async () => {
        const textToRender = this.queuedText;
        if (
          !textToRender ||
          textToRender === this.lastRenderedText ||
          !this.bubble.contentEl.isConnected
        ) {
          return;
        }

        await this.transcript.renderBubbleContent(this.bubble, textToRender, {
          preserveStreaming: true,
        });
        this.hasRenderedMarkdown = true;
        this.lastRenderedText = textToRender;
        this.transcript.scrollToBottom();
      })
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
