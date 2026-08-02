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
      requireMarkup(
        surface,
        id,
        [
          "setting-page vertical-tab-content lmsa-settings-root",
          "setting-page-titlebar",
          "setting-page-content",
          "lmsa-settings-panel",
        ],
        failures,
      );
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

  if (failures.length > 0) {
    throw new Error(`Visual surface contract audit failed:\n- ${failures.join("\n- ")}`);
  }

  return Object.keys(surfaces).length;
}
