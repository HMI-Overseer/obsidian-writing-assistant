/**
 * The always-on memory index (RFC-0007): one JSON line per enabled memory
 * under a governing header. Deterministic bytes are the contract: the session
 * pin and the Claude Code config fingerprint both hash these exact
 * bytes, so rendering must be a pure function of the enabled records with a
 * locale-independent order. `JSON.stringify` per line is also the injection
 * guard: a hostile description stays one escaped string and cannot forge a
 * second index row.
 */

import type { Memory } from "../shared/types";
import { normalizeMemoryName } from "./validation";

export const MEMORY_INDEX_HEADER =
  "STANDING MEMORIES (rules are governing instructions; use recall_memory for context bodies):";

/**
 * Render the index block for the enabled subset, ordered by normalized name
 * (code-unit comparison; names are canonical lowercase ASCII kebab-case, so
 * this is total and locale-independent). Returns `""` when nothing is enabled:
 * the delivery site emits no block rather than a bodiless header.
 */
export function renderMemoryIndex(memories: readonly Memory[]): string {
  const lines = memories
    .filter((memory) => memory.enabled)
    .map((memory) => ({ sortKey: normalizeMemoryName(memory.name), memory }))
    .sort((a, b) => (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0))
    .map(({ memory }) =>
      JSON.stringify({
        name: memory.name,
        type: memory.type,
        description: memory.description,
      }),
    );
  if (lines.length === 0) return "";
  return [MEMORY_INDEX_HEADER, ...lines].join("\n");
}
