import { Notice } from "obsidian";
import type WritingAssistantChat from "../../main";
import type { AgenticStep, ProviderOption, RagSourceRef } from "../../shared/types";
import type { UsageResult } from "../../api/usageTypes";
import type { BubbleRefs } from "../types";
import { GENERATION_STOPPED_LABEL } from "../types";
import { makeMessage } from "../conversation/conversationUtils";
import type { ChatSessionStore } from "../conversation/ChatSessionStore";
import type { ChatTranscript } from "../messages/ChatTranscript";
import type { StreamingRenderer } from "../streaming/StreamingRenderer";
import { estimateCost } from "../../api/pricing";

export function attachUsageToMessage(
  message: ReturnType<typeof makeMessage>,
  modelId?: string,
  provider?: ProviderOption,
  usage?: UsageResult | null
): void {
  if (modelId) message.modelId = modelId;
  if (provider) message.provider = provider;
  if (usage) {
    // Prefer a provider-reported cost (e.g. Claude Code's total_cost_usd); fall
    // back to the token-based estimate for providers with a known price table.
    const costUsd = usage.costUsd ?? (modelId ? estimateCost(modelId, usage) ?? undefined : undefined);
    message.usage = {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      ...(usage.cacheCreationInputTokens !== undefined && { cacheCreationInputTokens: usage.cacheCreationInputTokens }),
      ...(usage.cacheReadInputTokens !== undefined && { cacheReadInputTokens: usage.cacheReadInputTokens }),
      ...(usage.sessionReused !== undefined && { sessionReused: usage.sessionReused }),
      ...(usage.sessionResumed !== undefined && { sessionResumed: usage.sessionResumed }),
      ...(usage.sessionRebuildReason !== undefined && { sessionRebuildReason: usage.sessionRebuildReason }),
      ...(usage.resumeCursor !== undefined && { resumeCursor: usage.resumeCursor }),
      ...(usage.contextTokens !== undefined && { contextTokens: usage.contextTokens }),
      ...(usage.contextWindow !== undefined && { contextWindow: usage.contextWindow }),
      ...(costUsd !== undefined && { estimatedCostUsd: costUsd }),
    };
  }
}

export async function finalizeResponse(
  store: ChatSessionStore,
  transcript: ChatTranscript,
  bubble: BubbleRefs,
  renderer: StreamingRenderer,
  autoInsertAfterResponse: boolean,
  plugin: WritingAssistantChat,
  modelId?: string,
  provider?: ProviderOption,
  usage?: UsageResult | null,
  ragSources?: RagSourceRef[],
  rewrittenQuery?: string,
  agenticSteps?: AgenticStep[]
): Promise<void> {
  // In agentic multi-round sessions the bubble only shows the final round.
  // getCurrentRoundResponse() returns that slice; for single-round sessions it
  // equals getFullResponse().
  const response = renderer.getCurrentRoundResponse();

  if (response) {
    const assistantMessage = makeMessage("assistant", response);
    attachUsageToMessage(assistantMessage, modelId, provider, usage);
    if (ragSources) assistantMessage.ragSources = ragSources;
    if (rewrittenQuery) assistantMessage.rewrittenQuery = rewrittenQuery;
    if (agenticSteps?.length) assistantMessage.agenticSteps = agenticSteps;
    store.appendMessage(assistantMessage);
    store.setLastAssistantResponse(response);
    transcript.registerBubble(assistantMessage.id, bubble);

    if (
      !renderer.hasStreamRenderedMarkdown() ||
      renderer.getLastRenderedText() !== response
    ) {
      await transcript.renderBubbleContent(bubble, response);
    }

    if (autoInsertAfterResponse) {
      await insertLastResponse(plugin, response);
    }
  } else {
    transcript.renderPlainTextContent(bubble, "(no response)");
  }
}

export async function finalizeAbortedResponse(
  store: ChatSessionStore,
  transcript: ChatTranscript,
  bubble: BubbleRefs,
  renderer: StreamingRenderer,
  modelId?: string,
  provider?: ProviderOption,
  ragSources?: RagSourceRef[],
  rewrittenQuery?: string,
  agenticSteps?: AgenticStep[]
): Promise<void> {
  const response = renderer.getCurrentRoundResponse();

  if (response) {
    const assistantMessage = makeMessage("assistant", response);
    attachUsageToMessage(assistantMessage, modelId, provider);
    if (ragSources) assistantMessage.ragSources = ragSources;
    if (rewrittenQuery) assistantMessage.rewrittenQuery = rewrittenQuery;
    if (agenticSteps?.length) assistantMessage.agenticSteps = agenticSteps;
    // A partial reply is a truncated turn; the claudecode replay marks it so a
    // rebuild does not read it as complete (section 4.C).
    assistantMessage.interrupted = true;
    store.appendMessage(assistantMessage);
    store.setLastAssistantResponse(response);
    transcript.registerBubble(assistantMessage.id, bubble);

    if (
      !renderer.hasStreamRenderedMarkdown() ||
      renderer.getLastRenderedText() !== response
    ) {
      await transcript.renderBubbleContent(bubble, response);
    }
  } else {
    // A claudecode turn ALWAYS persists its aborted assistant message, even with
    // zero text: the live session banked an empty assistant turn in its watermark,
    // so the transcript must carry a matching empty turn or the next turn cold-
    // rebuilds with a mislabeled `turn-count` reason (cold-rebuild-fidelity section 6.1 /
    // question 7). Partial steps ride it for replay fidelity. Other providers keep
    // today's behavior (no empty turn appended, so their histories don't grow one).
    if (provider === "claudecode") {
      const assistantMessage = makeMessage("assistant", "");
      attachUsageToMessage(assistantMessage, modelId, provider);
      if (ragSources) assistantMessage.ragSources = ragSources;
      if (rewrittenQuery) assistantMessage.rewrittenQuery = rewrittenQuery;
      if (agenticSteps?.length) assistantMessage.agenticSteps = agenticSteps;
      // Even an empty stopped turn is interrupted: the replay gives it a body of its
      // partial steps' digest plus the interruption marker (section 4.C / section 6.1).
      assistantMessage.interrupted = true;
      store.appendMessage(assistantMessage);
      transcript.registerBubble(assistantMessage.id, bubble);
    }
    transcript.renderPlainTextContent(bubble, GENERATION_STOPPED_LABEL);
    bubble.bodyEl.addClass("is-muted");
  }
}

async function insertLastResponse(
  plugin: WritingAssistantChat,
  lastAssistantResponse: string
): Promise<void> {
  if (!lastAssistantResponse) return;

  const editor = plugin.app.workspace.activeEditor?.editor;
  if (editor) {
    const selection = editor.getSelection();
    if (selection) {
      editor.replaceSelection(lastAssistantResponse);
    } else {
      const cursor = editor.getCursor("to");
      editor.replaceRange(`\n\n${lastAssistantResponse}`, cursor);
    }
    new Notice("Response inserted into note.");
    return;
  }

  const file = plugin.app.workspace.getActiveFile();
  if (file) {
    await plugin.app.vault.process(file, (content) => `${content}\n\n${lastAssistantResponse}`);
    new Notice("Response appended to note.");
    return;
  }

  new Notice("No active note to insert into.");
}
