import type { RagContextBlock } from "../shared/chatRequest";

/**
 * Reorder chunks using the "sandwich" strategy to mitigate the
 * "lost in the middle" problem: LLMs attend most to the beginning
 * and end of context, so place the best chunks there.
 *
 * Given relevance-ranked chunks [1, 2, 3, 4, 5], reorders to
 * [1, 4, 5, 3, 2] — best at start, second-best at end.
 * Only applied when there are more than 3 chunks.
 */
function sandwichOrder<T>(items: T[]): T[] {
  if (items.length <= 3) return items;

  // Place the best item first and the second-best last.
  // Weaker items go in the middle where LLM attention is lowest.
  // For [1,2,3,4,5] → [1, 4, 5, 3, 2]
  const result: T[] = new Array(items.length);
  let left = 0;
  let right = items.length - 1;

  for (let i = 0; i < items.length; i++) {
    if (i % 2 === 0) {
      result[left++] = items[i];
    } else {
      result[right--] = items[i];
    }
  }

  return result;
}

/**
 * Format RAG context blocks into an XML-delimited string for injection
 * into the LLM prompt. Chunks are reordered using the sandwich strategy
 * and wrapped in clear delimiters so the model can distinguish sources.
 */
export function formatRagContext(blocks: RagContextBlock[]): string {
  if (blocks.length === 0) return "";

  const ordered = sandwichOrder(blocks);

  const entries = ordered.map((b) => {
    const section = b.headingPath ? ` section="${b.headingPath}"` : "";
    let inner = b.content;

    if (b.graphContext && (b.graphContext.entities.length > 0 || b.graphContext.relationships.length > 0)) {
      const parts: string[] = [];
      for (const e of b.graphContext.entities) {
        parts.push(`<entity name="${e.name}" type="${e.type}">${e.description}</entity>`);
      }
      for (const r of b.graphContext.relationships) {
        parts.push(`<rel source="${r.source}" target="${r.target}" type="${r.type}">${r.description}</rel>`);
      }
      inner += `\n<graph_context>\n${parts.join("\n")}\n</graph_context>`;
    }

    return `<document source="${b.filePath}"${section}>\n${inner}\n</document>`;
  });

  return `<retrieved_context>\n${entries.join("\n\n")}\n</retrieved_context>`;
}
