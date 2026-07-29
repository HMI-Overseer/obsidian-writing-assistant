import {
  assistantBubble,
  assistantProse,
  assistantTurn,
  composerFooter,
  messagesPane,
  splitHunk,
  toolTurnBody,
  turnItem,
  userMessage,
} from "./chat.mjs";
import { I } from "./icons.mjs";

// Reconstructs src/chat/composer/ApprovalForm.ts. The option rows, the expanding Other,
// and its textarea are the shared lmsa-interaction-* markup the ask form also emits.

const CHOICES = [
  {
    choice: "approve",
    label: "Approve",
    description: "Apply this change now.",
  },
  {
    choice: "approve-session",
    label: "Approve everything this session",
    description:
      "Apply this and everything after it, even kinds set to Deny. Switches to Edit automatically.",
  },
  {
    choice: "decline",
    label: "Other",
    description: "Tell the model what to do instead.",
  },
];

const CHANNEL_LABELS = {
  "vault-op": "Vault change",
  edit: "Document edit",
  memory: "Memory",
};

const approvalOption = (id, copy, selected) =>
  `<div class="lmsa-interaction-option">
    <input class="lmsa-interaction-option-input" type="radio"
      id="${id}-${copy.choice}" name="${id}-choice" aria-describedby="${id}-${copy.choice}-description"${selected ? " checked" : ""}>
    <label class="lmsa-interaction-option-label" for="${id}-${copy.choice}">
      <span class="lmsa-interaction-option-name">${copy.label}</span>
      <span class="lmsa-interaction-option-description" id="${id}-${copy.choice}-description">${copy.description}</span>
    </label>
  </div>`;

const approvalOther = (id, copy, selected, guidance) =>
  `<div class="lmsa-interaction-option lmsa-interaction-other-option${selected ? " is-other-expanded" : ""}">
    <input class="lmsa-interaction-option-input" type="radio"
      id="${id}-${copy.choice}" name="${id}-choice" aria-describedby="${id}-${copy.choice}-description"${selected ? " checked" : ""}>
    <label class="lmsa-interaction-option-label" for="${id}-${copy.choice}">
      <span class="lmsa-interaction-option-name">${copy.label}</span>
      <span class="lmsa-interaction-option-description" id="${id}-${copy.choice}-description">${copy.description}</span>
    </label>
    <div class="lmsa-interaction-other-text"${selected ? "" : " hidden"}>
      <textarea class="lmsa-interaction-other-textarea" id="${id}-guidance"
        aria-label="Guidance for the model" rows="3" maxlength="500"
        placeholder="Optional: what should it do instead?">${guidance}</textarea>
    </div>
  </div>`;

export const approvalForm = ({
  id = "approval-visual",
  channel = "vault-op",
  summary,
  detail,
  choice = "approve",
  guidance = "",
  collapsed = false,
}) =>
  `<form class="lmsa-approval-form lmsa-interaction-form${collapsed ? " is-collapsed" : ""}" novalidate="true">
    <div class="lmsa-interaction-toolbar">
      <span class="lmsa-approval-form-eyebrow">${CHANNEL_LABELS[channel]}, waiting for you</span>
      <button class="lmsa-interaction-collapse" type="button"
        aria-label="${collapsed ? "Expand approval" : "Minimize approval"}"
        aria-controls="${id}-body" aria-expanded="${collapsed ? "false" : "true"}">
        ${collapsed ? I.chevronUp : I.chevronDown}
      </button>
    </div>
    <div class="lmsa-interaction-body" id="${id}-body" aria-hidden="${collapsed ? "true" : "false"}"${collapsed ? " inert" : ""}>
      <fieldset class="lmsa-approval-form-decision">
        <legend class="lmsa-approval-form-legend">
          <span class="lmsa-approval-form-summary">${summary}</span>
          ${detail ? `<span class="lmsa-approval-form-detail">${detail}</span>` : ""}
        </legend>
        <div class="lmsa-interaction-options">
          ${CHOICES.filter((copy) => copy.choice !== "decline")
            .map((copy) => approvalOption(id, copy, copy.choice === choice))
            .join("")}
          ${approvalOther(id, CHOICES[2], choice === "decline", guidance)}
        </div>
      </fieldset>
      <div class="lmsa-approval-form-actions">
        <button class="lmsa-ui-btn lmsa-ui-btn-primary lmsa-approval-form-submit" type="submit">Submit decision</button>
      </div>
    </div>
  </form>`;

export const approvalComposerHtml = (request) =>
  `<div class="lmsa-chat-composer">
    <button class="lmsa-chat-composer-generate-btn lmsa-hidden" aria-label="Generate response">
      <span class="lmsa-chat-composer-generate-icon">${I.sparkles}</span>
      <span>Generate response</span>
    </button>
    <div class="lmsa-chat-composer-interaction-body${request.collapsed ? " is-collapsed" : ""}" aria-hidden="false">
      ${approvalForm(request)}
    </div>
    <div class="lmsa-chat-composer-panel is-interacting is-approval-interaction">
      <div class="lmsa-context-picker-popover lmsa-hidden"></div>
      <div class="lmsa-chat-composer-normal-body" aria-hidden="true" inert>
        <div class="lmsa-chat-composer-chips">
          <button class="lmsa-chat-composer-add-context-btn" aria-label="Add context">${I.plus}</button>
        </div>
        <div class="lmsa-chat-composer-attachments"></div>
        <textarea class="lmsa-chat-composer-textarea" rows="1" disabled>An exact draft remains mounted here.</textarea>
      </div>
      ${composerFooter(true, true)}
    </div>
  </div>`;

// The conversation behind the drawer is the plugin's real transcript markup, not a
// simplified stand-in. A surface that renders invented chrome cannot be used to spot a
// regression in real chrome, and mixing the two across one family makes every surface in it
// ambiguous.
export const approvalStageHtml = (request) =>
  `<div class="lmsa-approval-visual-stage">
    ${messagesPane(
      userMessage("<p>Fold the renaming pass into the manuscript.</p>") +
        assistantProse(
          "<p>Reading the affected chapters before proposing the change. The step above holds the diff; the decision is down here.</p>",
        ),
    )}
    ${approvalComposerHtml(request)}
  </div>`;

/**
 * The decision and the step it belongs to, in one frame.
 *
 * RFC-0012 moved the approve / decline buttons off the timeline; it did not move the
 * timeline. This reconstructs what a live generation actually shows while the drawer is
 * waiting: earlier calls still listed, an applied op still marked Applied, and the op
 * under decision still carrying its own row, its present-tense label, its target path,
 * its write preview, and a "pending approval" status where the buttons used to be.
 *
 * The step and the drawer name the same file on purpose. Both derive from the same op in
 * the plugin (`summarizeOp` feeds the drawer, `opDetailLine` feeds the step detail), so a
 * mismatch here would be a fixture bug, not a design.
 */
const pendingWriteTurn = () =>
  assistantBubble(
    assistantTurn(
      turnItem(
        "vt-read",
        "tool_call",
        "tool",
        toolTurnBody("Read file", "Characters/_index.md", "Completed"),
        { state: "completed", toolCallId: "vt-read", toolIcon: I.fileText },
      ) +
        turnItem(
          "vt-dir",
          "tool_call",
          "tool",
          toolTurnBody("Created folder", "Characters", "Completed"),
          {
            state: "completed",
            reviewState: "vault-applied",
            mutating: true,
            toolCallId: "vt-dir",
            actionRef: "vault:vt-dir",
            toolIcon: I.folderPlus,
            action: `<div class="lmsa-vault-step-controls">
              <span class="lmsa-vault-step-state">Applied</span>
            </div>`,
          },
        ) +
        turnItem(
          "vt-write",
          "tool_call",
          "tool",
          toolTurnBody("Write file", "Characters/Alice.md", "Running"),
          {
            after: false,
            state: "running",
            reviewState: "vault-awaiting",
            mutating: true,
            toolCallId: "vt-write",
            actionRef: "vault:vt-write",
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
                      <span class="lmsa-chat-window-diff-text"># Alice</span>
                    </div>
                  </div>
                  <div class="lmsa-chat-window-diff-row">
                    <div class="lmsa-chat-window-diff-side lmsa-chat-window-diff-side--left lmsa-chat-window-diff-side--empty"></div>
                    <div class="lmsa-chat-window-diff-side lmsa-chat-window-diff-side--right lmsa-chat-window-diff-line--added">
                      <span class="lmsa-chat-window-diff-gutter"></span>
                      <span class="lmsa-chat-window-diff-text">Court cartographer, second of her line.</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>`,
          },
        ),
      "streaming",
    ),
  );

/**
 * The edit channel's turn, reconstructed to match the `editReviewTimeline` surface exactly:
 * same steps, same statuses, same diff cards, because that is the comparison worth being
 * able to make. The only difference RFC-0012 introduces is that the pending step's Accept /
 * Reject pair is now the "pending review" label, and the bulk bar under the turn is gone.
 */
const pendingEditTurn = () =>
  assistantBubble(
    assistantTurn(
      turnItem(
        "et-applied",
        "tool_call",
        "tool",
        toolTurnBody("Proposed edit", "Chapter 1.md", "Completed"),
        {
          state: "completed",
          reviewState: "edit-applied",
          mutating: true,
          toolCallId: "et-applied",
          actionRef: "edit:et-applied",
          toolIcon: I.pencil,
          action: `<div class="lmsa-edit-step-controls">
            <span class="lmsa-edit-step-state">Applied</span>
            <button class="lmsa-edit-step-btn lmsa-edit-step-btn--undo" aria-label="Undo">${I.undo2}</button>
          </div>`,
          presentation: `<div class="lmsa-edit-timeline-hunk">${splitHunk("applied")}</div>`,
        },
      ) +
        turnItem(
          "et-pending",
          "tool_call",
          "tool",
          toolTurnBody("Proposed edit", "Chapter 2.md", "Running"),
          {
            after: false,
            state: "running",
            reviewState: "edit-pending",
            mutating: true,
            toolCallId: "et-pending",
            actionRef: "edit:et-pending",
            toolIcon: I.pencil,
            action: `<div class="lmsa-edit-step-controls">
              <span class="lmsa-edit-step-pending">pending review</span>
            </div>`,
            presentation: `<div class="lmsa-edit-timeline-hunk">${splitHunk("pending", { fileName: "Chapter 2.md" })}</div>`,
          },
        ),
      "streaming",
    ),
  );

/**
 * `is-flow` drops the fixed stage height so the whole assistant turn and the whole drawer
 * are both in frame. The fixed-height stage the drawer-only surfaces use is truthful about
 * the drawer floating over a scrolled transcript, but it crops the turn, which makes it
 * useless for the one question these two surfaces exist to answer.
 */
const timelineStage = (prompt, turn, request) =>
  `<div class="lmsa-approval-visual-stage is-flow">
    ${messagesPane(userMessage(`<p>${prompt}</p>`) + turn)}
    ${approvalComposerHtml(request)}
  </div>`;

export const approvalVaultTimelineStageHtml = (request) =>
  timelineStage("Add a character note for Alice.", pendingWriteTurn(), request);

export const approvalEditTimelineStageHtml = (request) =>
  timelineStage("Tighten the walk-home beat in the first two chapters.", pendingEditTurn(), request);

export const createRequest = {
  id: "approval-create",
  channel: "vault-op",
  summary: "New file Characters/Alice.md (2.4 KB)",
  detail: "Characters/Alice.md",
  choice: "approve",
};

export const declineRequest = {
  id: "approval-decline",
  channel: "edit",
  summary: "Edit Manuscript/Chapter 12.md",
  detail: "Line 418",
  choice: "decline",
  guidance:
    "Keep Alice's opening line verbatim, it is quoted again in chapter 19. " +
    "Rewrite the paragraph after it instead, and leave the scene break alone.",
};

// The widest-blast-radius op, with the longest derived summary the channel can produce.
export const replaceRequest = {
  id: "approval-replace",
  channel: "vault-op",
  summary:
    'Replace "the Silver Age" → "the Golden Age" in 34 notes (211 matches)',
  detail: '"the Silver Age" → "the Golden Age"',
  choice: "approve-session",
};

// Minimized: the toolbar keeps the eyebrow and the restore control, so the transcript
// behind the drawer is readable while the decision is still pending.
export const minimizedRequest = {
  ...createRequest,
  id: "approval-minimized",
  collapsed: true,
};

// The decision that belongs to the pending step in `pendingEditTurn`. Summary and detail
// follow editApprovalRequest's derivation ("Edit <path>" / "Line <startLine>"), so the
// drawer and the step name the same change the same way the plugin makes them.
export const editTimelineRequest = {
  id: "approval-edit-timeline",
  channel: "edit",
  summary: "Edit Chapter 2.md",
  detail: "Line 3",
  choice: "approve",
};
