import type {
  Message,
  OpenAIContentPart,
} from "../shared/types";
import type {
  ChatAssistantContentItem,
  ChatRequest,
} from "../shared/chatRequest";
import type { ToolResultImage } from "../tools/types";
import { formatRagContext } from "../rag/formatContext";
import {
  formatAdditionalContextItem,
  formatDocumentContext,
  formatNoteAttachment,
  noteImageLabel,
  toolImageLabel,
} from "./contextFormatting";
import {
  appendNoteImageContextToOpenAIMessage,
  appendTextToOpenAIMessage,
} from "./openAiMessageContent";

/**
 * Build the shared OpenAI-compatible history wire representation.
 *
 * Images a tool read returned cannot ride the `tool` message: this wire format admits
 * text parts only there. They ride one synthesized `user` message emitted after the
 * round's last tool message, which is the only legal placement (RFC-0021 D5), and the
 * builder owns that emission so the loop's history stays provider-agnostic and a
 * parallel batch gets one message after all of its results rather than one per result.
 */
export function buildOpenAICompatibleMessages(
  request: ChatRequest,
): Message[] {
  const messages: Message[] = [];

  if (request.systemPrompt) {
    messages.push({ role: "system", content: request.systemPrompt });
  }

  // Images buffered across a run of consecutive tool turns, flushed when the run ends.
  let pendingToolImages: ToolResultImage[] = [];
  // The last message built from a real `user` turn. The per-round context tail targets
  // this and only when it is still the last message, so a synthesized image message
  // never attracts it: the round shape must not depend on whether an image was read
  // (RFC-0021 P4, M5).
  let lastUserTurnIndex = -1;

  const flushToolImages = () => {
    if (pendingToolImages.length === 0) return;
    messages.push(toolImageMessage(pendingToolImages));
    pendingToolImages = [];
  };

  for (const turn of request.messages) {
    if (turn.role !== "tool") flushToolImages();
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
      if (turn.toolResultImages?.length) {
        pendingToolImages.push(...turn.toolResultImages);
      }
    } else if (turn.role === "user" && turn.attachments?.length) {
      lastUserTurnIndex = messages.length;
      messages.push({
        role: "user",
        content: attachedUserContent(turn),
      });
    } else {
      if (turn.role === "user") lastUserTurnIndex = messages.length;
      messages.push({
        role: turn.role,
        content: turn.content ?? "",
      });
    }
  }
  flushToolImages();

  appendRequestContext(messages, request, lastUserTurnIndex);
  return messages;
}

/**
 * The one synthesized `user` message a round's images ride, label then picture per
 * image. It is the only place this plugin puts words in the user's mouth, which is why
 * the label is not optional.
 */
function toolImageMessage(images: ToolResultImage[]): Message {
  const parts: OpenAIContentPart[] = [];
  for (const image of images) {
    parts.push({ type: "text", text: toolImageLabel(image.path) });
    parts.push({
      type: "image_url",
      image_url: { url: `data:${image.mimeType};base64,${image.data}` },
    });
  }
  return { role: "user", content: parts };
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

/**
 * The live per-round tail: the document under edit, extra context notes, note images
 * and RAG. It rides the latest real user turn, and only while that turn is still the
 * last message. On a tool round the last message is a `tool` message, so none of this
 * is sent, which is what the OpenAI path has always done; a synthesized image message
 * must not change that (RFC-0021 P4). Targeting the recorded user index rather than
 * "the last message" is what makes the two cases the same code path.
 */
function appendRequestContext(
  messages: Message[],
  request: ChatRequest,
  lastUserTurnIndex: number,
): void {
  if (lastUserTurnIndex < 0 || lastUserTurnIndex !== messages.length - 1) return;
  const last = messages[lastUserTurnIndex];

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

  if (request.noteImageContext?.length) {
    appendNoteImageContextToOpenAIMessage(last, request.noteImageContext);
  }

  if (request.ragContext?.length) {
    appendTextToOpenAIMessage(last, formatRagContext(request.ragContext));
  }
}
