import { view } from "../scaffold.mjs";
import { assistantBubble, assistantTurn, turnItem } from "../fixtures/chat.mjs";
import { I } from "../fixtures/icons.mjs";

export const TRANSCRIPT_SURFACES = {

  // Empty state (createChatLayout.ts + EmptyStateCarousel.ts): the writing-prompt carousel. The controller
  // slides the track via --lmsa-carousel-index and reveals the nav on hover; the harness renders a static
  // frame at index 0 with the nav forced visible (lmsa-harness-show) so its placement can be checked.
  emptyState: {
    source: "src/chat/view/EmptyStateCarousel.ts",
    w: 460,
    shot: ".lmsa-messages-pane",
    html: view(
      `<div class="lmsa-messages-pane" style="position:relative;width:412px;height:540px;flex:none">
        <div class="lmsa-empty-view">
          <div class="lmsa-empty-title">Start a conversation</div>
          <div class="lmsa-empty-copy">
            <div class="lmsa-empty-carousel">
              <div class="lmsa-empty-carousel-viewport">
                <div class="lmsa-empty-carousel-track">
                  <div class="lmsa-empty-carousel-slide">Ask a question, paste a passage, or run a quick command on your draft.</div>
                  <div class="lmsa-empty-carousel-slide">Select a line in your note and ask for a few ways to phrase it.</div>
                  <div class="lmsa-empty-carousel-slide">Paste a paragraph and I'll tighten it without losing your voice.</div>
                  <div class="lmsa-empty-carousel-slide">Describe where a scene is headed and we'll find the next line together.</div>
                </div>
              </div>
              <button class="lmsa-empty-carousel-nav lmsa-empty-carousel-nav--prev lmsa-harness-show" aria-label="Previous prompt">${I.chevronLeft}</button>
              <button class="lmsa-empty-carousel-nav lmsa-empty-carousel-nav--next lmsa-harness-show" aria-label="Next prompt">${I.chevronRight}</button>
            </div>
          </div>
        </div>
      </div>`,
      460,
    ),
  },

  // S1: transcript at rest, a user bubble + an assistant bubble carrying a fenced code block. Toolbars
  // are present but at opacity:0 (their at-rest state), so no is-hover / harness-show here.
  transcript: {
    source: "src/chat/messages/ChatTranscript.ts",
    w: 620,
    shot: ".lmsa-chat-window-messages",
    html: view(
      `<div class="lmsa-messages-pane"><div class="lmsa-chat-window-messages">
        <div class="lmsa-chat-window-message lmsa-chat-window-message--user">
          <div class="lmsa-chat-window-message-avatar">${I.userRound}</div>
          <div class="lmsa-chat-window-message-column">
            <div class="lmsa-chat-window-message-chrome"><div class="lmsa-chat-window-message-role">You</div></div>
            <div class="lmsa-chat-window-message-body lmsa-ui-card">
              <div class="lmsa-chat-window-message-content lmsa-chat-window-message-content--markdown">
                <p>Show me a Python hello world.</p>
              </div>
            </div>
          </div>
        </div>
        ${assistantBubble(
          assistantTurn(
            turnItem(
              "prose-1",
              "prose",
              "iconless",
              `<p>Here you go:</p>
               <div class="lmsa-md-codeblock">
                 <div class="lmsa-md-codeblock-header">
                   <span class="lmsa-md-codeblock-language">python</span>
                   <button type="button" class="lmsa-md-codeblock-copy">Copy</button>
                 </div>
                 <pre class="lmsa-md-codeblock-pre"><code class="language-python">print("hello world")</code></pre>
               </div>`,
              { after: false, fade: true },
            ),
          ),
        )}
      </div></div>`,
      620,
    ),
  },

  // S2: hover-revealed bubble toolbar (version nav + action buttons). Forced visible via harness-show.
  // Gate: the icon buttons carry no Obsidian button chrome (the .lmsa-ui-icon-btn !important override).
  bubbleToolbar: {
    source: "src/chat/messages/BubbleActionToolbar.ts",
    w: 360,
    shot: ".lmsa-chat-window-bubble-toolbar",
    html: view(
      `<div class="lmsa-chat-window-message lmsa-chat-window-message--assistant">
        <div class="lmsa-chat-window-bubble-toolbar lmsa-harness-show">
          <div class="lmsa-chat-window-version-nav">
            <button class="lmsa-chat-window-version-prev" aria-label="Previous version" type="button">${I.chevronLeft}</button>
            <span class="lmsa-chat-window-version-indicator">2/2</span>
            <button class="lmsa-chat-window-version-next" aria-label="Next version" type="button" disabled>${I.chevronRight}</button>
          </div>
          <div class="lmsa-chat-window-message-actions">
            <button class="lmsa-chat-window-action-btn" data-action="regenerate" aria-label="Regenerate response" type="button">${I.refreshCw}</button>
            <button class="lmsa-chat-window-action-btn" data-action="branch" aria-label="Branch after this" type="button">${I.gitBranch}</button>
            <button class="lmsa-chat-window-action-btn" data-action="copy" aria-label="Copy message" type="button">${I.copy}</button>
            <button class="lmsa-chat-window-action-btn" data-action="edit" aria-label="Edit message" type="button">${I.pencil}</button>
            <button class="lmsa-chat-window-action-btn" data-action="delete" aria-label="Delete message" type="button">${I.trash}</button>
          </div>
        </div>
      </div>`,
      360,
    ),
  },
};
