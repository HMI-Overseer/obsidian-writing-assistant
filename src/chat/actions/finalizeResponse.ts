import { Notice } from "obsidian";
import type LMStudioWritingAssistant from "../../main";
import type { ProviderOption } from "../../shared/types";
import type { UsageResult } from "../../api/usageTypes";
import type { BubbleRefs } from "../types";
import { makeMessage } from "../conversation/conversationUtils";
import type { ChatSessionStore } from "../conversation/ChatSessionStore";
import type { ChatTranscript } from "../messages/ChatTranscript";
import type { StreamingRenderer } from "./StreamingRenderer";
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
    message.usage = {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      ...(usage.cacheCreationInputTokens !== undefined && { cacheCreationInputTokens: usage.cacheCreationInputTokens }),
      ...(usage.cacheReadInputTokens !== undefined && { cacheReadInputTokens: usage.cacheReadInputTokens }),
      ...(modelId && { estimatedCostUsd: estimateCost(modelId, usage) ?? undefined }),
    };
  }
}

export async function finalizeResponse(
  store: ChatSessionStore,
  transcript: ChatTranscript,
  bubble: BubbleRefs,
  renderer: StreamingRenderer,
  autoInsertAfterResponse: boolean,
  plugin: LMStudioWritingAssistant,
  modelId?: string,
  provider?: ProviderOption,
  usage?: UsageResult | null
): Promise<void> {
  const fullResponse = renderer.getFullResponse();

  if (fullResponse) {
    const assistantMessage = makeMessage("assistant", fullResponse);
    attachUsageToMessage(assistantMessage, modelId, provider, usage);
    store.appendMessage(assistantMessage);
    store.setLastAssistantResponse(fullResponse);

    if (
      !renderer.hasStreamRenderedMarkdown() ||
      renderer.getLastRenderedText() !== fullResponse
    ) {
      await transcript.renderBubbleContent(bubble, fullResponse);
    }

    if (autoInsertAfterResponse) {
      await insertLastResponse(plugin, fullResponse);
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
  provider?: ProviderOption
): Promise<void> {
  const fullResponse = renderer.getFullResponse();

  if (fullResponse) {
    const assistantMessage = makeMessage("assistant", fullResponse);
    attachUsageToMessage(assistantMessage, modelId, provider);
    store.appendMessage(assistantMessage);
    store.setLastAssistantResponse(fullResponse);

    if (
      !renderer.hasStreamRenderedMarkdown() ||
      renderer.getLastRenderedText() !== fullResponse
    ) {
      await transcript.renderBubbleContent(bubble, fullResponse);
    }
  } else {
    transcript.renderPlainTextContent(bubble, "Generation stopped.");
    bubble.bodyEl.addClass("is-muted");
  }
}

async function insertLastResponse(
  plugin: LMStudioWritingAssistant,
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
    const content = await plugin.app.vault.read(file);
    await plugin.app.vault.modify(file, `${content}\n\n${lastAssistantResponse}`);
    new Notice("Response appended to note.");
    return;
  }

  new Notice("No active note to insert into.");
}
