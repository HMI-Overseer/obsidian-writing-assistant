import { COMPOSER_SURFACES } from "./composer.mjs";
import { ASK_SURFACES } from "./ask.mjs";
import { APPROVAL_SURFACES } from "./approval.mjs";
import { TRANSCRIPT_SURFACES } from "./transcript.mjs";
import { ASSISTANT_TURN_SURFACES } from "./assistantTurn.mjs";
import { REVIEW_SURFACES } from "./review.mjs";
import { SETTINGS_SURFACES } from "./settings.mjs";
import { CHROME_SURFACES } from "./chrome.mjs";
import { CHAT_STATE_SURFACES } from "./chatStates.mjs";
import { TURN_METADATA_SURFACES } from "./turnMetadata.mjs";
import { MODAL_SURFACES } from "./modals.mjs";
import { SETTINGS_COVERAGE_SURFACES } from "./settingsCoverage.mjs";

const MODULES = [
  ["composer", COMPOSER_SURFACES],
  ["chatStates", CHAT_STATE_SURFACES],
  ["ask", ASK_SURFACES],
  ["approval", APPROVAL_SURFACES],
  ["transcript", TRANSCRIPT_SURFACES],
  ["turnMetadata", TURN_METADATA_SURFACES],
  ["assistantTurn", ASSISTANT_TURN_SURFACES],
  ["review", REVIEW_SURFACES],
  ["settings", SETTINGS_SURFACES],
  ["settings", SETTINGS_COVERAGE_SURFACES],
  ["modals", MODAL_SURFACES],
  ["chrome", CHROME_SURFACES],
];
const merged = {};
const familyById = {};

for (const [family, surfaces] of MODULES) {
  for (const [id, surface] of Object.entries(surfaces)) {
    if (Object.prototype.hasOwnProperty.call(merged, id)) {
      throw new Error(`Duplicate visual surface id: ${id}`);
    }
    merged[id] = surface;
    familyById[id] = family;
  }
}

const SURFACE_ORDER = [
  "composer",
  "collapsedChat",
  "askSingleIncomplete",
  "askOtherReady",
  "askMixedReady",
  "askMixedNarrow",
  "askMaximumContract",
  "askMaximumContractNarrow",
  "askMixedMinimized",
  "approvalDefault",
  "approvalDefaultNarrow",
  "approvalOtherExpanded",
  "approvalOtherExpandedNarrow",
  "approvalLongSummary",
  "approvalLongSummaryNarrow",
  "approvalMinimized",
  "approvalWithTimeline",
  "approvalWithEditTimeline",
  "emptyState",
  "composerDragOver",
  "footerRing",
  "modelDropdown",
  "attachedImageChip",
  "modelDropdownEmptyCatalog",
  "modelDropdownNoSearchMatches",
  "chatHeaderPressure",
  "knowledgePopover",
  "transcript",
  "messageAttachments",
  "bubbleToolbar",
  "ragSources",
  "knowledgeGraphContext",
  "usageBadge",
  "inlineMessageEditor",
  "reasoningMenu",
  "postureMenu",
  "contextPopover",
  "contextPopoverSearch",
  "toolPopover",
  "overflowMenu",
  "profilePopover",
  "historyDrawer",
  "historyDrawerClosed",
  "settingsGeneral",
  "settingsProviders",
  "settingsProvidersCredentialStates",
  "settingsModelSelector",
  "settingsBenchmark",
  "settingsRag",
  "settingsAdvanced",
  "settingsMemories",
  "settingsMemoriesOff",
  "settingsKnowledgeGraph",
  "settingsCommands",
  "settingsCommandsEmpty",
  "settingsVaultOps",
  "settingsBenchmarkPopulated",
  "assistantTurnInterleaved",
  "assistantTurnStates",
  "assistantTurnActionPlacement",
  "assistantTurnEditSession",
  "assistantTurnNarrow",
  "assistantTurnCaptureFailure",
  "assistantTurnCaptureFailureNarrow",
  "diffTimeline",
  "vaultReviewTimeline",
  "editReviewTimeline",
  "editReviewDeclined",
  "durableReviewEvidence",
  "inlineDiff",
  "memoryModal",
  "commandModal",
  "apiKeysDisclaimerModal",
  "imagePreviewModal",
  "chatHeader",
  "floatingButtons",
];

// SURFACE_ORDER is the registry, not just a sort key: everything below reads from it, so a
// surface a module exports but this list omits is silently dropped. It renders nothing,
// audits nothing, and reports no error, which reads exactly like "the surface is fine".
// Both directions are checked, because a stale id here would drop a real surface too.
const missingFromOrder = Object.keys(merged).filter((id) => !SURFACE_ORDER.includes(id));
if (missingFromOrder.length > 0) {
  throw new Error(
    `Visual surface(s) exported but absent from SURFACE_ORDER, so they would never render: ${missingFromOrder.join(", ")}`,
  );
}
const missingFromModules = SURFACE_ORDER.filter(
  (id) => !Object.prototype.hasOwnProperty.call(merged, id),
);
if (missingFromModules.length > 0) {
  throw new Error(
    `SURFACE_ORDER names surface(s) no module exports: ${missingFromModules.join(", ")}`,
  );
}

export const SURFACES = Object.fromEntries(
  SURFACE_ORDER.map((id) => [id, merged[id]]),
);

export const SURFACE_FAMILIES = Object.fromEntries(
  SURFACE_ORDER.map((id) => [id, familyById[id]]),
);
