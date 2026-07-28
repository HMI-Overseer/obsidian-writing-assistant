import { COMPOSER_SURFACES } from "./composer.mjs";
import { ASK_SURFACES } from "./ask.mjs";
import { TRANSCRIPT_SURFACES } from "./transcript.mjs";
import { ASSISTANT_TURN_SURFACES } from "./assistantTurn.mjs";
import { REVIEW_SURFACES } from "./review.mjs";
import { SETTINGS_SURFACES } from "./settings.mjs";
import { CHROME_SURFACES } from "./chrome.mjs";

const MODULES = [COMPOSER_SURFACES, ASK_SURFACES, TRANSCRIPT_SURFACES, ASSISTANT_TURN_SURFACES, REVIEW_SURFACES, SETTINGS_SURFACES, CHROME_SURFACES];
const merged = {};

for (const surfaces of MODULES) {
  for (const [id, surface] of Object.entries(surfaces)) {
    if (Object.prototype.hasOwnProperty.call(merged, id)) {
      throw new Error(`Duplicate visual surface id: ${id}`);
    }
    merged[id] = surface;
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
  "knowledgePopover",
  "transcript",
  "bubbleToolbar",
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
  "chatHeader",
  "floatingButtons",
];

export const SURFACES = Object.fromEntries(
  SURFACE_ORDER.map((id) => [id, merged[id]]),
);
