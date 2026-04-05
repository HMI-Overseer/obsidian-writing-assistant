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
 *
 * When `useToolMode` is true, SEARCH/REPLACE block detection is skipped
 * entirely — tool calls are accumulated separately by the client. Only
 * prose text and a static "Composing edits..." indicator are shown.
 */
export class EditStreamingRenderer {
  private fullResponse = "";
  private lastRenderedText = "";
  private renderTimer: number | null = null;
  private renderChain = Promise.resolve();
  private readonly useToolMode: boolean;

  constructor(
    private readonly bubble: BubbleRefs,
    private readonly transcript: ChatTranscript,
    options?: { useToolMode?: boolean },
  ) {
    this.useToolMode = options?.useToolMode ?? false;
  }

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

    let displayText: string;

    if (this.useToolMode) {
      // Tool mode: prose text only — tool calls are accumulated by the client.
      const trimmed = text.trim();
      displayText = trimmed
        ? trimmed + "\n\n*Composing edits...*"
        : "*Composing edits...*";
    } else {
      const { completeBlocks, hasIncompleteBlock } = findPartialBlock(text);

      // Build a preview display
      let prosePreview = text;
      for (const block of completeBlocks) {
        prosePreview = prosePreview.replace(block.rawBlock, "");
      }
      prosePreview = prosePreview.replace(/\n{3,}/g, "\n\n").trim();

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

      displayText = parts.join("") || "*Composing response...*";
    }

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
