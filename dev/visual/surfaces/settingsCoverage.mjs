import { settingsItemsView, settingsView } from "../scaffold.mjs";
import { I } from "../fixtures/icons.mjs";
import {
  convertedBlock,
  convertedFooter,
  convertedRow,
  convertedSection,
  section,
} from "../fixtures/primitives.mjs";

const BUILTIN_COMMAND_CATEGORIES = [
  {
    label: "Revision",
    commands: [
      [
        "Tighten",
        I.scissors,
        "Rewrite the following more concisely, cut filler words and redundancy while preserving the meaning and tone:\n\n{{selection}}",
      ],
      [
        "Expand",
        I.unfoldVertical,
        "Expand the following with richer detail, description, or supporting points:\n\n{{selection}}",
      ],
      [
        "Fix prose",
        I.spellCheck,
        "Fix grammar, spelling, and punctuation in the following text, correct mistakes only, don't restyle:\n\n{{selection}}",
      ],
      [
        "Simplify",
        I.minimize2,
        "Rewrite the following in plainer, more direct language:\n\n{{selection}}",
      ],
    ],
  },
  {
    label: "Creative",
    commands: [
      [
        "Continue",
        I.arrowRight,
        "Continue writing from where the note leaves off, matching the existing style and voice:\n\n{{note}}",
      ],
      [
        "Brainstorm",
        I.lightbulb,
        "Suggest 5 different directions I could take the following text next:\n\n{{selection}}",
      ],
      [
        "Show don't tell",
        I.eye,
        "Rewrite the following to show rather than tell, using concrete sensory details:\n\n{{selection}}",
      ],
    ],
  },
  {
    label: "Analysis",
    commands: [
      [
        "Summarize",
        I.list,
        "Provide a concise summary of the following text, capturing the key points and main ideas:\n\n{{selection}}",
      ],
      [
        "Critique",
        I.messageCircle,
        "Give constructive feedback on the following, what works, what doesn't, and specific suggestions for improvement:\n\n{{selection}}",
      ],
    ],
  },
];

const commandRow = (name, icon, prompt, { custom = false } = {}) =>
  `<div class="lmsa-item-row${custom ? "" : " is-builtin"}">
    <div class="lmsa-command-icon">${icon}</div>
    <div class="lmsa-item-info">
      <div class="lmsa-command-header">
        <div class="lmsa-command-badge ${custom ? "is-user-created" : "is-builtin"}">${custom ? "User-created" : "Built-in"}</div>
        <div class="lmsa-item-name">${name}</div>
      </div>
      <div class="lmsa-item-sub">${prompt}</div>
    </div>
    ${
      custom
        ? `<div class="lmsa-item-actions">
            <button class="lmsa-btn-secondary lmsa-ui-btn lmsa-ui-btn-secondary">Edit</button>
            <button class="lmsa-btn-danger lmsa-ui-btn">Delete</button>
          </div>`
        : ""
    }
  </div>`;

const builtinCommandList = BUILTIN_COMMAND_CATEGORIES.map(
  (category) =>
    `<div class="lmsa-command-category-label">${category.label}</div>
     ${category.commands
       .map(([name, icon, prompt]) => commandRow(name, icon, prompt))
       .join("")}`,
).join("");

// Converted: the hint block, the read-only catalogue, the custom list and the add button are four
// rows of one group. Consecutive block rows sit flush, the way these four sat inside the card body.
const commandLibrary = (customContent) =>
  convertedSection(
    "commands",
    "Command library",
    "Prompt shortcuts that appear in chat and the editor context menu. Select text, right-click, and pick a command from the Writing assistant submenu.",
    convertedBlock(
      `<div class="lmsa-settings-note">
        <div class="lmsa-settings-note-title">Prompt variables</div>
        <ul class="lmsa-hint-list">
          <li>{{selection}} inserts the current editor selection.</li>
          <li>{{note}} inserts the active note text, trimmed to the note context limit (keeps the ending when trimmed).</li>
        </ul>
      </div>`,
    ) +
      convertedBlock(`<div class="lmsa-item-list">${builtinCommandList}</div>`) +
      convertedBlock(
        `<div class="lmsa-item-list">
          <div class="lmsa-command-category-label">Custom commands</div>
          ${customContent}
        </div>`,
      ) +
      convertedFooter(
        '<button class="lmsa-btn-add lmsa-ui-btn lmsa-ui-btn-primary">Add command</button>',
      ),
    I.terminal,
  );

const gateSelect = () =>
  `<select>
    <option value="ask" selected>Ask</option>
    <option value="auto">Auto-apply</option>
    <option value="deny">Deny</option>
  </select>`;

const benchmarkIteration = ({
  evaluation,
  evidence,
  index,
  passed,
  response,
  seconds,
  warning = false,
}) =>
  `<div class="lmsa-benchmark-iteration">
    <div class="lmsa-benchmark-iteration-header">
      <span class="lmsa-benchmark-iteration-label">Iteration ${index}</span>
      <span class="lmsa-benchmark-iteration-status ${passed ? "is-passed" : "is-failed"}">${passed ? "Passed" : "Failed"} (${seconds}s)</span>
    </div>
    <div class="lmsa-benchmark-detail-section">
      <strong>Evaluation: </strong><span>${evaluation}</span>
    </div>
    <div class="lmsa-benchmark-detail-section">
      <strong>Checks:</strong>
      <ul class="lmsa-benchmark-check-list">
        <li class="lmsa-benchmark-check ${passed ? "is-passed" : "is-failed"}">
          <span class="lmsa-benchmark-check-icon">${passed ? I.check : I.x}</span>
          <span class="lmsa-benchmark-check-body">
            <span class="lmsa-benchmark-check-label">All blocks match the document</span>
            <span class="lmsa-benchmark-check-detail">, ${passed ? "exact SEARCH text found" : "one SEARCH block did not match"}</span>
          </span>
        </li>
        ${
          warning
            ? `<li class="lmsa-benchmark-check is-warning">
                <span class="lmsa-benchmark-check-icon">${I.alertTriangle}</span>
                <span class="lmsa-benchmark-check-body">
                  <span class="lmsa-benchmark-check-label">Target wording remained concise</span>
                  <span class="lmsa-benchmark-check-detail">, response added one explanatory sentence</span>
                  <span class="lmsa-benchmark-check-optional"> (informational)</span>
                </span>
              </li>`
            : ""
        }
      </ul>
    </div>
    <div class="lmsa-benchmark-detail-section">
      <strong>Evidence:</strong>
      <ul class="lmsa-benchmark-evidence-list"><li>${evidence}</li></ul>
    </div>
    <div class="lmsa-benchmark-detail-section">
      <strong>Model response:</strong>
      <pre class="lmsa-benchmark-response-block">${response}</pre>
    </div>
  </div>`;

const populatedBenchmarkSection = section(
  "Test suites",
  "",
  `<div class="lmsa-benchmark-setting-row">
    <div class="lmsa-benchmark-setting-info">
      <span class="lmsa-benchmark-setting-name">Iterations per test</span>
      <span class="lmsa-benchmark-setting-desc">Run each test multiple times to measure consistency. Higher values give more reliable results but take longer.</span>
    </div>
    <input class="lmsa-benchmark-setting-input" type="number" min="1" max="20" placeholder="3" value="3">
  </div>
  <div class="lmsa-benchmark-setting-row">
    <div class="lmsa-benchmark-setting-info">
      <span class="lmsa-benchmark-setting-name">Report folder</span>
      <span class="lmsa-benchmark-setting-desc">Vault folder where exported benchmark reports are created.</span>
    </div>
    <input class="lmsa-benchmark-setting-input lmsa-benchmark-setting-input--wide" type="text" placeholder="Benchmarks" value="Benchmarks">
  </div>
  <div class="lmsa-benchmark-warning lmsa-hidden">
    <span class="lmsa-benchmark-warning-icon">${I.alertTriangle}</span>
    <span class="lmsa-benchmark-warning-text"></span>
  </div>
  <div class="lmsa-benchmark-tab-bar">
    <button class="lmsa-benchmark-tab is-active"><span class="lmsa-benchmark-tab-icon">${I.pencil}</span><span>Edit annotations</span></button>
    <button class="lmsa-benchmark-tab"><span class="lmsa-benchmark-tab-icon">${I.wrench}</span><span>Edit tools</span></button>
    <button class="lmsa-benchmark-tab"><span class="lmsa-benchmark-tab-icon">${I.brain}</span><span>Memory</span></button>
  </div>
  <div class="lmsa-benchmark-tab-content">
    <p class="lmsa-settings-section-desc">Each test sends a synthetic conversation to the model and evaluates whether it correctly interprets edit outcome annotations.</p>
    <div class="lmsa-benchmark-suite-actions">
      <button class="lmsa-benchmark-btn lmsa-benchmark-btn--run-suite">
        <span class="lmsa-benchmark-btn-icon">${I.play}</span><span>Run suite</span>
      </button>
    </div>
    <div class="lmsa-benchmark-cards">
      <div class="lmsa-benchmark-card">
        <div class="lmsa-benchmark-card-header">
          <div class="lmsa-benchmark-card-title-row">
            <span class="lmsa-benchmark-card-name">Respect rejected edits</span>
            <span class="lmsa-benchmark-card-status is-mixed">2/3 passed (avg 4.2s)</span>
          </div>
          <p class="lmsa-benchmark-card-desc">Short document, 2 edits proposed (1 accepted, 1 rejected). Model should rework the rejected fountain paragraph, not the accepted opening.</p>
          <div class="lmsa-benchmark-progress lmsa-hidden"></div>
          <div class="lmsa-benchmark-card-actions">
            <button class="lmsa-benchmark-btn lmsa-benchmark-btn--run"><span class="lmsa-benchmark-btn-icon">${I.play}</span><span>Run</span></button>
            <button class="lmsa-benchmark-btn lmsa-benchmark-btn--toggle"><span class="lmsa-benchmark-btn-icon">${I.chevronUp}</span><span>Details</span></button>
          </div>
        </div>
        <div class="lmsa-benchmark-card-details">
          <div class="lmsa-benchmark-criteria">
            <div class="lmsa-benchmark-section-header"><strong>Evaluation criteria</strong></div>
            <div class="lmsa-benchmark-criteria-row"><strong>Expected: </strong><span>Model produces SEARCH/REPLACE blocks that match the document text exactly, rewrite the rejected fountain paragraph, and leave the accepted opening untouched.</span></div>
            <div class="lmsa-benchmark-criteria-row"><strong>Must target (Rejected fountain paragraph): </strong><span>children, fountain, pebbles, old woman, bench</span></div>
            <div class="lmsa-benchmark-criteria-row"><strong>Must avoid (Accepted opening paragraph): </strong><span>dawn broke golden, cobblestones, whispered invitation</span></div>
            <div class="lmsa-benchmark-criteria-row lmsa-benchmark-criteria-notes"><em>Blocks are resolved against the document with the real diff engine; a block that would not apply fails the test.</em></div>
          </div>
          <div class="lmsa-benchmark-conversation">
            <div class="lmsa-benchmark-section-header"><strong>Conversation (3 messages)</strong></div>
            <div class="lmsa-benchmark-msg"><span class="lmsa-benchmark-msg-role lmsa-benchmark-msg-role--user">user</span><span class="lmsa-benchmark-msg-content">Can you make the opening paragraph and the fountain scene more vivid?</span></div>
            <div class="lmsa-benchmark-msg"><span class="lmsa-benchmark-msg-role lmsa-benchmark-msg-role--assistant">assistant</span><span class="lmsa-benchmark-msg-content">I've rewritten two paragraphs. The first was accepted and the second was rejected.</span></div>
            <div class="lmsa-benchmark-msg"><span class="lmsa-benchmark-msg-role lmsa-benchmark-msg-role--user">user</span><span class="lmsa-benchmark-msg-content">Try rewriting the fountain paragraph again with a different approach.</span></div>
          </div>
          <div class="lmsa-benchmark-results-container">
            <div class="lmsa-benchmark-section-header"><strong>Results</strong></div>
            ${benchmarkIteration({
              evaluation: "The rejected fountain paragraph was targeted and the accepted opening stayed untouched.",
              evidence: "SEARCH begins with Children gathered near the fountain.",
              index: 1,
              passed: true,
              response: "<<<<<<< SEARCH\nChildren gathered near the fountain...\n=======\nThe children fell quiet around the fountain...\n>>>>>>> REPLACE",
              seconds: "3.8",
            })}
            ${benchmarkIteration({
              evaluation: "One SEARCH block used text that was not present in the current document.",
              evidence: "SEARCH begins with Dawn poured across the fountain.",
              index: 2,
              passed: false,
              response: "<<<<<<< SEARCH\nDawn poured across the fountain...\n=======\nMorning held its breath around the fountain...\n>>>>>>> REPLACE",
              seconds: "4.9",
              warning: true,
            })}
            ${benchmarkIteration({
              evaluation: "The replacement applied exactly and stayed inside the rejected region.",
              evidence: "Matched the fountain paragraph without touching accepted prose.",
              index: 3,
              passed: true,
              response: "<<<<<<< SEARCH\nChildren gathered near the fountain...\n=======\nPebbles ticked across the fountain basin...\n>>>>>>> REPLACE",
              seconds: "3.9",
            })}
          </div>
        </div>
      </div>
    </div>
    <div class="lmsa-benchmark-summary">
      <div class="lmsa-benchmark-summary-headline">
        <span class="lmsa-benchmark-summary-scope">This suite: </span>
        <span class="lmsa-benchmark-summary--mixed">0/1 tests fully passed</span>
        <span class="lmsa-benchmark-summary-detail"> (2/3 total iterations)</span>
      </div>
    </div>
  </div>
  <div class="lmsa-benchmark-summary">
    <div class="lmsa-benchmark-summary-headline">
      <span class="lmsa-benchmark-summary-scope">All suites: </span>
      <span class="lmsa-benchmark-summary--mixed">0/1 tests fully passed</span>
      <span class="lmsa-benchmark-summary-detail"> (2/3 total iterations)</span>
    </div>
  </div>`,
  I.flaskConical,
).replace(
  '<div class="lmsa-settings-section-actions"></div>',
  `<div class="lmsa-settings-section-actions">
    <button class="lmsa-benchmark-btn lmsa-benchmark-btn--export">Export report</button>
    <button class="lmsa-benchmark-btn lmsa-benchmark-btn--run-all">Run all</button>
    <button class="lmsa-benchmark-btn lmsa-benchmark-btn--abort lmsa-hidden">Abort</button>
  </div>`,
);

export const SETTINGS_COVERAGE_SURFACES = {
  settingsCommands: {
    source: "src/settings/CommandsTab.ts",
    shot: ".setting-page",
    html: settingsItemsView(
      commandLibrary(
        commandRow(
          "Tighten dialogue",
          I.scissors,
          "Rewrite {{selection}} with tighter dialogue while preserving voice and subtext.",
          { custom: true },
        ),
      ),
      720,
      "commands",
    ),
  },

  settingsCommandsEmpty: {
    source: "src/settings/CommandsTab.ts",
    shot: ".setting-page",
    html: settingsItemsView(
      commandLibrary(
        '<p class="lmsa-empty-state">No custom commands configured yet.</p>',
      ),
      720,
      "commands",
    ),
  },

  // Converted: Obsidian's declarative renderer builds the group and row elements, so there is no
  // panel and each card is the token host. The only tab whose rows carry a <select> or a
  // <textarea>, so it is where the form-control skin meets the group cascade.
  settingsVaultOps: {
    source: "src/settings/VaultOpsTab.ts",
    shot: ".setting-page",
    html: settingsItemsView(
      convertedSection(
        "vault-operations",
        "Approvals",
        "Decide how each kind of vault operation is handled. Deny removes the tool entirely; Ask waits for your review; Auto-apply applies it without a click, but every operation is still shown and can be undone.",
        `${convertedRow("Create file", "Writing a brand-new note at a path that doesn't exist yet.", gateSelect())}
        ${convertedRow("Overwrite file", "Replacing the entire contents of an existing note. Targeted prose changes go through document edits instead.", gateSelect())}
        ${convertedRow("Move or rename", "Moving or renaming a note. Wikilinks and backlinks are rewritten automatically.", gateSelect())}
        ${convertedRow("Trash file", "Sending a note to trash (honoring your deleted-files preference). Files only.", gateSelect())}
        ${convertedRow("Create folder", "Creating a folder. Idempotent, does nothing if it already exists.", gateSelect())}
        ${convertedRow("Edit document", "Targeted in-document changes and frontmatter updates (propose_edit, update_frontmatter). Ask shows the diff and waits; Auto-apply lands the edit without a click, even on a note you don't have open.", gateSelect())}`,
        I.shieldCheck,
      ) +
        convertedSection(
          "vault-operations",
          "Auto-apply limits",
          "Bound what auto-applied operations can touch and how many can run before the rest fall back to Ask.",
          `${convertedRow(
            "Auto-apply scopes",
            "Folder prefixes eligible for auto-apply (one per line). When set, operations outside these folders fall back to manual review. Leave empty to allow auto-apply anywhere.",
            '<textarea rows="4" placeholder="e.g. drafts/ai">Drafts/AI\nScenes</textarea>',
          )}
          ${convertedRow(
            "Max auto operations per turn",
            'Circuit breaker for the per-class auto-apply policy: once this many operations auto-apply in a single turn, the rest fall back to Ask. "Edit automatically" is unbounded and ignores this. Default: 8.',
            '<input type="text" placeholder="8" value="8">',
          )}`,
          I.gitFork,
        ),
      720,
      "vault-operations",
    ),
  },

  settingsBenchmarkPopulated: {
    source: "src/settings/benchmark/BenchmarkRenderers.ts",
    shot: ".setting-page",
    html: settingsView(populatedBenchmarkSection, 720, "benchmark"),
  },
};
