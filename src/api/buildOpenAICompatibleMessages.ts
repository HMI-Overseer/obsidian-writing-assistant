import type {
  Message,
  OpenAIContentPart,
} from "../shared/types";
import type {
  ChatAssistantContentItem,
  ChatRequest,
} from "../shared/chatRequest";
import { formatRagContext } from "../rag/formatContext";
import {
  formatAdditionalContextItem,
  formatDocumentContext,
  formatNoteAttachment,
  noteImageLabel,
} from "./contextFormatting";
import {
  appendNoteImageContextToOpenAIMessage,
  appendTextToOpenAIMessage,
} from "./openAiMessageContent";

/** Build the shared OpenAI-compatible history wire representation. */
export function buildOpenAICompatibleMessages(
  request: ChatRequest,
): Message[] {
  const messages: Message[] = [];

  if (request.systemPrompt) {
    messages.push({ role: "system", content: request.systemPrompt });
  }

  for (const turn of request.messages) {
    if (turn.role === "assistant" && turn.assistantContent) {
      messages.push(orderedAssistantMessage(turn.assistantContent));
    } else if (
      turn.role === "assistant" &&
      turn.toolCalls &&
      turn.toolCalls.length > 0
    ) {
      messages.push({
        role: "assistant",
        content: turn.content || null,
        tool_calls: turn.toolCalls.map((toolCall) => ({
          id: toolCall.id,
          type: "function" as const,
          function: {
            name: toolCall.name,
            arguments: JSON.stringify(toolCall.arguments),
          },
        })),
      });
    } else if (turn.role === "tool") {
      messages.push({
        role: "tool",
        content: turn.content ?? "",
        tool_call_id: turn.toolCallId,
      });
    } else if (turn.role === "user" && turn.attachments?.length) {
      messages.push({
        role: "user",
        content: attachedUserContent(turn),
      });
    } else {
      messages.push({
        role: turn.role,
        content: turn.content ?? "",
      });
    }
  }

  appendRequestContext(messages, request);
  return messages;
}

function orderedAssistantMessage(
  content: ChatAssistantContentItem[],
): Message {
  const text = content
    .flatMap((item) => (item.type === "prose" ? [item.text] : []))
    .join("");
  const toolCalls = content.flatMap((item) =>
    item.type === "tool_call"
      ? [
          {
            id: item.toolCallId,
            type: "function" as const,
            function: {
              name: item.toolName,
              arguments: item.toolArguments,
            },
          },
        ]
      : [],
  );
  return {
    role: "assistant",
    content: text || null,
    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
  };
}

function attachedUserContent(
  turn: ChatRequest["messages"][number],
): OpenAIContentPart[] {
  const parts: OpenAIContentPart[] = [];
  if (turn.content) {
    parts.push({ type: "text", text: turn.content });
  }
  for (const attachment of turn.attachments ?? []) {
    if (attachment.type === "note") {
      parts.push({
        type: "text",
        text: formatNoteAttachment(attachment),
      });
    }
  }
  for (const attachment of turn.attachments ?? []) {
    if (attachment.type !== "image") continue;
    if (attachment.sourceNotePath) {
      parts.push({
        type: "text",
        text: noteImageLabel(
          attachment.sourceNotePath,
          attachment.fileName ?? "image",
        ),
      });
    }
    parts.push({
      type: "image_url",
      image_url: {
        url: `data:${attachment.mimeType};base64,${attachment.data}`,
      },
    });
  }
  return parts;
}

function appendRequestContext(
  messages: Message[],
  request: ChatRequest,
): void {
  if (
    messages.length > 0 &&
    messages[messages.length - 1].role === "user"
  ) {
    const last = messages[messages.length - 1];
    if (request.documentContext) {
      appendTextToOpenAIMessage(
        last,
        formatDocumentContext(request.documentContext),
      );
    }
    for (const item of request.additionalContextItems ?? []) {
      appendTextToOpenAIMessage(
        last,
        formatAdditionalContextItem(item),
      );
    }
  }

  if (
    request.noteImageContext?.length &&
    messages.length > 0 &&
    messages[messages.length - 1].role === "user"
  ) {
    appendNoteImageContextToOpenAIMessage(
      messages[messages.length - 1],
      request.noteImageContext,
    );
  }

  if (
    request.ragContext?.length &&
    messages.length > 0 &&
    messages[messages.length - 1].role === "user"
  ) {
    appendTextToOpenAIMessage(
      messages[messages.length - 1],
      formatRagContext(request.ragContext),
    );
  }
}
