import { COMPOSER_SURFACES } from "./composer.mjs";
import { ASK_SURFACES } from "./ask.mjs";
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
  "askSingleIncomplete",
  "askOtherReady",
  "askMixedReady",
  "askMixedNarrow",
  "askMaximumContract",
  "askMaximumContractNarrow",
  "askMixedMinimized",
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
  "bubbleToolbar",
  "ragSources",
  "knowledgeGraphContext",
  "usageBadge",
  "inlineMessageEditor",
  "reasoningMenu",
  "postureMenu",
  "contextPopover",
  "toolPopover",
  "overflowMenu",
  "profilePopover",
  "historyDrawer",
  "historyDrawerClosed",
  "settingsGeneral",
  "settingsProviders",
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
  "inlineDiff",
  "settingsRail",
  "memoryModal",
  "commandModal",
  "apiKeysDisclaimerModal",
  "imagePreviewModal",
  "chatHeader",
  "floatingButtons",
];

export const SURFACES = Object.fromEntries(
  SURFACE_ORDER.map((id) => [id, merged[id]]),
);

export const SURFACE_FAMILIES = Object.fromEntries(
  SURFACE_ORDER.map((id) => [id, familyById[id]]),
);
