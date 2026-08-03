import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

// Which arrangement a settings tab actually renders in: a converted tab exports the sections
// builder its declarative page consumes, one still behind an ImperativeTabPage exports a renderer.
// Reading the tab module is what makes a stale fixture fail. Deriving the arrangement from the
// fixture's own markup only ever agrees with itself, so a fixture left wholly in the old form after
// its tab converts satisfies the old branch and passes silently, which is the one mistake a
// conversion stage is most likely to make.
const tabArrangement = (source) => {
  let code;
  try {
    code = readFileSync(resolve(REPO, source), "utf8");
  } catch {
    return null;
  }
  if (/export function \w+TabSections\(/.test(code)) return "converted";
  if (/export function render\w+Tab\(/.test(code)) return "imperative";
  return null; // not a tab module (ui.ts, the benchmark renderers): the markup decides.
};

const requireMarkup = (surface, id, fragments, failures) => {
  for (const fragment of fragments) {
    if (!surface.html.includes(fragment)) {
      failures.push(`${id}: missing ${fragment}`);
    }
  }
};

const requireOrder = (surface, id, fragments, failures) => {
  let previous = -1;
  for (const fragment of fragments) {
    const index = surface.html.indexOf(fragment);
    if (index < 0) {
      failures.push(`${id}: missing ${fragment}`);
      return;
    }
    if (index <= previous) {
      failures.push(`${id}: ${fragment} is out of production DOM order`);
      return;
    }
    previous = index;
  }
};

const rejectMarkup = (surface, id, fragments, failures) => {
  for (const fragment of fragments) {
    if (surface.html.includes(fragment)) {
      failures.push(`${id}: unreachable state includes ${fragment}`);
    }
  }
};

export function auditSurfaceContracts(surfaces) {
  const failures = [];

  for (const [id, surface] of Object.entries(surfaces)) {
    if (
      surface.source.startsWith("src/settings/") &&
      !surface.source.startsWith("src/settings/modals/")
    ) {
      // Every settings surface reconstructs Obsidian's settings page. A converted tab renders its
      // rows from `items`, so its cards are the token host and there is no panel; a tab still
      // behind an ImperativeTabPage puts both on the page root.
      const arrangement = tabArrangement(surface.source);
      const drawnConverted = surface.html.includes("setting-group lmsa-ui-card");
      if (arrangement && (arrangement === "converted") !== drawnConverted) {
        failures.push(
          `${id}: ${surface.source} renders the ${arrangement} form, ` +
            `but the fixture draws the ${drawnConverted ? "converted" : "imperative"} one`,
        );
      }
      const converted = arrangement ? arrangement === "converted" : drawnConverted;
      requireMarkup(
        surface,
        id,
        [
          "setting-page vertical-tab-content",
          "setting-page-titlebar",
          "setting-page-content",
          ...(converted
            ? ["lmsa-settings-section lmsa-settings-root lmsa-tab-"]
            : ["vertical-tab-content lmsa-settings-root lmsa-tab-", "lmsa-settings-panel"]),
        ],
        failures,
      );
      // The card classes alone do not prove the arrangement: a fixture that rebuilds its cards but
      // keeps the old page wrapper draws both, and passed until this rejected it. A converted page
      // has no panel and no token host on the page root, because groups cannot nest and there is
      // nothing above the card left to be either.
      if (converted) {
        rejectMarkup(
          surface,
          id,
          ["lmsa-settings-panel", "vertical-tab-content lmsa-settings-root"],
          failures,
        );
      }
    }

    const toolRows =
      surface.html.match(
        /<li class="[^"]*lmsa-assistant-turn-item--tool_call[^"]*"[^>]*>/g,
      ) ?? [];
    for (const row of toolRows) {
      if (!row.includes("data-tool-call-id=")) {
        failures.push(`${id}: tool timeline row is missing data-tool-call-id`);
      }
    }
  }

  for (const id of ["composer", "composerDragOver", "attachedImageChip"]) {
    const surface = surfaces[id];
    requireOrder(
      surface,
      id,
      [
        "lmsa-chat-composer-generate-btn",
        "lmsa-chat-composer-interaction-body",
        "lmsa-chat-composer-panel",
        "lmsa-context-picker-popover",
        "lmsa-chat-composer-normal-body",
        "lmsa-chat-composer-footer",
      ],
      failures,
    );
  }

  requireMarkup(
    surfaces.modelDropdown,
    "modelDropdown",
    [
      'title="Favorites"',
      'title="LM Studio"',
      'title="Anthropic"',
      'title="OpenAI"',
      'title="Claude Code"',
    ],
    failures,
  );
  requireMarkup(
    surfaces.profilePopover,
    "profilePopover",
    [
      ">Max tokens<",
      ">Top P<",
      ">Top K<",
      "Disable built-in system prompts",
      "lmsa-disable-prompts-warning",
    ],
    failures,
  );
  requireOrder(
    surfaces.profilePopover,
    "profilePopover",
    [">Temperature<", ">Max tokens<", ">Top P<", ">Top K<"],
    failures,
  );
  requireMarkup(
    surfaces.vaultReviewTimeline,
    "vaultReviewTimeline",
    // The live approve / decline decision moved to the composer drawer (RFC-0012), so the
    // awaiting steps carry a status label and the footer carries only Undo. Undo is a
    // post-decision action on a durable record and deliberately stayed.
    ["is-vault-applied", "vault-write", "vault-move", "pending approval", ">Undo<"],
    failures,
  );
  rejectMarkup(
    surfaces.vaultReviewTimeline,
    "vaultReviewTimeline",
    ["Approve all", "lmsa-vault-step-btn"],
    failures,
  );
  rejectMarkup(
    surfaces.editReviewTimeline,
    "editReviewTimeline",
    ["lmsa-edit-review-bulk", "lmsa-edit-step-btn--approve"],
    failures,
  );
  // After the turn the ledger owns both halves: its own controls on the row, and the same
  // diff cards under it. The live review's step controls are gone by then, so a fixture
  // still drawing them would be showing a state the settled turn cannot reach.
  requireMarkup(
    surfaces.durableReviewEvidence,
    "durableReviewEvidence",
    [
      "lmsa-assistant-turn-action-summary",
      "lmsa-action-evidence",
      "lmsa-edit-timeline-hunk",
      "lmsa-vault-timeline-preview",
    ],
    failures,
  );
  rejectMarkup(
    surfaces.durableReviewEvidence,
    "durableReviewEvidence",
    ["lmsa-edit-step-controls", "lmsa-vault-step-controls"],
    failures,
  );
  requireMarkup(
    surfaces.settingsRag,
    "settingsRag",
    [
      ">Vault retrieval<",
      ">Index<",
      ">Automatic reindexing<",
      ">Retrieval<",
      ">Chunking<",
    ],
    failures,
  );
  rejectMarkup(
    surfaces.settingsRag,
    "settingsRag",
    ['class="lmsa-index-progress is-visible"'],
    failures,
  );
  requireMarkup(
    surfaces.settingsKnowledgeGraph,
    "settingsKnowledgeGraph",
    [
      ">Before you begin<",
      ">Knowledge graph<",
      ">Graph<",
      ">Filtering<",
      ">Cost<",
      ">Benefits<",
    ],
    failures,
  );
  rejectMarkup(
    surfaces.settingsKnowledgeGraph,
    "settingsKnowledgeGraph",
    ["lmsa-kg-folder-stop-btn"],
    failures,
  );
  requireMarkup(
    surfaces.settingsAdvanced,
    "settingsAdvanced",
    [">Agentic mode<", ">Document Editing<"],
    failures,
  );
  // The one page whose content is a single list, and the one that went without a section card
  // longest. The heading is the contract: the list is allowed to change shape, the card is not.
  requireMarkup(
    surfaces.settingsProviders,
    "settingsProviders",
    [">Model providers<", "lmsa-settings-section-icon", "lmsa-provider-cards"],
    failures,
  );
  // The two list tabs draw their collections as block rows, and the button that used to sit in the
  // card footer element is now a row. A fixture that loses one of those loses the whole affordance.
  requireMarkup(
    surfaces.settingsCommands,
    "settingsCommands",
    [">Command library<", ">Prompt variables<", ">Custom commands<", ">Add command<"],
    failures,
  );
  requireMarkup(
    surfaces.settingsCommandsEmpty,
    "settingsCommandsEmpty",
    [">No custom commands configured yet.<", ">Add command<"],
    failures,
  );
  rejectMarkup(surfaces.settingsCommandsEmpty, "settingsCommandsEmpty", ["is-user-created"], failures);
  requireMarkup(
    surfaces.settingsMemories,
    "settingsMemories",
    [">Memory<", ">Stored memories<", ">Index budget (advisory)<", ">Add memory<"],
    failures,
  );
  // Feature off: the budget describes an index that is not delivered, so it goes with the table.
  requireMarkup(
    surfaces.settingsMemoriesOff,
    "settingsMemoriesOff",
    [">Memories are off<", "disabled>Add memory<"],
    failures,
  );
  rejectMarkup(
    surfaces.settingsMemoriesOff,
    "settingsMemoriesOff",
    ["lmsa-memory-table", "lmsa-memory-capacity"],
    failures,
  );

  if (failures.length > 0) {
    throw new Error(`Visual surface contract audit failed:\n- ${failures.join("\n- ")}`);
  }

  return Object.keys(surfaces).length;
}
