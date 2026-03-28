import { Notice } from "obsidian";
import type LMStudioWritingAssistant from "../../main";
import type { BubbleRefs } from "../types";
import { makeMessage } from "../conversation/conversationUtils";
import type { ChatSessionStore } from "../conversation/ChatSessionStore";
import type { ChatTranscript } from "../messages/ChatTranscript";
import type { StreamingRenderer } from "./StreamingRenderer";

export async function finalizeResponse(
  store: ChatSessionStore,
  transcript: ChatTranscript,
  bubble: BubbleRefs,
  renderer: StreamingRenderer,
  autoInsertAfterResponse: boolean,
  plugin: LMStudioWritingAssistant
): Promise<void> {
  const fullResponse = renderer.getFullResponse();

  if (fullResponse) {
    const assistantMessage = makeMessage("assistant", fullResponse);
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
  renderer: StreamingRenderer
): Promise<void> {
  const fullResponse = renderer.getFullResponse();

  if (fullResponse) {
    const assistantMessage = makeMessage("assistant", fullResponse);
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
