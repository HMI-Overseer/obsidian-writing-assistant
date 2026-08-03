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
              toolCallId: "edit-tool",
              actionRef: "edit:edit-tool",
              toolIcon: I.pencil,
              action: `<div class="lmsa-edit-step-controls">
                <span class="lmsa-edit-step-pending">pending review</span>
              </div>`,
              presentation: `<div class="lmsa-edit-timeline-hunk">${splitHunk("pending", {
                location: "Lines 6-17",
                fileName: "Alex.md",
                contextLine: "5",
                contextText: "affiliations: [Guild, Watch]",
                changeLine: "6",
                removedText:
                  'role: <span class="lmsa-chat-window-diff-highlight">Narrator / Lead</span>',
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

  // S23: reachable mixed vault-review state. One operation has already applied and two still await
  // approval. The decision itself lives in the composer drawer (RFC-0012), so the awaiting steps
  // carry a status label and the footer carries only Undo.
  // The write preview's left diff pane is empty because this creates a new note.
  vaultReviewTimeline: {
    source: "src/chat/messages/vaultReviewTimeline.ts",
    w: 620,
    shot: ".lmsa-chat-window-message--assistant",
    html: view(
      assistantBubble(
        assistantTurn(
          turnItem(
            "vault-applied",
            "tool_call",
            "tool",
            toolTurnBody("Created folder", "Notes", "Completed"),
            {
              state: "completed",
              reviewState: "vault-applied",
              mutating: true,
              toolCallId: "vault-applied",
              actionRef: "vault:vault-applied",
              toolIcon: I.folderPlus,
              action: `<div class="lmsa-vault-step-controls">
                <span class="lmsa-vault-step-state">Applied</span>
              </div>`,
            },
          ) +
            turnItem(
              "vault-write",
              "tool_call",
              "tool",
              toolTurnBody("Write file", "Notes/New Scene.md", "Running"),
              {
                state: "running",
                reviewState: "vault-awaiting",
                mutating: true,
                toolCallId: "vault-write",
                actionRef: "vault:vault-write",
                toolIcon: I.filePlus,
                action: `<div class="lmsa-vault-step-controls">
                  <span class="lmsa-vault-step-pending">pending approval</span>
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
            ) +
            turnItem(
              "vault-move",
              "tool_call",
              "tool",
              toolTurnBody(
                "Move file",
                "Drafts/Old Scene.md → Drafts/Revised Scene.md",
                "Running",
              ),
              {
                after: false,
                state: "running",
                reviewState: "vault-awaiting",
                mutating: true,
                toolCallId: "vault-move",
                actionRef: "vault:vault-move",
                toolIcon: I.fileSymlink,
                action: `<div class="lmsa-vault-step-controls">
                  <span class="lmsa-vault-step-pending">pending approval</span>
                </div>`,
              },
            ),
          "streaming",
          `<div class="lmsa-vault-review-footer">
            <button class="lmsa-vault-review-footer-btn"><span class="lmsa-vault-review-footer-btn-icon">${I.undo2}</span>Undo</button>
          </div>`,
        ),
      ),
      620,
    ),
  },

  // S24: edit-review timeline, multi-hunk populated state (one applied + undo, one pending).
  // The bulk bar is gone with the live decision (RFC-0012); the session escape hatch is now
  // "Approve everything this session" in the composer drawer.
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
              toolCallId: "edit-applied",
              actionRef: "edit:edit-applied",
              toolIcon: I.pencil,
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
              toolTurnBody("Proposed edit", "Chapter 2.md", "Running"),
              {
                after: false,
                state: "running",
                reviewState: "edit-pending",
                mutating: true,
                toolCallId: "edit-pending",
                actionRef: "edit:edit-pending",
                toolIcon: I.pencil,
                action: `<div class="lmsa-edit-step-controls">
                  <span class="lmsa-edit-step-pending">pending review</span>
                </div>`,
                presentation: `<div class="lmsa-edit-timeline-hunk">${splitHunk("pending", { fileName: "Chapter 2.md" })}</div>`,
              },
            ),
          "streaming",
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
              "Chapter 3.md",
              "Completed",
            ),
            {
              after: false,
              state: "completed",
              reviewState: "edit-skipped",
              mutating: true,
              toolCallId: "edit-declined",
              actionRef: "edit:edit-declined",
              toolIcon: I.pencil,
              action: `<div class="lmsa-edit-step-controls">
                <span class="lmsa-edit-step-state">Skipped</span>
              </div>`,
              presentation:
                `<div class="lmsa-edit-timeline-hunk">` +
                splitHunk("rejected", {
                  location: "Line 9",
                  fileName: "Chapter 3.md",
                  contextLine: "8",
                  contextText:
                    "She lit the lamp anyway, hands steady from years of practice.",
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

  // The same turn after it ends: the live review is gone and the action ledger renders both
  // halves, its remaining controls on the row and the diff it made under it. The evidence
  // wrapper is what proves the cards still break to their own full-width line once the inline
  // control host, not a live review, is what they sit beside.
  durableReviewEvidence: {
    source: "src/chat/messages/ActionLedgerEvidenceView.ts",
    w: 620,
    shot: ".lmsa-chat-window-message--assistant",
    html: view(
      assistantBubble(
        assistantTurn(
          turnItem(
            "ledger-edit",
            "tool_call",
            "tool",
            toolTurnBody("Edited note", "Chapter 1.md", "Completed"),
            {
              state: "completed",
              mutating: true,
              toolCallId: "ledger-edit",
              actionRef: "action-ledger-edit",
              toolIcon: I.pencil,
              action: `<div class="lmsa-assistant-turn-action-summary">
                <div class="lmsa-assistant-turn-action-controls">
                  <button class="lmsa-assistant-turn-action-control is-undo" type="button" aria-label="Undo Chapter 1.md">${I.undo2}</button>
                </div>
              </div>`,
              presentation: `<div class="lmsa-action-evidence">
                <div class="lmsa-edit-timeline-hunk">${splitHunk("accepted")}</div>
              </div>`,
            },
          ) +
            turnItem(
              "ledger-write",
              "tool_call",
              "tool",
              toolTurnBody("Wrote file", "Scenes/New Scene.md", "Completed"),
              {
                after: false,
                state: "completed",
                mutating: true,
                toolCallId: "ledger-write",
                actionRef: "action-ledger-write",
                toolIcon: I.filePlus,
                action: `<div class="lmsa-assistant-turn-action-summary"></div>`,
                presentation: `<div class="lmsa-action-evidence">
                  <div class="lmsa-vault-timeline-preview">
                    <div class="lmsa-chat-window-diff-hunk" data-status="accepted">
                      <div class="lmsa-chat-window-diff-hunk-body lmsa-chat-window-diff-hunk-body--split">
                        <div class="lmsa-chat-window-diff-row">
                          <div class="lmsa-chat-window-diff-side lmsa-chat-window-diff-side--left lmsa-chat-window-diff-side--empty"></div>
                          <div class="lmsa-chat-window-diff-side lmsa-chat-window-diff-side--right lmsa-chat-window-diff-line--added">
                            <span class="lmsa-chat-window-diff-gutter"></span>
                            <span class="lmsa-chat-window-diff-text"># New Scene</span>
                          </div>
                        </div>
                        <div class="lmsa-chat-window-diff-row">
                          <div class="lmsa-chat-window-diff-side lmsa-chat-window-diff-side--left lmsa-chat-window-diff-side--empty"></div>
                          <div class="lmsa-chat-window-diff-side lmsa-chat-window-diff-side--right lmsa-chat-window-diff-line--added">
                            <span class="lmsa-chat-window-diff-gutter"></span>
                            <span class="lmsa-chat-window-diff-text">The harbour was empty by the time she reached it.</span>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>`+
                `</div>`,
              },
            ),
          "completed",
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
