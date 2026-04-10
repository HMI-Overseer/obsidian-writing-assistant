import { findPartialBlock } from "../../editing/parseEditBlocks";
import type { BubbleRefs } from "../types";
import type { ChatTranscript } from "../messages/ChatTranscript";
import { TOOL_STATUS_LABELS } from "../../tools/metadata";

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
  /** Accumulated response across all agentic rounds. */
  private accumulatedProse = "";
  private lastRenderedText = "";
  private renderTimer: number | null = null;
  private renderChain = Promise.resolve();
  private readonly useToolMode: boolean;
  private toolStatusText = "";

  constructor(
    private readonly bubble: BubbleRefs,
    private readonly transcript: ChatTranscript,
    options?: { useToolMode?: boolean },
  ) {
    this.useToolMode = options?.useToolMode ?? false;
  }

  getFullResponse(): string {
    return this.accumulatedProse + this.fullResponse;
  }

  appendDelta(delta: string): void {
    this.fullResponse += delta;
    this.queueRender();
    this.transcript.scrollToBottom();
  }

  /** Show a status message while a read-only tool is being executed. */
  showToolStatus(toolName: string): void {
    this.toolStatusText = TOOL_STATUS_LABELS[toolName] ?? `Running ${toolName}...`;
    this.queueRender();
  }

  /** Prepare for a new streaming round after read-only tool execution. */
  beginNewRound(): void {
    this.accumulatedProse += this.fullResponse;
    this.fullResponse = "";
    this.toolStatusText = "";
    this.lastRenderedText = "";
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
      const allProse = (this.accumulatedProse + text).trim();
      const statusLine = this.toolStatusText || "*Composing edits...*";
      displayText = allProse
        ? allProse + "\n\n" + statusLine
        : statusLine;
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
