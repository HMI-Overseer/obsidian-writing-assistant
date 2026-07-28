import { view } from "../scaffold.mjs";
import {
  assistantBubble,
  assistantTurn,
  splitHunk,
  toolTurnBody,
  turnItem,
} from "../fixtures/chat.mjs";
import { I } from "../fixtures/icons.mjs";

export const REVIEW_SURFACES = {

  // S22: historical edit-review reference, attached to the exact ordered assistant item.
  diffTimeline: {
    source: "src/chat/messages/DiffHunkView.ts",
    w: 700,
    shot: ".lmsa-chat-window-message--assistant",
    html: view(
      assistantBubble(
        assistantTurn(
          turnItem(
            "edit-tool",
            "tool_call",
            "tool",
            toolTurnBody(
              "Proposed edit",
              "Updating Alex's role to Co-Leader and age to 35.",
              "Running",
            ),
            {
              after: false,
              state: "running",
              reviewState: "edit-pending",
              mutating: true,
              action: `<div class="lmsa-edit-step-controls">
                <span class="lmsa-edit-step-pending">pending review</span>
                <button class="lmsa-edit-step-btn lmsa-edit-step-btn--approve" aria-label="Accept">${I.check}</button>
                <button class="lmsa-edit-step-btn lmsa-edit-step-btn--decline" aria-label="Reject">${I.x}</button>
              </div>`,
              presentation: `<div class="lmsa-edit-timeline-hunk">${splitHunk("pending", {
                location: "Lines 6-17",
                fileName: "Alex.md",
                contextLine: "5",
                contextText: "affiliations: [The Cast, Survival Group Alpha]",
                changeLine: "6",
                removedText:
                  'role: <span class="lmsa-chat-window-diff-highlight">Primary POV / Leader</span>',
                addedText:
                  'role: <span class="lmsa-chat-window-diff-highlight">Co-Leader</span>',
              })}</div>`,
            },
          ),
        ),
      ),
      700,
    ),
  },

  // S23: vault-review timeline (write op preview + step controls + turn footer). Plus a standalone
  // dismissable chip to exercise the lmsa-ui-chip-dismiss !important override (cascade check-item; no
  // component emits it inside the timeline, per source).
  // The footer deliberately shows the FULL option set (approve-all AND undo) so one shot covers the
  // footer's chrome; the live footer gates each button on eligibility, so undo does not co-occur with
  // a still-pending approve-all. Read this surface for the buttons' styling, not for a reachable state.
  // The left diff pane is empty on purpose: this is `write_file` creating a new note, so there is no
  // prior content to show.
  vaultReviewTimeline: {
    source: "src/chat/messages/vaultReviewTimeline.ts",
    w: 620,
    shot: ".lmsa-chat-window-message--assistant",
    html: view(
      assistantBubble(
        assistantTurn(
          turnItem(
            "vault-tool",
            "tool_call",
            "tool",
            toolTurnBody("Write file", "Notes/New Scene.md", "Running"),
            {
              after: false,
              state: "running",
              reviewState: "vault-awaiting",
              mutating: true,
              action: `<div class="lmsa-vault-step-controls">
                <span class="lmsa-vault-step-pending">pending approval</span>
                <button class="lmsa-vault-step-btn lmsa-vault-step-btn--approve" aria-label="Approve">${I.check}</button>
                <button class="lmsa-vault-step-btn lmsa-vault-step-btn--decline" aria-label="Decline">${I.x}</button>
              </div>`,
              presentation: `<div class="lmsa-vault-timeline-preview">
                <div class="lmsa-chat-window-diff-hunk" data-status="pending">
                  <div class="lmsa-chat-window-diff-hunk-body lmsa-chat-window-diff-hunk-body--split">
                    <div class="lmsa-chat-window-diff-row">
                      <div class="lmsa-chat-window-diff-side lmsa-chat-window-diff-side--left lmsa-chat-window-diff-side--empty"></div>
                      <div class="lmsa-chat-window-diff-side lmsa-chat-window-diff-side--right lmsa-chat-window-diff-line--added">
                        <span class="lmsa-chat-window-diff-gutter"></span>
                        <span class="lmsa-chat-window-diff-text"># New Scene</span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>`,
            },
          ),
          "streaming",
          `<div class="lmsa-vault-review-footer">
            <button class="lmsa-vault-review-footer-btn lmsa-vault-review-footer-btn--approve"><span class="lmsa-vault-review-footer-btn-icon">${I.check}</span>Approve all remaining</button>
            <button class="lmsa-vault-review-footer-btn"><span class="lmsa-vault-review-footer-btn-icon">${I.undo2}</span>Undo</button>
          </div>`,
        ),
      ),
      620,
    ),
  },

  // S24: edit-review timeline, multi-hunk populated state (one applied + undo, one pending) + bulk bar.
  editReviewTimeline: {
    source: "src/chat/messages/editReviewTimeline.ts",
    w: 620,
    shot: ".lmsa-chat-window-message--assistant",
    html: view(
      assistantBubble(
        assistantTurn(
          turnItem(
            "edit-applied",
            "tool_call",
            "tool",
            toolTurnBody("Proposed edit", "Chapter 1.md", "Completed"),
            {
              state: "completed",
              reviewState: "edit-applied",
              mutating: true,
              action: `<div class="lmsa-edit-step-controls">
                <span class="lmsa-edit-step-state">Applied</span>
                <button class="lmsa-edit-step-btn lmsa-edit-step-btn--undo" aria-label="Undo">${I.undo2}</button>
              </div>`,
              presentation: `<div class="lmsa-edit-timeline-hunk">${splitHunk("applied")}</div>`,
            },
          ) +
            turnItem(
              "edit-pending",
              "tool_call",
              "tool",
              toolTurnBody("Propose edit", "Chapter 2.md", "Running"),
              {
                after: false,
                state: "running",
                reviewState: "edit-pending",
                mutating: true,
                action: `<div class="lmsa-edit-step-controls">
                  <span class="lmsa-edit-step-pending">pending review</span>
                  <button class="lmsa-edit-step-btn lmsa-edit-step-btn--approve" aria-label="Accept">${I.check}</button>
                  <button class="lmsa-edit-step-btn lmsa-edit-step-btn--decline" aria-label="Reject">${I.x}</button>
                </div>`,
                presentation: `<div class="lmsa-edit-timeline-hunk">${splitHunk("pending", { fileName: "Chapter 2.md" })}</div>`,
              },
            ),
          "streaming",
          `<div class="lmsa-edit-review-bulk">
            <button class="lmsa-ui-compact-btn lmsa-edit-bulk-btn lmsa-edit-bulk-btn--accept">Accept all (2)</button>
            <button class="lmsa-ui-compact-btn lmsa-ui-compact-btn-secondary lmsa-edit-bulk-btn">Reject all</button>
            <button class="lmsa-ui-compact-btn lmsa-ui-compact-btn-secondary lmsa-edit-bulk-btn">Accept all this session</button>
          </div>`,
        ),
      ),
      620,
    ),
  },

  // Denied edit regression: one inline terminal state and one sibling diff.
  editReviewDeclined: {
    source: "src/chat/messages/editReviewTimeline.ts",
    w: 620,
    shot: ".lmsa-chat-window-message--assistant",
    html: view(
      assistantBubble(
        assistantTurn(
          turnItem(
            "edit-declined",
            "tool_call",
            "tool",
            toolTurnBody(
              "Proposed edit",
              "The Lighthouse Keeper.md",
              "Completed",
            ),
            {
              after: false,
              state: "completed",
              reviewState: "edit-skipped",
              mutating: true,
              action: `<div class="lmsa-edit-step-controls">
                <span class="lmsa-edit-step-state">Skipped</span>
              </div>`,
              presentation:
                `<div class="lmsa-edit-timeline-hunk">` +
                splitHunk("rejected", {
                  location: "Line 9",
                  fileName: "The Lighthouse Keeper.md",
                  contextLine: "8",
                  contextText:
                    "Mara lit the lamp anyway, hands steady from years of practice.",
                  changeLine: "9",
                  removedText:
                    "Near midnight, she saw it, a single light bobbing far out on the water.",
                  addedText:
                    "Near midnight, she saw it, a small boat lost in the swell.",
                }) +
                "</div>",
            },
          ),
        ),
      ),
      620,
    ),
  },

  // S25: inline diff decoration in the editor (CM6 mark + block widget). Add/remove coloring, no gutter
  // class of our own (Obsidian's native gutters show through unstyled, the correct expectation).
  inlineDiff: {
    source: "src/editing/inlineDiff/InlineDiffManager.ts",
    w: 560,
    shot: ".cm-editor",
    html: view(
      `<div class="cm-editor"><div class="cm-scroller"><div class="cm-content">
        <div class="cm-line">The morning was quiet.</div>
        <div class="cm-line"><span class="lmsa-inline-diff-removed">She walked home.</span></div>
        <div class="lmsa-inline-diff-block">
          <div class="lmsa-inline-diff-added">She hurried home.</div>
          <div class="lmsa-inline-diff-actions">
            <button class="lmsa-inline-diff-btn lmsa-inline-diff-btn--accept" type="button">Accept</button>
            <button class="lmsa-inline-diff-btn lmsa-inline-diff-btn--reject" type="button">Reject</button>
          </div>
        </div>
        <div class="cm-line">The rain began to fall.</div>
      </div></div></div>`,
      560,
    ),
  },
};
