import type { Conversation, ConversationMessage, ConversationMeta } from "../../shared/types";
import { conversationDisplayTitle } from "./conversationUtils";

/** A conversation that matched a history search, with an optional body snippet. */
export interface ConversationSearchHit {
  meta: ConversationMeta;
  /**
   * A short excerpt of the message body around the match, present only when the
   * match was found in the body (not the title or model name). Undefined for a
   * title/model match, which is self-evident from the row itself.
   */
  snippet?: string;
}

/** Raw + normalized body text for one conversation, kept together to avoid re-normalizing on every keystroke. */
interface CachedBody {
  raw: string;
  norm: string;
}

export interface ConversationSearchDeps {
  /** Id of the conversation currently loaded in memory, or null. */
  getActiveId: () => string | null;
  /** Live messages of the active conversation (from ChatSessionMemory), searched fresh so unsaved turns are findable. */
  getActiveMessages: () => ConversationMessage[];
  /** Load a persisted conversation by id (from disk), or null if missing/corrupt. */
  loadConversation: (id: string) => Promise<Conversation | null>;
}

const SNIPPET_RADIUS = 40;

/**
 * Body search for the history drawer. Deliberately index-free: it scans normalized
 * message text on demand rather than maintaining an inverted index, which is the
 * professional-consensus choice for a bounded conversation set (an index only pays
 * off at large scale and adds staleness machinery this does not need). See
 * {@link ../../../../CLAUDE.md} pillars and ADR notes.
 *
 * The one concession to "long prose" threads is a per-conversation body cache so a
 * full scan of the drawer is not re-read from disk on every keystroke; the active
 * conversation is never cached (served live from memory, always fresh), and the
 * cache is invalidated per id on save/delete and cleared when the drawer closes.
 */
export class ConversationSearch {
  private readonly cache = new Map<string, CachedBody>();

  constructor(private readonly deps: ConversationSearchDeps) {}

  /**
   * Return the metas whose title, model name, or message body contains `query`
   * (case- and diacritic-insensitive), preserving the input order. An empty query
   * returns every meta unchanged. Body matches carry a display snippet.
   */
  async search(query: string, metas: ConversationMeta[]): Promise<ConversationSearchHit[]> {
    const needle = normalizeForSearch(query.trim());
    if (!needle) return metas.map((meta) => ({ meta }));

    const hits = await Promise.all(
      metas.map(async (meta): Promise<ConversationSearchHit | null> => {
        const metaHaystack = normalizeForSearch(`${conversationDisplayTitle(meta)} ${meta.modelName ?? ""}`);
        if (metaHaystack.includes(needle)) return { meta };

        const body = await this.bodyOf(meta.id);
        if (body && body.norm.includes(needle)) {
          return { meta, snippet: extractSnippet(body.raw, query.trim()) };
        }
        return null;
      }),
    );

    return hits.filter((hit): hit is ConversationSearchHit => hit !== null);
  }

  /** Drop one conversation's cached body (call after its stored file changes or is deleted). */
  invalidate(id: string): void {
    this.cache.delete(id);
  }

  /** Release all cached bodies (call when the drawer closes so long prose threads do not stay resident). */
  clear(): void {
    this.cache.clear();
  }

  private async bodyOf(id: string): Promise<CachedBody | null> {
    if (id === this.deps.getActiveId()) {
      // Never cached: the active thread's messages change under us, so read them live.
      const raw = bodyTextOf(this.deps.getActiveMessages());
      return { raw, norm: normalizeForSearch(raw) };
    }

    const cached = this.cache.get(id);
    if (cached) return cached;

    const conversation = await this.deps.loadConversation(id);
    if (!conversation) return null;

    const raw = bodyTextOf(conversation.messages);
    const entry: CachedBody = { raw, norm: normalizeForSearch(raw) };
    this.cache.set(id, entry);
    return entry;
  }
}

/**
 * Lowercase and strip diacritics so "Cafe" matches "café". Substring matching over
 * this form also sidesteps word segmentation entirely, so CJK text (which naive
 * word-tokenizing indexes mis-segment) searches correctly for free.
 */
export function normalizeForSearch(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
}

/** Join a conversation's non-error message contents into one searchable blob. */
function bodyTextOf(messages: ConversationMessage[]): string {
  return messages
    .filter((message) => !message.isError)
    .map((message) => message.content)
    .join("\n");
}

/**
 * Pull a short excerpt of `raw` around the first occurrence of `query`, with an
 * ellipsis where the text was clipped. Matching here is only case-insensitive (not
 * diacritic-insensitive) so excerpt offsets stay aligned with the raw text; on the
 * rare diacritic-only match it falls back to the start of the body.
 */
function extractSnippet(raw: string, query: string): string {
  const index = raw.toLowerCase().indexOf(query.toLowerCase());
  const start = index < 0 ? 0 : Math.max(0, index - SNIPPET_RADIUS);
  const end =
    index < 0
      ? Math.min(raw.length, SNIPPET_RADIUS * 2)
      : Math.min(raw.length, index + query.length + SNIPPET_RADIUS);

  let snippet = raw.slice(start, end).replace(/\s+/g, " ").trim();
  if (start > 0) snippet = `…${snippet}`;
  if (end < raw.length) snippet = `${snippet}…`;
  return snippet;
}
