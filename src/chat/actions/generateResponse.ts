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
import { prepareApiMessages } from "./prepareApiMessages";
import { estimateTokenCount } from "../../shared/tokenEstimation";
import { StreamingRenderer } from "./StreamingRenderer";
import { EditStreamingRenderer } from "./EditStreamingRenderer";
import { finalizeResponse, finalizeAbortedResponse } from "./finalizeResponse";
import { finalizeEditResponse } from "./finalizeEditResponse";
import { READ_ONLY_TOOL_NAMES } from "../../tools/editing/definition";
import { executeReadOnlyTool } from "../../tools/editing/handlers";
import type { ToolCall } from "../../tools/types";
import type { ChatTurn } from "../../shared/chatRequest";
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

export type GenerateResponseOptions = {
  plugin: LMStudioWritingAssistant;
  owner: Component;
  store: ChatSessionStore;
  transcript: ChatTranscript;
  composer: ChatComposer;
  modelSelector: ChatModelSelector;
  getIsGenerating: () => boolean;
  setIsGenerating: (generating: boolean) => void;
  setActiveAbortController: (controller: AbortController | null) => void;
  syncConversationUi: () => Promise<void>;
  onCalibrate?: (estimatedTokens: number, actualTokens: number) => void;
};

export async function generateResponse(options: GenerateResponseOptions): Promise<void> {
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
  } = options;

  if (getIsGenerating()) return;

  const snapshot = store.getSnapshot();
  if (snapshot.messageHistory.length === 0) return;

  const lastMessage = snapshot.messageHistory[snapshot.messageHistory.length - 1];
  if (lastMessage.role !== "user" && !lastMessage.isError) return;

  const activeModel = store.getResolvedConversationModel();
  if (!activeModel?.modelId) {
    new Notice("No model selected.");
    return;
  }

  const availabilityState = await modelSelector.refreshAvailability();
  if (availabilityState !== "loaded" && availabilityState !== "cloud") {
    modelSelector.retriggerAttention();
    return;
  }

  // Remove trailing error messages before generating.
  let removed = false;
  while (store.getSnapshot().messageHistory.length > 0) {
    const msgs = store.getSnapshot().messageHistory;
    const tail = msgs[msgs.length - 1];
    if (tail.isError) {
      store.removeLastMessage();
      removed = true;
    } else {
      break;
    }
  }

  if (removed) {
    await store.persistActiveConversation();
    await syncConversationUi();
  }

  // After removing errors, verify we still have messages.
  if (store.getSnapshot().messageHistory.length === 0) return;

  const mode = composer.getMode();
  const editMode = mode === "edit";

  setIsGenerating(true);

  const apiMessages = await prepareApiMessages({
    app: plugin.app,
    store,
    settings: plugin.settings,
    includeNoteContext: plugin.settings.includeNoteContext,
    sessionContextEnabled: composer.isSessionContextEnabled(),
    maxContextChars: plugin.settings.maxContextChars,
    mode,
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

  if (activeModel.anthropicCacheSettings?.enabled) {
    apiMessages.anthropicCacheSettings = activeModel.anthropicCacheSettings;
  }

  const assistantBubble = transcript.createBubble("assistant");
  assistantBubble.bodyEl.addClass("is-streaming");

  const useToolMode = editMode && !!apiMessages.tools?.length;
  const renderer = editMode
    ? new EditStreamingRenderer(assistantBubble, transcript, { useToolMode })
    : new StreamingRenderer(assistantBubble, transcript);

  const client = createChatClient(activeModel.provider, plugin.settings.providerSettings);
  const abortController = new AbortController();
  setActiveAbortController(abortController);

  try {
    // Ephemeral tool-loop turns (not persisted to conversation history).
    const toolLoopTurns: ChatTurn[] = [];
    let allWriteToolCalls: ToolCall[] = [];
    let previousRoundsText = "";
    let finalUsage: UsageResult | null = null;
    let calibrated = false;

    for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
      // Build request: base messages + ephemeral tool loop turns.
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

      // Capture the text generated in this round only.
      const totalText = renderer instanceof EditStreamingRenderer
        ? renderer.getFullResponse()
        : (renderer as StreamingRenderer).getFullResponse();
      const roundText = totalText.slice(previousRoundsText.length);

      // Defensive: check tool_calls array directly, not just stopReason.
      // LM Studio can return finish_reason: "stop" with tool_calls populated.
      const hasToolCalls = toolCalls !== null && toolCalls.length > 0;

      // Detect failed tool calls: model stopped but produced nothing useful.
      // This catches: malformed JSON, truncated output, and raw tool-call text
      // that wasn't parsed into structured tool calls.
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

      // No tool calls — break and finalize with whatever text was generated.
      if (!hasToolCalls) break;

      // Separate read-only vs write tool calls.
      const readOnlyCalls = toolCalls!.filter((tc) => READ_ONLY_TOOL_NAMES.has(tc.name));
      const writeCalls = toolCalls!.filter((tc) => !READ_ONLY_TOOL_NAMES.has(tc.name));
      allWriteToolCalls = [...allWriteToolCalls, ...writeCalls];

      // If ALL tool calls are read-only, execute them and loop for another round.
      if (readOnlyCalls.length > 0 && writeCalls.length === 0 && round < MAX_TOOL_ROUNDS) {
        // Get the file path for tool execution context.
        const filePath = apiMessages.documentContext?.filePath;
        if (!filePath) break;

        // Add the assistant turn with tool calls to the ephemeral loop.
        // Content must be null (not "") per OpenAI spec when only tool calls are present.
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

        // Execute each read-only tool and append results.
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

        // Track accumulated text before resetting for the next round.
        previousRoundsText = totalText;

        // Reset the renderer for the next round's streaming output.
        if (renderer instanceof EditStreamingRenderer) {
          renderer.beginNewRound();
        }

        continue;
      }

      // Has write tool calls (or mixed) — break and finalize.
      break;
    }

    // Combine any tool calls from all rounds.
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
        false,
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
        await finalizeAbortedResponse(
          store,
          transcript,
          assistantBubble,
          renderer as StreamingRenderer,
          activeModel.modelId,
          activeModel.provider,
          ragSources
        );
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
