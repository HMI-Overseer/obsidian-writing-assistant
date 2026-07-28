import { view } from "../scaffold.mjs";
import {
  assistantBubble,
  assistantTurn,
  editingProseItem,
  toolTurnBody,
  turnItem,
} from "../fixtures/chat.mjs";
import { I } from "../fixtures/icons.mjs";

export const ASSISTANT_TURN_SURFACES = {

  // Phase 4: exact prose and tool interleaving with same-segment tools, separate
  // silent segments, full markdown, a pending write review, and iconless final prose.
  assistantTurnInterleaved: {
    source: "src/chat/messages/AssistantTurnView.ts",
    w: 680,
    shot: ".lmsa-chat-window-message--assistant",
    html: view(
      assistantBubble(
        assistantTurn(
          turnItem(
            "prose-1",
            "prose",
            "thinking",
            "<p>I will inspect the opening before changing it.</p>",
          ) +
            turnItem(
              "tool-1",
              "tool_call",
              "tool",
              toolTurnBody(
                "Read file",
                "Drafts/Opening.md",
                "Completed",
                `<div class="lmsa-agentic-timeline-arg-entry"><span class="lmsa-agentic-timeline-arg-key">Result</span><pre class="lmsa-agentic-timeline-arg-value">The room was quiet.</pre></div>`,
              ),
              { state: "completed" },
            ) +
            turnItem(
              "prose-2",
              "prose",
              "thinking",
              `<p>The image is clear, but the verb can carry more tension.</p>
               <ul><li>Keep the room quiet.</li><li>Sharpen the character movement.</li></ul>`,
            ) +
            turnItem(
              "tool-2",
              "tool_call",
              "tool",
              toolTurnBody("Propose edit", "Drafts/Opening.md", "Running"),
              {
                state: "running",
                mutating: true,
                segment: "segment-2",
                action: `<div class="lmsa-edit-step-controls">
                  <span class="lmsa-edit-step-pending">pending review</span>
                  <button class="lmsa-edit-step-btn lmsa-edit-step-btn--approve" aria-label="Accept">${I.check}</button>
                  <button class="lmsa-edit-step-btn lmsa-edit-step-btn--decline" aria-label="Reject">${I.x}</button>
                </div>`,
              },
            ) +
            turnItem(
              "tool-3",
              "tool_call",
              "tool",
              toolTurnBody("Update frontmatter", "Drafts/Opening.md", "Completed"),
              {
                state: "completed",
                mutating: true,
                segment: "segment-2",
              },
            ) +
            turnItem(
              "tool-4",
              "tool_call",
              "tool",
              toolTurnBody("Read file", "Style guide.md", "Completed"),
              { state: "completed", segment: "segment-3" },
            ) +
            turnItem(
              "prose-3",
              "prose",
              "iconless",
              `<p>The opening is tighter now. The revised line keeps the silence while giving the movement more urgency.</p>`,
              { after: false, fade: true, segment: "segment-4" },
            ),
        ),
      ),
      680,
    ),
  },

  // Phase 4 lifecycle gallery: live empty placeholder, tool-only completion,
  // interruption after prose, failed empty turn, and honest completed empty turn.
  assistantTurnStates: {
    source: "src/chat/messages/AssistantTurnView.ts",
    w: 620,
    shot: ".lmsa-chat-window-messages",
    html: view(
      `<div class="lmsa-messages-pane"><div class="lmsa-chat-window-messages">
        ${assistantBubble(
          assistantTurn(
            "",
            "streaming",
            `<div class="lmsa-assistant-turn-empty is-streaming" aria-hidden="true">
              <span class="lmsa-assistant-turn-empty-marker">${I.more}</span>
              <span class="lmsa-assistant-turn-empty-label">Assistant is responding.</span>
            </div>`,
          ),
        )}
        ${assistantBubble(
          assistantTurn(
            turnItem(
              "tool-only",
              "tool_call",
              "tool",
              toolTurnBody("Searched vault", "character arc", "Completed"),
              { after: false, state: "completed" },
            ),
          ),
        )}
        ${assistantBubble(
          assistantTurn(
            turnItem(
              "partial-prose",
              "prose",
              "iconless",
              "<p>I found the relevant scene, but generation stopped before the summary completed.</p>",
              { after: false },
            ),
            "interrupted",
            `<div class="lmsa-assistant-turn-notice" role="status">Generation stopped.</div>`,
          ),
        )}
        ${assistantBubble(
          assistantTurn(
            "",
            "failed",
            `<div class="lmsa-assistant-turn-empty is-failed" role="status">
              <span class="lmsa-assistant-turn-empty-marker">${I.x}</span>
              <span class="lmsa-assistant-turn-empty-label">Error: Connection closed.</span>
            </div>`,
          ),
        )}
        ${assistantBubble(
          assistantTurn(
            "",
            "completed",
            `<div class="lmsa-assistant-turn-empty is-completed">
              <span class="lmsa-assistant-turn-empty-marker">${I.more}</span>
              <span class="lmsa-assistant-turn-empty-label">No response.</span>
            </div>`,
          ),
        )}
      </div></div>`,
      620,
    ),
  },

  // Phase 4 out-of-band action placement and ordered memory and ask details.
  assistantTurnActionPlacement: {
    source: "src/chat/messages/AssistantTurnView.ts",
    w: 650,
    shot: ".lmsa-chat-window-message--assistant",
    html: view(
      assistantBubble(
        assistantTurn(
          turnItem(
            "memory-1",
            "tool_call",
            "tool",
            toolTurnBody("Add memory", "Narration: restrained", "Running"),
            {
              state: "running",
              mutating: true,
              action: `<div class="lmsa-memory-step-controls lmsa-vault-step-controls">
                <span class="lmsa-vault-step-pending">pending approval</span>
                <button class="lmsa-vault-step-btn lmsa-vault-step-btn--approve" aria-label="Approve">${I.check}</button>
                <button class="lmsa-vault-step-btn lmsa-vault-step-btn--decline" aria-label="Decline">${I.x}</button>
              </div>
              <div class="lmsa-vault-timeline-preview lmsa-memory-review-preview"><pre class="lmsa-agentic-timeline-arg-value">Prefer restrained narration with concrete images.</pre></div>`,
            },
          ) +
            turnItem(
              "ask-1",
              "tool_call",
              "tool",
              toolTurnBody(
                "Asked a question",
                "Output format",
                "Completed",
                `<div class="lmsa-agentic-timeline-arg-entry">
                  <span class="lmsa-agentic-timeline-arg-key">Output</span>
                  <pre class="lmsa-agentic-timeline-arg-value">Which format should I use?\nDetailed</pre>
                </div>`,
              ),
              { after: false, state: "completed", segment: "segment-2" },
            ),
          "completed",
          `<section class="lmsa-assistant-turn-provisional lmsa-assistant-turn-action-section" aria-label="Pending review that has not received an ordered provider declaration">
            <div class="lmsa-assistant-turn-action-section-heading">Review awaiting declaration</div>
            <div class="lmsa-assistant-turn-action-summary">
              <div class="lmsa-assistant-turn-action-heading"><span class="lmsa-assistant-turn-action-family">Vault operation</span><span class="lmsa-assistant-turn-action-state">pending review</span></div>
              <div class="lmsa-assistant-turn-action-placement">Waiting for the provider declaration.</div>
            </div>
          </section>
          <section class="lmsa-assistant-turn-audit lmsa-assistant-turn-action-section" aria-label="Action history without a correlated provider declaration">
            <div class="lmsa-assistant-turn-action-section-heading">Unplaced action audit</div>
            <div class="lmsa-assistant-turn-action-summary">
              <div class="lmsa-assistant-turn-action-heading"><span class="lmsa-assistant-turn-action-family">Vault operation</span><span class="lmsa-assistant-turn-action-state">declined</span></div>
              <div class="lmsa-assistant-turn-action-placement is-warning">The action has effect history, but no provider declaration could be placed.</div>
            </div>
          </section>`,
        ),
      ),
      650,
    ),
  },

  // Turn-wide edit session: every prose item of the turn is open at once, the tool item is left
  // alone, and the canonical action bar swaps its five icons for one Cancel and one Save. Gate: no
  // per-item edit affordance anywhere, and the bar does not reflow when the icons swap.
  assistantTurnEditSession: {
    source: "src/chat/messages/inlineEditSession.ts",
    w: 650,
    shot: ".lmsa-chat-window-message--assistant",
    html: view(
      `<div class="lmsa-chat-window-message lmsa-chat-window-message--assistant is-editing">
        <div class="lmsa-chat-window-message-avatar">${I.bot}</div>
        <div class="lmsa-chat-window-message-column">
          <div class="lmsa-chat-window-message-chrome"><div class="lmsa-chat-window-message-role">Assistant</div></div>
        </div>
        ${assistantTurn(
          editingProseItem(
            "prose-1",
            "thinking",
            "I will inspect the opening before changing it.",
          ) +
            turnItem(
              "tool-1",
              "tool_call",
              "tool",
              toolTurnBody("Read file", "Drafts/Opening.md", "Completed"),
              { state: "completed" },
            ) +
            editingProseItem(
              "prose-2",
              "iconless",
              "The opening is tighter now. The revised line keeps the silence while giving the movement more urgency.",
              { after: false },
            ),
        )}
        <div class="lmsa-chat-window-bubble-toolbar">
          <div class="lmsa-chat-window-version-nav">
            <button class="lmsa-chat-window-version-prev" aria-label="Previous version" type="button">${I.chevronLeft}</button>
            <span class="lmsa-chat-window-version-indicator">1/1</span>
            <button class="lmsa-chat-window-version-next" aria-label="Next version" type="button" disabled>${I.chevronRight}</button>
          </div>
          <div class="lmsa-chat-window-message-actions">
            <button class="lmsa-chat-window-action-btn" data-action="regenerate" aria-label="Regenerate response" type="button">${I.refreshCw}</button>
            <button class="lmsa-chat-window-action-btn" data-action="branch" aria-label="Branch after this" type="button">${I.gitBranch}</button>
            <button class="lmsa-chat-window-action-btn" data-action="copy" aria-label="Copy message" type="button">${I.copy}</button>
            <button class="lmsa-chat-window-action-btn" data-action="edit" aria-label="Edit message" type="button">${I.pencil}</button>
            <button class="lmsa-chat-window-action-btn" data-action="delete" aria-label="Delete message" type="button">${I.trash}</button>
            <button class="lmsa-chat-window-action-btn is-edit-control" aria-label="Cancel (esc)" type="button">${I.x}</button>
            <button class="lmsa-chat-window-action-btn is-edit-control lmsa-chat-window-inline-editor-save" aria-label="Save changes (Ctrl+Enter)" type="button">${I.save}</button>
          </div>
        </div>
      </div>`,
      650,
    ),
  },

  // Phase 4 narrow-pane pressure test with long markdown, code, and consecutive tools.
  assistantTurnNarrow: {
    source: "src/chat/messages/AssistantTurnView.ts",
    w: 330,
    shot: ".lmsa-chat-window-message--assistant",
    html: view(
      assistantBubble(
        assistantTurn(
          turnItem(
            "narrow-prose-1",
            "prose",
            "thinking",
            `<p>This deliberately long paragraph verifies that prose wraps inside a narrow sidebar without moving the text edge or forcing the rail outside the pane.</p>
             <div class="lmsa-md-codeblock"><div class="lmsa-md-codeblock-header"><span class="lmsa-md-codeblock-language">typescript</span><button class="lmsa-md-codeblock-copy">Copy</button></div><pre class="lmsa-md-codeblock-pre"><code>const sentence = "A long line remains horizontally scrollable inside its own code block.";</code></pre></div>`,
          ) +
            turnItem(
              "narrow-tool-1",
              "tool_call",
              "tool",
              toolTurnBody("Read file", "Drafts/A very long note name.md", "Completed"),
              { state: "completed" },
            ) +
            turnItem(
              "narrow-tool-2",
              "tool_call",
              "tool",
              toolTurnBody("Searched vault", "motif continuity", "Completed"),
              { after: false, state: "completed" },
            ),
        ),
      ),
      330,
    ),
  },

  // Terminal capture failure and orphan recovery (RFC-0011). Two shapes, because the
  // render model branches on item count: a turn that committed facts before capture
  // failed carries the `is-error` notice, while a recovered orphan has no items at
  // all and carries the empty state instead. Both strings are the ones the tree
  // actually authors, so this checks the real wrap length rather than a short stand-in.
  assistantTurnCaptureFailure: {
    source: "src/chat/messages/AssistantTurnView.ts",
    w: 620,
    shot: ".lmsa-chat-window-messages",
    html: view(
      `<div class="lmsa-messages-pane"><div class="lmsa-chat-window-messages">
        ${assistantBubble(
          assistantTurn(
            turnItem(
              "capture-fail-prose",
              "prose",
              "thinking",
              "<p>Let me search the vault for the character's earlier appearances.</p>",
            ) +
              turnItem(
                "capture-fail-tool",
                "tool_call",
                "tool",
                toolTurnBody("Searched vault", "character arc", "Failed"),
                { after: false, state: "failed" },
              ),
            "failed",
            `<div class="lmsa-assistant-turn-notice is-error" role="status">Error: A redelivered capture batch carried different protocol bytes.</div>`,
          ),
        )}
        ${assistantBubble(
          assistantTurn(
            "",
            "failed",
            `<div class="lmsa-assistant-turn-empty is-failed" role="status">
              <span class="lmsa-assistant-turn-empty-marker">${I.x}</span>
              <span class="lmsa-assistant-turn-empty-label">Error: This turn ended without finishing. One action had already been authorized, and its outcome could not be confirmed.</span>
            </div>`,
          ),
        )}
      </div></div>`,
      620,
    ),
  },

  // The same two shapes in a narrow sidebar, where the bounded text is longest
  // relative to the pane and most likely to break the rail alignment.
  assistantTurnCaptureFailureNarrow: {
    source: "src/chat/messages/AssistantTurnView.ts",
    w: 330,
    shot: ".lmsa-chat-window-messages",
    html: view(
      `<div class="lmsa-messages-pane"><div class="lmsa-chat-window-messages">
        ${assistantBubble(
          assistantTurn(
            turnItem(
              "narrow-capture-fail-tool",
              "tool_call",
              "tool",
              toolTurnBody("Searched vault", "character arc", "Failed"),
              { after: false, state: "failed" },
            ),
            "failed",
            `<div class="lmsa-assistant-turn-notice is-error" role="status">Error: A redelivered capture batch carried different protocol bytes.</div>`,
          ),
        )}
        ${assistantBubble(
          assistantTurn(
            "",
            "failed",
            `<div class="lmsa-assistant-turn-empty is-failed" role="status">
              <span class="lmsa-assistant-turn-empty-marker">${I.x}</span>
              <span class="lmsa-assistant-turn-empty-label">Error: This turn ended without finishing. 3 actions had already been authorized, and its outcome could not be confirmed.</span>
            </div>`,
          ),
        )}
      </div></div>`,
      330,
    ),
  },
};
