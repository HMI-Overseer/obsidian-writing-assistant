import { findPartialBlock } from "../../editing/parseEditBlocks";
import type { BubbleRefs } from "../types";
import type { ChatTranscript } from "../messages/ChatTranscript";

const STREAMING_RENDER_DEBOUNCE_MS = 100;

/**
 * Streaming renderer for edit mode.
 *
 * Accumulates deltas like StreamingRenderer, but also detects edit blocks
 * in progress and shows a "composing edit" indicator for incomplete blocks.
 * Complete blocks are shown as lightweight previews during streaming.
 */
export class EditStreamingRenderer {
  private fullResponse = "";
  private lastRenderedText = "";
  private renderTimer: number | null = null;
  private renderChain = Promise.resolve();

  constructor(
    private readonly bubble: BubbleRefs,
    private readonly transcript: ChatTranscript
  ) {}

  getFullResponse(): string {
    return this.fullResponse;
  }

  appendDelta(delta: string): void {
    this.fullResponse += delta;
    this.queueRender();
    this.transcript.scrollToBottom();
  }

  private queueRender(): void {
    if (this.renderTimer !== null) return;

    this.renderTimer = window.setTimeout(() => {
      this.renderTimer = null;
      this.renderChain = this.renderChain
        .then(() => this.renderStreamingPreview())
        .catch(() => undefined);
    }, STREAMING_RENDER_DEBOUNCE_MS);
  }

  private async renderStreamingPreview(): Promise<void> {
    const text = this.fullResponse;
    if (!text || text === this.lastRenderedText || !this.bubble.contentEl.isConnected) {
      return;
    }

    const { completeBlocks, hasIncompleteBlock } = findPartialBlock(text);

    // Build a preview display
    let prosePreview = text;
    for (const block of completeBlocks) {
      prosePreview = prosePreview.replace(block.rawBlock, "");
    }
    prosePreview = prosePreview.replace(/\n{3,}/g, "\n\n").trim();

    // Build the display text for the streaming preview
    const parts: string[] = [];

    if (prosePreview) {
      parts.push(prosePreview);
    }

    if (completeBlocks.length > 0) {
      parts.push(`\n\n---\n*${completeBlocks.length} edit${completeBlocks.length !== 1 ? "s" : ""} detected*`);
    }

    if (hasIncompleteBlock) {
      parts.push(`\n\n*Composing edit...*`);
    }

    const displayText = parts.join("") || "*Composing response...*";

    await this.transcript.renderBubbleContent(this.bubble, displayText, {
      preserveStreaming: true,
    });
    this.lastRenderedText = text;
    this.transcript.scrollToBottom();
  }

  async flush(): Promise<void> {
    if (this.renderTimer !== null) {
      window.clearTimeout(this.renderTimer);
      this.renderTimer = null;
    }

    this.renderChain = this.renderChain
      .then(() => this.renderStreamingPreview())
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
