import type { Component } from "obsidian";
import { Notice } from "obsidian";
import { createChatClient } from "../../providers/registry";
import { buildSamplingParams } from "./buildSamplingParams";
import type LMStudioWritingAssistant from "../../main";
import type { ChatComposer } from "../composer/ChatComposer";
import type { ChatSessionStore } from "../conversation/ChatSessionStore";
import type { ChatTranscript } from "../messages/ChatTranscript";
import type { ChatModelSelector } from "../models/ChatModelSelector";
import { makeMessage } from "../conversation/conversationUtils";
import { validateSendRequest } from "./validateSendRequest";
import { prepareApiMessages } from "./prepareApiMessages";
import { StreamingRenderer } from "./StreamingRenderer";
import { EditStreamingRenderer } from "./EditStreamingRenderer";
import { finalizeResponse, finalizeAbortedResponse } from "./finalizeResponse";
import { finalizeEditResponse } from "./finalizeEditResponse";
import { READ_ONLY_TOOL_NAMES } from "../../tools/editing/definition";
import { executeReadOnlyTool } from "../../tools/editing/handlers";
import type { ToolCall } from "../../tools/types";
import type { ChatTurn } from "../../shared/chatRequest";
import { estimateTokenCount } from "../../shared/tokenEstimation";
import { CONTEXT_DANGER_THRESHOLD } from "../../constants";
import type { UsageResult } from "../../api/usageTypes";

/** Maximum number of read-only tool rounds before forcing finalization. */
const MAX_TOOL_ROUNDS = 5;

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return "Unknown error";
}

export type SendMessageOptions = {
  plugin: LMStudioWritingAssistant;
  owner: Component;
  store: ChatSessionStore;
  transcript: ChatTranscript;
  composer: ChatComposer;
  modelSelector: ChatModelSelector;
  getIsGenerating: () => boolean;
  setIsGenerating: (sending: boolean) => void;
  setActiveAbortController: (controller: AbortController | null) => void;
  syncConversationUi: () => Promise<void>;
  onCalibrate?: (estimatedTokens: number, actualTokens: number) => void;
  promptOverride?: string;
  autoInsertAfterResponse?: boolean;
  editMode?: boolean;
};

export async function sendMessage(options: SendMessageOptions): Promise<void> {
  const {
    plugin,
    owner,
    store,
    transcript,
    composer,
    modelSelector,
    getIsGenerating,
    setIsGenerating,
    setActiveAbortController,
    syncConversationUi,
    onCalibrate,
    promptOverride,
    autoInsertAfterResponse = false,
    editMode = false,
  } = options;

  const validated = await validateSendRequest(
    store,
    composer,
    modelSelector,
    getIsGenerating(),
    promptOverride
  );
  if (!validated) return;

  const { text, activeModel } = validated;

  // Skip any pending hunks from previous edit proposals
  const history = store.getSnapshot().messageHistory;
  let proposalChanged = false;
  for (const msg of history) {
    if (msg.editProposal) {
      for (const hunk of msg.editProposal.hunks) {
        if (hunk.status === "pending") {
          hunk.status = "rejected";
          proposalChanged = true;
        }
      }
    }
  }
  if (proposalChanged) {
    await store.persistActiveConversation();
    await syncConversationUi();
  }

  composer.clearDraft();
  store.setDraft("");
  setIsGenerating(true);

  if (store.ensureConversationTitleFromFirstUserMessage(text)) {
    await syncConversationUi();
  }

  const userMessage = makeMessage("user", text);
  const userBubble = transcript.createBubble("user");
  await transcript.renderBubbleContent(userBubble, text);
  store.appendMessage(userMessage);
  transcript.setEmptyStateVisible(false);

  const apiMessages = await prepareApiMessages({
    app: plugin.app,
    store,
    settings: plugin.settings,
    includeNoteContext: plugin.settings.includeNoteContext,
    sessionContextEnabled: composer.isSessionContextEnabled(),
    maxContextChars: plugin.settings.maxContextChars,
    mode: editMode ? "edit" : "conversation",
    ragService: plugin.ragService,
    activeProvider: activeModel.provider,
    modelCapabilities: {
      trainedForToolUse: activeModel.trainedForToolUse
        ?? plugin.modelAvailability.getTrainedForToolUse(activeModel.modelId),
    },
  });

  const ragSources = apiMessages.ragContext?.map(({ filePath, headingPath, score, content }) =>
    ({ filePath, headingPath, score, content })
  );

  // Attach Anthropic cache settings if enabled on the active model.
  if (activeModel.anthropicCacheSettings?.enabled) {
    apiMessages.anthropicCacheSettings = activeModel.anthropicCacheSettings;
  }

  await store.persistActiveConversation();

  const assistantBubble = transcript.createBubble("assistant");
  assistantBubble.bodyEl.addClass("is-streaming");

  const useToolMode = editMode && !!apiMessages.tools?.length;
  const renderer = editMode
    ? new EditStreamingRenderer(assistantBubble, transcript, { useToolMode })
    : new StreamingRenderer(assistantBubble, transcript);

  // Pre-send context capacity check.
  const contextWindow = activeModel.contextWindowSize
    ?? plugin.modelAvailability.getActiveContextLength(activeModel.modelId);
  if (contextWindow) {
    const estimatedTokens = estimateTokenCount(apiMessages);
    if (estimatedTokens / contextWindow >= CONTEXT_DANGER_THRESHOLD) {
      const pct = Math.round((estimatedTokens / contextWindow) * 100);
      new Notice(`Context is ~${pct}% full. The model may truncate older messages.`);
    }
  }

  const client = createChatClient(activeModel.provider, plugin.settings.providerSettings);
  const abortController = new AbortController();
  setActiveAbortController(abortController);

  try {
    const toolLoopTurns: ChatTurn[] = [];
    let allWriteToolCalls: ToolCall[] = [];
    let previousRoundsText = "";
    let finalUsage: UsageResult | null = null;
    let calibrated = false;

    for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
      const requestMessages = [...apiMessages.messages, ...toolLoopTurns];
      const roundRequest = { ...apiMessages, messages: requestMessages };

      const streamResult = client.stream(
        roundRequest,
        activeModel.modelId,
        buildSamplingParams(plugin.settings),
        abortController.signal
      );

      for await (const delta of streamResult.deltas) {
        renderer.appendDelta(delta);
      }

      const usage = await streamResult.usage;
      const toolCalls = await streamResult.toolCalls;
      const stopReason = await streamResult.stopReason;

      if (usage && onCalibrate && !calibrated) {
        const estimated = estimateTokenCount(roundRequest);
        onCalibrate(estimated, usage.inputTokens);
        calibrated = true;
      }
      if (usage) finalUsage = usage;

      const totalText = renderer instanceof EditStreamingRenderer
        ? renderer.getFullResponse()
        : (renderer as StreamingRenderer).getFullResponse();
      const roundText = totalText.slice(previousRoundsText.length);

      const hasToolCalls = toolCalls !== null && toolCalls.length > 0;

      const textContent = roundText.trim();
      const looksLikeFailedToolCall = !hasToolCalls && (
        !textContent
        || textContent.startsWith("[TOOL_CALLS]")
        || textContent.startsWith("[TOOL_REQUEST]")
        || (stopReason === "tool_use")
      );

      if (looksLikeFailedToolCall) {
        throw new Error(
          "The model attempted a tool call but failed to generate valid output. " +
          "Try regenerating or switching to a more capable model."
        );
      }

      if (!hasToolCalls) break;

      const readOnlyCalls = toolCalls!.filter((tc) => READ_ONLY_TOOL_NAMES.has(tc.name));
      const writeCalls = toolCalls!.filter((tc) => !READ_ONLY_TOOL_NAMES.has(tc.name));
      allWriteToolCalls = [...allWriteToolCalls, ...writeCalls];

      if (readOnlyCalls.length > 0 && writeCalls.length === 0 && round < MAX_TOOL_ROUNDS) {
        const filePath = apiMessages.documentContext?.filePath;
        if (!filePath) break;

        const assistantTurn: ChatTurn = {
          role: "assistant",
          content: roundText || null,
          toolCalls: readOnlyCalls.map((tc) => ({
            id: tc.id,
            name: tc.name,
            arguments: tc.arguments,
          })),
        };
        toolLoopTurns.push(assistantTurn);

        for (const tc of readOnlyCalls) {
          if (renderer instanceof EditStreamingRenderer) {
            renderer.showToolStatus(tc.name);
          }

          const result = await executeReadOnlyTool(tc, { app: plugin.app, filePath });
          toolLoopTurns.push({
            role: "tool",
            content: result.content,
            toolCallId: tc.id,
          });
        }

        previousRoundsText = totalText;

        if (renderer instanceof EditStreamingRenderer) {
          renderer.beginNewRound();
        }

        continue;
      }

      break;
    }

    const finalToolCalls = allWriteToolCalls.length > 0 ? allWriteToolCalls : null;

    await renderer.flush();
    assistantBubble.bodyEl.removeClass("is-streaming");

    if (editMode && renderer instanceof EditStreamingRenderer) {
      await finalizeEditResponse({
        app: plugin.app,
        owner,
        store,
        transcript,
        bubble: assistantBubble,
        renderer,
        plugin,
        modelId: activeModel.modelId,
        provider: activeModel.provider,
        usage: finalUsage,
        toolCalls: finalToolCalls,
      });
    } else {
      await finalizeResponse(
        store,
        transcript,
        assistantBubble,
        renderer as StreamingRenderer,
        autoInsertAfterResponse,
        plugin,
        activeModel.modelId,
        activeModel.provider,
        finalUsage,
        ragSources
      );
    }

  } catch (error) {
    await renderer.flush();
    assistantBubble.bodyEl.removeClass("is-streaming");

    if (isAbortError(error)) {
      if (editMode && renderer instanceof EditStreamingRenderer) {
        // In edit mode, still try to finalize any complete blocks on abort
        await finalizeEditResponse({
          app: plugin.app,
          owner,
          store,
          transcript,
          bubble: assistantBubble,
          renderer,
          plugin,
          modelId: activeModel.modelId,
          provider: activeModel.provider,
        });
      } else {
        await finalizeAbortedResponse(store, transcript, assistantBubble, renderer as StreamingRenderer,
          activeModel.modelId, activeModel.provider, ragSources);
      }
    } else {
      const errorText = `Error: ${getErrorMessage(error)}`;
      const errorMessage = makeMessage("assistant", errorText);
      errorMessage.isError = true;
      errorMessage.modelId = activeModel.modelId;
      errorMessage.provider = activeModel.provider;
      store.appendMessage(errorMessage);

      assistantBubble.bodyEl.addClass("is-error");
      transcript.renderPlainTextContent(assistantBubble, errorText);
    }
  } finally {
    setActiveAbortController(null);
    await store.persistActiveConversation();
    setIsGenerating(false);
    renderer.destroy();
    await syncConversationUi();
  }
}
