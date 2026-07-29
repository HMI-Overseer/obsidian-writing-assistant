import { view } from "../scaffold.mjs";
import {
  approvalEditTimelineStageHtml,
  approvalStageHtml,
  approvalVaultTimelineStageHtml,
  createRequest,
  declineRequest,
  editTimelineRequest,
  minimizedRequest,
  replaceRequest,
} from "../fixtures/approval.mjs";

const stage = (request, width) => ({
  source: "src/chat/composer/ApprovalForm.ts",
  w: width,
  shot: ".lmsa-approval-visual-stage",
  html: view(approvalStageHtml(request), width),
});

export const APPROVAL_SURFACES = {

  // RFC-0012 live approval: the default state, opened on Approve with all three choices
  // visible and the guidance field collapsed.
  approvalDefault: stage(createRequest, 600),
  approvalDefaultNarrow: stage(createRequest, 320),

  // Other selected: the guidance textarea expanded and populated, on the edit channel.
  approvalOtherExpanded: stage(declineRequest, 600),
  approvalOtherExpandedNarrow: stage(declineRequest, 320),

  // The longest derived summary and detail the vault channel produces, on a
  // replace_in_vault, with the session choice selected.
  approvalLongSummary: stage(replaceRequest, 600),
  approvalLongSummaryNarrow: stage(replaceRequest, 320),

  // Minimized: the drawer folds away to its toolbar so the transcript behind it is
  // readable, while the eyebrow still says a decision is waiting.
  approvalMinimized: stage(minimizedRequest, 600),

  // The two composites: a full assistant turn and the drawer deciding one of its steps, in
  // one frame. RFC-0012 took the buttons off the step, not the step off the timeline, and
  // these are the surfaces that show it. Compare them against `vaultReviewTimeline` and
  // `editReviewTimeline`, which render the same turns with no drawer.
  approvalWithTimeline: {
    source: "src/chat/messages/vaultReviewTimeline.ts",
    w: 640,
    shot: ".lmsa-approval-visual-stage",
    html: view(approvalVaultTimelineStageHtml(createRequest), 640),
  },

  // The edit channel's turn: full diff cards with their headers and view-mode toggles, the
  // applied step's Undo, and the pending step where Accept / Reject used to sit.
  approvalWithEditTimeline: {
    source: "src/chat/messages/editReviewTimeline.ts",
    w: 640,
    shot: ".lmsa-approval-visual-stage",
    html: view(approvalEditTimelineStageHtml(editTimelineRequest), 640),
  },
};
