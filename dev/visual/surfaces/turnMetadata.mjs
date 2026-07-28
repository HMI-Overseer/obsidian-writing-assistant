import { view } from "../scaffold.mjs";
import {
  assistantBubble,
  assistantTurn,
  turnItem,
} from "../fixtures/chat.mjs";
import { I } from "../fixtures/icons.mjs";

const assistantProse = (text) =>
  turnItem(
    "prose-1",
    "prose",
    "iconless",
    `<p>${text}</p>`,
    { after: false, fade: true },
  );

const assistantMessageWithBadge = (text, badge) =>
  `<div class="lmsa-chat-window-message lmsa-chat-window-message--assistant">
    <div class="lmsa-chat-window-message-avatar">${I.bot}</div>
    <div class="lmsa-chat-window-message-column">
      <div class="lmsa-chat-window-message-chrome">
        <div class="lmsa-chat-window-message-role">Assistant</div>
      </div>
    </div>
    ${assistantTurn(assistantProse(text))}
    ${badge}
  </div>`;

export const TURN_METADATA_SURFACES = {
  // Retrieval metadata rendered after the ordered assistant items. Both details elements are
  // explicitly open because collapsed disclosure content is not visible in a static capture.
  ragSources: {
    source: "src/chat/messages/RagSourcesList.ts",
    w: 620,
    shot: ".lmsa-chat-window-rag-sources",
    html: view(
      assistantBubble(
        assistantTurn(
          assistantProse("The archive points to three scenes that establish the harbor conflict."),
          "completed",
          `<details class="lmsa-chat-window-rag-sources" open>
            <summary class="lmsa-chat-window-rag-sources-summary">3 vault sources</summary>
            <div class="lmsa-chat-window-rag-sources-list">
              <div class="lmsa-chat-window-rag-rewritten-query">Retrieved as: "harbor conflict early warnings"</div>
              <div class="lmsa-chat-window-rag-source-row">
                <a class="lmsa-chat-window-rag-source-link">World/Port Azure &gt; Guild dispute</a>
                <span class="lmsa-chat-window-rag-source-score">92%</span>
              </div>
              <div class="lmsa-chat-window-rag-source-row">
                <a class="lmsa-chat-window-rag-source-link">Drafts/Chapter 04 &gt; The council chamber</a>
                <span class="lmsa-chat-window-rag-source-score">84%</span>
              </div>
              <div class="lmsa-chat-window-rag-source-row">
                <a class="lmsa-chat-window-rag-source-link">Characters/Mara Venn</a>
                <span class="lmsa-chat-window-rag-source-score">71%</span>
              </div>
            </div>
          </details>`,
        ),
      ),
      620,
    ),
  },

  // Knowledge-graph metadata uses the same render source but a distinct nested disclosure with
  // entity type pills and deduplicated relation rows.
  knowledgeGraphContext: {
    source: "src/chat/messages/RagSourcesList.ts",
    w: 620,
    shot: ".lmsa-chat-window-graph-context",
    html: view(
      assistantBubble(
        assistantTurn(
          assistantProse("The graph connects Mara to the guild dispute and the Port Azure council."),
          "completed",
          `<details class="lmsa-chat-window-rag-sources" open>
            <summary class="lmsa-chat-window-rag-sources-summary">2 vault sources</summary>
            <div class="lmsa-chat-window-rag-sources-list">
              <div class="lmsa-chat-window-rag-source-row">
                <a class="lmsa-chat-window-rag-source-link">Characters/Mara Venn</a>
                <span class="lmsa-chat-window-rag-source-score">89%</span>
              </div>
              <div class="lmsa-chat-window-rag-source-row">
                <a class="lmsa-chat-window-rag-source-link">World/Port Azure</a>
                <span class="lmsa-chat-window-rag-source-score">82%</span>
              </div>
            </div>
            <details class="lmsa-chat-window-graph-context" open>
              <summary class="lmsa-chat-window-graph-context-summary">Graph: 5 entities, 3 relationships</summary>
              <div class="lmsa-chat-window-graph-entity-pills">
                <div class="lmsa-chat-window-graph-entity-pill" title="A cartographer caught between the council and the guild.">
                  <span class="lmsa-chat-window-graph-entity-type lmsa-chat-window-graph-entity-type--character">character</span>
                  <span class="lmsa-chat-window-graph-entity-name">Mara Venn</span>
                </div>
                <div class="lmsa-chat-window-graph-entity-pill">
                  <span class="lmsa-chat-window-graph-entity-type lmsa-chat-window-graph-entity-type--location">location</span>
                  <span class="lmsa-chat-window-graph-entity-name">Port Azure</span>
                </div>
                <div class="lmsa-chat-window-graph-entity-pill">
                  <span class="lmsa-chat-window-graph-entity-type lmsa-chat-window-graph-entity-type--event">event</span>
                  <span class="lmsa-chat-window-graph-entity-name">Guild dispute</span>
                </div>
                <div class="lmsa-chat-window-graph-entity-pill">
                  <span class="lmsa-chat-window-graph-entity-type lmsa-chat-window-graph-entity-type--object">object</span>
                  <span class="lmsa-chat-window-graph-entity-name">Harbor ledger</span>
                </div>
                <div class="lmsa-chat-window-graph-entity-pill">
                  <span class="lmsa-chat-window-graph-entity-type lmsa-chat-window-graph-entity-type--concept">concept</span>
                  <span class="lmsa-chat-window-graph-entity-name">Smuggling route</span>
                </div>
              </div>
              <div class="lmsa-chat-window-graph-relations">
                <div class="lmsa-chat-window-graph-relation">Mara Venn → investigates → Guild dispute</div>
                <div class="lmsa-chat-window-graph-relation">Guild dispute → occurs at → Port Azure</div>
                <div class="lmsa-chat-window-graph-relation">Harbor ledger → reveals → Smuggling route</div>
              </div>
            </details>
          </details>`,
        ),
      ),
      620,
    ),
  },

  // Two valid badge states: a metered cache-capable turn, then an older usage-less turn whose
  // compact face contains only the model id. The model for the first badge remains in its title.
  usageBadge: {
    source: "src/chat/messages/UsageBadge.ts",
    w: 620,
    shot: ".lmsa-usage-badge-probe",
    html: view(
      `<div class="lmsa-usage-badge-probe lmsa-chat-window-messages">
        ${assistantMessageWithBadge(
          "I tightened the scene while preserving the point of view.",
          `<div class="lmsa-chat-window-usage-badge" title="12,756 in · 1,842 out&#10;9,800 cache read · 1,200 cache write&#10;~$0.024, estimated&#10;model: claude-sonnet-4-5">
            <span class="lmsa-chat-window-usage-headline is-cost">~$0.024</span>
            <span class="lmsa-chat-window-usage-cache is-hit">9.8k cache read · 1.2k cache write</span>
          </div>`,
        )}
        ${assistantMessageWithBadge(
          "This older response has model metadata but no usage record.",
          `<div class="lmsa-chat-window-usage-badge">
            <span class="lmsa-chat-window-usage-model">gpt-5.4-mini</span>
          </div>`,
        )}
      </div>`,
      620,
    ),
  },

  // User-message edit mode. The original rendered host is hidden, the transparent textarea occupies
  // its place, and only the injected Cancel and Save controls remain visible in the canonical toolbar.
  inlineMessageEditor: {
    source: "src/chat/messages/InlineMessageEditor.ts",
    w: 620,
    shot: ".lmsa-chat-window-message--user",
    html: view(
      `<div class="lmsa-chat-window-message lmsa-chat-window-message--user is-editing">
        <div class="lmsa-chat-window-message-avatar">${I.userRound}</div>
        <div class="lmsa-chat-window-message-column">
          <div class="lmsa-chat-window-message-chrome">
            <div class="lmsa-chat-window-message-role">You</div>
          </div>
          <div class="lmsa-chat-window-message-body lmsa-ui-card">
            <div class="lmsa-chat-window-message-content lmsa-chat-window-message-content--markdown lmsa-hidden">
              <p>Make the harbor confrontation quieter, but keep the threat clear.</p>
            </div>
            <textarea class="lmsa-chat-window-inline-editor-textarea" rows="1">Make the harbor confrontation quieter, but keep the threat clear.</textarea>
          </div>
        </div>
        <div class="lmsa-chat-window-bubble-toolbar">
          <div class="lmsa-chat-window-message-actions">
            <button class="lmsa-chat-window-action-btn" data-action="copy" aria-label="Copy message" type="button">${I.copy}</button>
            <button class="lmsa-chat-window-action-btn" data-action="edit" aria-label="Edit message" type="button">${I.pencil}</button>
            <button class="lmsa-chat-window-action-btn is-edit-control" aria-label="Cancel (esc)" type="button">${I.x}</button>
            <button class="lmsa-chat-window-action-btn is-edit-control lmsa-chat-window-inline-editor-save" aria-label="Save changes (Ctrl+Enter)" type="button">${I.save}</button>
          </div>
        </div>
      </div>`,
      620,
    ),
  },
};
