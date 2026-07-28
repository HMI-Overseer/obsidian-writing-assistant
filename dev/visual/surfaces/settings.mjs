import { settingsView } from "../scaffold.mjs";
import { BRAND, I } from "../fixtures/icons.mjs";
import { memoryOffState, memoryRow, memoryTable } from "../fixtures/memory.mjs";
import { section, settingItem, sw } from "../fixtures/primitives.mjs";

export const SETTINGS_SURFACES = {

  // S16: settings General tab, two section cards.
  settingsGeneral: {
    source: "src/settings/GeneralTab.ts",
    shot: ".lmsa-settings-shell",
    html: settingsView(
      section(
        "Active Note",
        "Include your currently open note as context so chat responses stay grounded in your writing.",
        `${settingItem("Include active note as context", "Send the content of the currently open note alongside each request.", sw("is-enabled"))}
        ${settingItem("Include local attachments as context when supported", "When a note is attached and the active model supports vision, send supported local image embeds from that note as extra context.", sw())}
        ${settingItem("Note context limit", "Maximum characters of note text sent as context, 1000–200000 (default: 8000). Longer notes are trimmed; continuation commands keep the ending.", `<input type="text" value="8000">`)}`,
        I.fileText,
      ) +
        section(
          "Support",
          "This plugin and all of its features are, and will always be, free. If it helped you get closer to achieving your creative goals, you can support this project in the following ways.",
          `<div class="lmsa-support-grid">
            <div class="lmsa-support-card">
              <div class="lmsa-support-card-icon">${I.coffee}</div>
              <div class="lmsa-support-card-text">
                <div class="lmsa-support-card-name">Buy Me a Coffee</div>
                <div class="lmsa-support-card-desc">One-time support</div>
              </div>
            </div>
          </div>`,
          I.heart,
        ),
      720,
      "general",
    ),
  },

  // S17: settings Providers tab, provider cards (brand-tint icons, status dots, auth fields).
  settingsProviders: {
    source: "src/settings/ProvidersTab.ts",
    shot: ".lmsa-settings-shell",
    html: settingsView(
      `<div class="lmsa-provider-cards">
        <div class="lmsa-provider-card">
          <div class="lmsa-provider-card-header">
            <div class="lmsa-provider-card-iconwrap">
              <div class="lmsa-provider-card-icon lmsa-brand-tint-lmstudio">${BRAND.lmstudio}</div>
              <span class="lmsa-provider-status-dot is-ok"></span>
            </div>
            <div class="lmsa-provider-card-info">
              <div class="lmsa-provider-card-name-row">
                <span class="lmsa-provider-card-name">LM Studio</span>
                <span class="lmsa-provider-card-version lmsa-hidden"></span>
              </div>
              <div class="lmsa-provider-card-status">Local server · 3 models last seen</div>
            </div>
            <span class="lmsa-provider-card-chevron">${I.chevronDown}</span>
            <div class="lmsa-provider-card-toggle">${sw("is-enabled")}</div>
          </div>
          <div class="lmsa-provider-card-bodywrap" inert><div class="lmsa-provider-card-bodyclip"><div class="lmsa-provider-card-body"></div></div></div>
        </div>
        <div class="lmsa-provider-card is-expanded">
          <div class="lmsa-provider-card-header">
            <div class="lmsa-provider-card-iconwrap">
              <div class="lmsa-provider-card-icon lmsa-brand-tint-anthropic">${BRAND.anthropic}</div>
              <span class="lmsa-provider-status-dot is-ok"></span>
            </div>
            <div class="lmsa-provider-card-info">
              <div class="lmsa-provider-card-name-row">
                <span class="lmsa-provider-card-name">Anthropic</span>
                <span class="lmsa-provider-card-version lmsa-hidden"></span>
              </div>
              <div class="lmsa-provider-card-status">API key set · 8 models available in chat</div>
            </div>
            <span class="lmsa-provider-card-chevron">${I.chevronDown}</span>
            <div class="lmsa-provider-card-toggle">${sw("is-enabled")}</div>
          </div>
          <div class="lmsa-provider-card-bodywrap"><div class="lmsa-provider-card-bodyclip"><div class="lmsa-provider-card-body">
            ${settingItem("API key", "Stored locally in this vault and never shared. Saving a key enables the provider.", `<input type="password" placeholder="sk-ant-…">`)}
            <div class="lmsa-provider-models">
              <div class="lmsa-provider-models-header">
                <span class="lmsa-provider-models-title">Models</span>
                <span class="lmsa-provider-models-meta">Built-in catalog</span>
              </div>
              <div class="lmsa-item-list">
                <div class="lmsa-item-row lmsa-provider-model-row">
                  <div class="lmsa-item-info">
                    <div class="lmsa-provider-model-name">Claude Sonnet 4.5</div>
                    <div class="lmsa-provider-model-id">claude-sonnet-4-5</div>
                  </div>
                  <div class="lmsa-provider-model-badges">
                    <span class="lmsa-provider-role-chip">completion</span>
                    <span class="lmsa-provider-context-chip">200K context</span>
                  </div>
                </div>
              </div>
            </div>
          </div></div></div>
        </div>
        <div class="lmsa-provider-card">
          <div class="lmsa-provider-card-header">
            <div class="lmsa-provider-card-iconwrap">
              <div class="lmsa-provider-card-icon lmsa-brand-tint-openai">${BRAND.openai}</div>
              <span class="lmsa-provider-status-dot is-ok"></span>
            </div>
            <div class="lmsa-provider-card-info">
              <div class="lmsa-provider-card-name-row">
                <span class="lmsa-provider-card-name">OpenAI</span>
                <span class="lmsa-provider-card-version lmsa-hidden"></span>
              </div>
              <div class="lmsa-provider-card-status">API key set · 6 models available in chat</div>
            </div>
            <span class="lmsa-provider-card-chevron">${I.chevronDown}</span>
            <div class="lmsa-provider-card-toggle">${sw("is-enabled")}</div>
          </div>
          <div class="lmsa-provider-card-bodywrap" inert><div class="lmsa-provider-card-bodyclip"><div class="lmsa-provider-card-body"></div></div></div>
        </div>
        <div class="lmsa-provider-card is-off">
          <div class="lmsa-provider-card-header">
            <div class="lmsa-provider-card-iconwrap">
              <div class="lmsa-provider-card-icon lmsa-brand-tint-claudecode">${BRAND.claudecode}</div>
              <span class="lmsa-provider-status-dot is-error"></span>
            </div>
            <div class="lmsa-provider-card-info">
              <div class="lmsa-provider-card-name-row">
                <span class="lmsa-provider-card-name">Claude Code</span>
                <span class="lmsa-provider-card-version">v2.1.201</span>
              </div>
              <div class="lmsa-provider-card-status">Not found · the Claude Code CLI is not installed or not on the system path</div>
            </div>
            <span class="lmsa-provider-card-chevron">${I.chevronDown}</span>
            <div class="lmsa-provider-card-toggle">${sw("is-disabled")}</div>
          </div>
          <div class="lmsa-provider-card-bodywrap" inert><div class="lmsa-provider-card-bodyclip"><div class="lmsa-provider-card-body"></div></div></div>
        </div>
      </div>
      <p class="lmsa-provider-footnote">Cloud model catalogs ship with the plugin and refresh with each release. Local models are discovered live from LM Studio.</p>`,
      720,
      "providers",
    ),
  },

  // S18: shared settings model selector, dropdown open (delta (a) pre-existing search border lives here).
  settingsModelSelector: {
    source: "src/settings/ui.ts",
    w: 720,
    shot: ".lmsa-settings-model-selector-wrap",
    html: settingsView(
      `<div class="lmsa-settings-model-selector-wrap">
        <div class="lmsa-settings-model-selector is-active">
          <span class="lmsa-model-selector-status is-cloud"></span>
          <span class="lmsa-settings-model-selector-label">Claude Sonnet 4.5</span>
          <span class="lmsa-settings-model-selector-chevron">${I.chevronUp}</span>
        </div>
        <div class="lmsa-model-dropdown">
          <div class="lmsa-model-dropdown-search">
            <span class="lmsa-model-dropdown-search-icon">${I.search}</span>
            <input class="lmsa-model-dropdown-search-input" type="text" placeholder="Search models...">
            <button class="lmsa-model-dropdown-refresh" aria-label="Refresh models">${I.refresh}</button>
          </div>
          <div class="lmsa-model-dropdown-body">
            <div class="lmsa-provider-rail">
              <div class="lmsa-provider-rail-item is-active" title="Favorites">${I.star}</div>
              <div class="lmsa-provider-rail-divider"></div>
              <div class="lmsa-provider-rail-item lmsa-brand-tint-lmstudio" title="LM Studio">${BRAND.lmstudio}</div>
              <div class="lmsa-provider-rail-item lmsa-brand-tint-anthropic" title="Anthropic">${BRAND.anthropic}</div>
              <div class="lmsa-provider-rail-item lmsa-brand-tint-openai" title="OpenAI">${BRAND.openai}</div>
              <div class="lmsa-provider-rail-item lmsa-brand-tint-claudecode" title="Claude Code">${BRAND.claudecode}</div>
            </div>
            <div class="lmsa-model-dropdown-list">
              <div class="lmsa-model-dropdown-item is-active">
                <span class="lmsa-model-dropdown-check">${I.check}</span>
                <div class="lmsa-model-dropdown-copy">
                  <span class="lmsa-model-dropdown-name">Claude Sonnet 4.5</span>
                  <span class="lmsa-model-dropdown-provider">Anthropic</span>
                </div>
                <span class="lmsa-model-dropdown-state is-cloud"></span>
                <span class="lmsa-model-dropdown-star is-faved">${I.star}</span>
              </div>
              <div class="lmsa-model-dropdown-item">
                <span class="lmsa-model-dropdown-check"></span>
                <div class="lmsa-model-dropdown-copy">
                  <span class="lmsa-model-dropdown-name">Llama 3.1 8B</span>
                  <span class="lmsa-model-dropdown-provider">LM Studio</span>
                </div>
                <span class="lmsa-model-dropdown-state is-unloaded"></span>
                <span class="lmsa-model-dropdown-star is-faved">${I.star}</span>
              </div>
            </div>
          </div>
        </div>
      </div>`,
      720,
      "providers",
    ),
  },

  // S19: settings Benchmark tab, model-selection + test-suites cards.
  settingsBenchmark: {
    source: "src/settings/BenchmarkTab.ts",
    shot: ".lmsa-settings-shell",
    html: settingsView(
      section(
        "Model selection",
        "Choose a completion model to run benchmarks against. The model must be loaded.",
        `${settingItem(
          "Completion model",
          "The model used to run benchmark tests.",
          "",
          `<div class="lmsa-settings-model-selector-wrap lmsa-benchmark-model-wrap">
            <div class="lmsa-settings-model-selector"><span class="lmsa-model-selector-status is-unknown"></span><span class="lmsa-settings-model-selector-label">Select model...</span><span class="lmsa-settings-model-selector-chevron">${I.chevronDown}</span></div>
            <div class="lmsa-model-dropdown lmsa-hidden"></div>
            <button class="lmsa-profile-settings-btn" aria-label="Profile settings">${I.gear}</button>
            <div class="lmsa-profile-popover lmsa-hidden"></div>
          </div>`,
        )}`,
        I.target,
      ) +
        section(
          "Test suites",
          "",
          `<div class="lmsa-benchmark-setting-row">
            <div class="lmsa-benchmark-setting-info">
              <span class="lmsa-benchmark-setting-name">Iterations per test</span>
              <span class="lmsa-benchmark-setting-desc">Run each test multiple times to measure consistency.</span>
            </div>
            <input class="lmsa-benchmark-setting-input" type="number" min="1" max="20" value="3">
          </div>
          <div class="lmsa-benchmark-setting-row">
            <div class="lmsa-benchmark-setting-info">
              <span class="lmsa-benchmark-setting-name">Report folder</span>
              <span class="lmsa-benchmark-setting-desc">Vault folder where exported reports are created.</span>
            </div>
            <input class="lmsa-benchmark-setting-input lmsa-benchmark-setting-input--wide" type="text" value="Benchmarks">
          </div>
          <div class="lmsa-benchmark-tab-bar">
            <button class="lmsa-benchmark-tab is-active"><span class="lmsa-benchmark-tab-icon">${I.pencil}</span><span>Editing</span></button>
            <button class="lmsa-benchmark-tab"><span class="lmsa-benchmark-tab-icon">${I.brain}</span><span>Reasoning</span></button>
          </div>
          <div class="lmsa-benchmark-tab-content">
            <div class="lmsa-benchmark-suite-actions">
              <button class="lmsa-benchmark-btn lmsa-benchmark-btn--run-suite"><span class="lmsa-benchmark-btn-icon">${I.play}</span><span>Run suite</span></button>
            </div>
            <div class="lmsa-benchmark-cards">
              <div class="lmsa-benchmark-card">
                <div class="lmsa-benchmark-card-header">
                  <div class="lmsa-benchmark-card-title-row">
                    <span class="lmsa-benchmark-card-name">Paragraph rewrite<span class="lmsa-benchmark-badge lmsa-benchmark-badge--control">control</span></span>
                    <span class="lmsa-benchmark-card-status is-passed">Passed</span>
                  </div>
                  <p class="lmsa-benchmark-card-desc">Rewrite a paragraph while preserving meaning.</p>
                  <div class="lmsa-benchmark-card-actions">
                    <button class="lmsa-benchmark-btn lmsa-benchmark-btn--run"><span class="lmsa-benchmark-btn-icon">${I.play}</span><span>Run</span></button>
                    <button class="lmsa-benchmark-btn lmsa-benchmark-btn--toggle"><span class="lmsa-benchmark-btn-icon">${I.chevronDown}</span><span>Details</span></button>
                  </div>
                </div>
              </div>
            </div>
            <div class="lmsa-benchmark-summary">Run tests to see results.</div>
          </div>`,
          I.flaskConical,
        ),
      720,
      "benchmark",
    ),
  },

  // S20: settings Index / RAG tab. The stale/drift notice (muted amber) is the key chip.
  settingsRag: {
    source: "src/settings/RagTab.ts",
    shot: ".lmsa-settings-shell",
    html: settingsView(
      section(
        "Vault retrieval",
        "Automatically find and inject relevant vault content into each chat request using embedding-based search.",
        `${settingItem("Enable vault retrieval", "When enabled, the plugin can index your vault and retrieve relevant notes for each chat message.", sw("is-enabled"))}
        ${settingItem(
          "Embedding model",
          "Encodes vault content as vectors for similarity search.",
          "",
          `<div class="lmsa-settings-model-selector-wrap">
            <div class="lmsa-settings-model-selector"><span class="lmsa-model-selector-status is-cloud"></span><span class="lmsa-settings-model-selector-label">text-embedding-3-large</span><span class="lmsa-settings-model-selector-chevron">${I.chevronDown}</span></div>
            <div class="lmsa-model-dropdown lmsa-hidden"></div>
          </div>`,
        )}`,
        I.search,
      ) +
        `<div class="lmsa-rag-conditional">${section(
          "Index",
          "Manage the vector index used for retrieval.",
          `<div class="lmsa-index-status">
            <div class="lmsa-index-status-header">
              <div class="lmsa-index-status-info">
                <p class="lmsa-index-status-text">128 files, 512 chunks indexed.</p>
                <p class="lmsa-index-drift-notice is-visible">Settings changed since last build. Rebuild recommended.</p>
              </div>
              <div class="lmsa-index-actions">
                <button class="lmsa-ui-btn lmsa-ui-btn-primary">Build index</button>
                <button class="lmsa-ui-btn lmsa-ui-btn-secondary is-visible">Rebuild index</button>
              </div>
            </div>
            <div class="lmsa-index-progress">
              <div class="lmsa-index-progress-bar"><div class="lmsa-index-progress-fill" style="width:0%"></div></div>
              <span class="lmsa-index-progress-text"></span>
            </div>
          </div>`,
          I.database,
        ) +
          section(
            "Automatic reindexing",
            "Keep the index current as your vault changes. Automatic runs never load a local embedding model that is not already running, they wait until it is.",
            `${settingItem("Reindex on startup", "When the plugin loads, scan for notes changed while it was off and index them.", sw("is-enabled"))}
            ${settingItem("Watch for changes", "Reindex each note as it is created, edited, renamed, or deleted.", sw("is-enabled"))}
            ${settingItem("Auto-reindex on cloud models", "Allow automatic runs to embed through a metered cloud model. Off keeps automatic reindexing local-only, so cloud embedding stays manual and avoids unexpected API cost.", sw())}`,
            I.refresh,
          ) +
          section(
            "Retrieval",
            "Control how many and which results are injected as context.",
            `${settingItem("Metadata enrichment", "Prepend tags, folder path, and wikilink targets to each chunk before embedding. Improves entity disambiguation in creative writing vaults.", sw("is-enabled"))}
            ${settingItem("Results per query", "Number of relevant chunks to inject, 1–20 (default: 5).", `<input type="text" value="5">`)}
            ${settingItem("Max chunks per file", "Limit how many chunks a single file can contribute, 1–20 (default: 5).", `<input type="text" value="5">`)}
            ${settingItem("Minimum similarity", "Only include results above this score, 0–0.8 (default: 0.3).", `<input type="text" value="0.3">`)}`,
            I.filter,
          ) +
          section(
            "Chunking",
            "Configure how vault notes are split into retrieval-friendly pieces.",
            `${settingItem("Chunk size", "Target characters per chunk, 500–3000 (default: 1500).", `<input type="text" value="1500">`)}
            ${settingItem("Chunk overlap", "Characters of overlap between adjacent chunks, 0–500 (default: 200).", `<input type="text" value="200">`)}
            ${settingItem("Exclude patterns", "Glob patterns for files to exclude from indexing (one per line).", `<textarea rows="4" placeholder="e.g. templates/**">Templates/**</textarea>`)}`,
            I.scissors,
          )}</div>`,
      720,
      "retrieval",
    ),
  },

  // S21a: settings Advanced tab.
  settingsAdvanced: {
    source: "src/settings/AdvancedTab.ts",
    shot: ".lmsa-settings-shell",
    html: settingsView(
      section(
        "Agentic mode",
        "Allow the model to call tools: search your vault, read notes, and apply structured edits across multiple reasoning rounds.",
        `${settingItem("Enable agentic mode", "Vault search and edit tools become available. The model can read notes and iterate before producing a response.", sw())}
        ${settingItem("Max tool rounds", "Maximum read-only tool rounds per turn (vault search and outline inspection before the model responds or edits). Default: 8.", `<input type="text" value="8">`)}`,
        I.bot,
      ) +
        section(
          "Document Editing",
          "Configure how AI-proposed edits are matched against your notes.",
          `${settingItem("Diff context lines", "Number of lines shown above and below each diff hunk for context.", `<input type="text" value="3">`)}
          ${settingItem("Minimum match confidence", "Fuzzy match confidence threshold (0–1). Matches below this score are flagged as unresolved. Default: 0.7", `<input type="text" value="0.7">`)}`,
          I.fileDiff,
        ) +
        section(
          "System prompt prefix",
          "Prepended before your custom prompt (set in the chat popover) on every turn. Leave empty to use only your custom prompt. Edit-format guidance is added automatically when editing.",
          `${settingItem(
            "Prefix",
            "Prepended before your custom prompt on every turn.",
            `<textarea class="lmsa-monospace" rows="6" placeholder="No prefix, using your custom prompt only"></textarea>
             <button class="lmsa-ui-btn lmsa-ui-btn-secondary">Reset to default</button>`,
          )}`,
          I.messageSquare,
        ),
      720,
      "advanced",
    ),
  },

  // S21d: settings Memories tab (feature card + the records table + budget bar).
  settingsMemories: {
    source: "src/settings/MemoriesTab.ts",
    shot: ".lmsa-settings-shell",
    html: settingsView(
      section(
        "Memory",
        "",
        `${settingItem("Enable memories", "Deliver the memory index with every request and offer the memory tools.", sw("is-enabled"))}
        ${settingItem("Memory changes", "How the assistant's add and forget requests are handled. Deny removes both tools. The vault edit posture overrides this, as it does every other approval class.", `<select><option>Ask</option><option>Auto-apply</option><option>Deny</option></select>`)}
`,
        I.brain,
      ) +
        section(
          "Stored memories",
          "",
          memoryTable(
            `${memoryRow("no-emdashes", "rule", "Never use em dashes; use commas for asides and colons before lists.")}
             ${memoryRow("no-emojis", "rule", "Never use emojis.", false)}
             ${memoryRow("pov-limited", "rule", "Write in third person limited, one viewpoint per scene.", true, true)}
             ${memoryRow("vault-tone", "context", "The vault's grimdark tone and genre; recall when setting scene mood.")}`,
          ),
          I.bookOpen,
        ).replace(
          '<div class="lmsa-settings-section-footer"></div>',
          '<div class="lmsa-settings-section-footer"><button class="lmsa-btn-add lmsa-ui-btn lmsa-ui-btn-primary">Add memory</button></div>',
        ),
      720,
      "memories",
    ),
  },

  // S21e: settings Memories tab with the feature switched off (records card inactive).
  settingsMemoriesOff: {
    source: "src/settings/MemoriesTab.ts",
    shot: ".lmsa-settings-shell",
    html: settingsView(
      section(
        "Memory",
        "",
        `${settingItem("Enable memories", "Deliver the memory index with every request and offer the memory tools.", sw())}
        ${settingItem("Memory changes", "How the assistant's add and forget requests are handled. Deny removes both tools. The vault edit posture overrides this, as it does every other approval class.", `<select><option>Ask</option><option>Auto-apply</option><option>Deny</option></select>`)}
`,
        I.brain,
      ) +
        section(
          "Stored memories",
          "",
          memoryOffState(),
          I.bookOpen,
        ).replace(
          '<div class="lmsa-settings-section-footer"></div>',
          '<div class="lmsa-settings-section-footer"><button class="lmsa-btn-add lmsa-ui-btn lmsa-ui-btn-primary" disabled>Add memory</button></div>',
        ),
      720,
      "memories",
    ),
  },

  // S21b: settings Knowledge-graph tab (warning card + graph status with per-folder coverage).
  settingsKnowledgeGraph: {
    source: "src/settings/KnowledgeGraphTab.ts",
    shot: ".lmsa-settings-shell",
    html: settingsView(
      section(
        "Before you begin",
        "",
        `${settingItem("Compute", "Every note is sent to a completion model to find relationships and interconnect entities, then each entity is embedded. This is resource intensive on both compute and memory.", "")}
        ${settingItem("Large vaults", "Vaults with hundreds or thousands of notes will take considerably longer to process.", "")}
        ${settingItem("Cost", "Cloud providers charge per token. A full build can consume a meaningful amount of API credits.", "")}
        ${settingItem("Benefits", "Once built, the graph surfaces connections across notes that are hard to find manually, useful for world-building, story planning, and discovering narrative threads between characters, locations, and events.", "")}`,
        I.triangleAlert,
        "lmsa-kg-warning",
      ) +
        section(
          "Knowledge graph",
          "Use an LLM to extract entities and relationships from your vault, building a semantic knowledge graph that discovers connections across notes.",
          `${settingItem("Enable knowledge graph", "When enabled, the plugin can extract entities and relationships from your vault using a completion model.", sw("is-enabled"))}
          ${settingItem(
            "Completion model",
            "Generates structured entity and relationship data from your notes.",
            "",
            `<div class="lmsa-settings-model-selector-wrap">
              <div class="lmsa-settings-model-selector">
                <span class="lmsa-model-selector-status is-cloud"></span>
                <span class="lmsa-settings-model-selector-label">Claude Sonnet 4.5</span>
                <span class="lmsa-settings-model-selector-chevron">${I.chevronDown}</span>
              </div>
              <div class="lmsa-model-dropdown lmsa-hidden"></div>
            </div>`,
          )}
          ${settingItem(
            "Embedding model",
            "Encodes extracted entities as vectors for similarity search.",
            "",
            `<div class="lmsa-settings-model-selector-wrap">
              <div class="lmsa-settings-model-selector">
                <span class="lmsa-model-selector-status is-cloud"></span>
                <span class="lmsa-settings-model-selector-label">text-embedding-3-large</span>
                <span class="lmsa-settings-model-selector-chevron">${I.chevronDown}</span>
              </div>
              <div class="lmsa-model-dropdown lmsa-hidden"></div>
            </div>`,
          )}`,
          I.gitFork,
        ) +
        `<div class="lmsa-kg-conditional">${section(
          "Graph",
          "Manage the extracted knowledge graph.",
          `<div class="lmsa-index-status">
            <div class="lmsa-index-status-header">
              <div class="lmsa-index-status-info">
                <p class="lmsa-index-status-text">40 files processed. 312 entities, 580 relationships.</p>
                <p class="lmsa-index-drift-notice is-visible">3 files changed since the graph was built. Rebuild to refresh.</p>
              </div>
              <div class="lmsa-index-actions">
                <button class="lmsa-ui-btn lmsa-ui-btn-primary">Build graph</button>
                <button class="lmsa-ui-btn lmsa-ui-btn-secondary is-visible">Rebuild graph</button>
              </div>
            </div>
            <div class="lmsa-kg-folder-section">
              <div class="lmsa-kg-folder-row">
                <span class="lmsa-kg-folder-name">Characters</span>
                <div class="lmsa-kg-folder-bar"><div class="lmsa-kg-folder-bar-fill is-complete" style="width:100%"></div></div>
                <span class="lmsa-kg-folder-count">12 / 12</span>
                <div class="lmsa-kg-folder-action"></div>
              </div>
              <div class="lmsa-kg-folder-row">
                <span class="lmsa-kg-folder-name is-root">(root)</span>
                <div class="lmsa-kg-folder-bar"><div class="lmsa-kg-folder-bar-fill" style="width:40%"></div></div>
                <span class="lmsa-kg-folder-count">4 / 10</span>
                <div class="lmsa-kg-folder-action"><button class="lmsa-ui-btn lmsa-ui-btn-secondary lmsa-kg-folder-btn">Resume</button></div>
              </div>
              <div class="lmsa-kg-folder-row">
                <span class="lmsa-kg-folder-name">Locations</span>
                <div class="lmsa-kg-folder-bar"><div class="lmsa-kg-folder-bar-fill" style="width:60%"></div></div>
                <span class="lmsa-kg-folder-count">6 / 10</span>
                <div class="lmsa-kg-folder-action"><button class="lmsa-ui-btn lmsa-ui-btn-secondary lmsa-kg-folder-btn">Resume</button></div>
              </div>
            </div>
          </div>`,
          I.database,
        ) +
          section(
            "Filtering",
            "Control which files are included in graph extraction.",
            settingItem(
              "Exclude patterns",
              "Glob patterns for files to exclude from extraction (one per line).",
              `<textarea rows="4" placeholder="e.g. templates/**">Templates/**</textarea>`,
            ),
            I.filter,
          )}</div>`,
      720,
      "knowledge-graph",
    ),
  },

  // S26: settings navigation rail (SettingsTab.ts renderRail), isolated from the complete settings
  // shell used by every tab capture. Hover stays live-app: the harness is static.
  settingsRail: {
    source: "src/settings/SettingsTab.ts",
    w: 720,
    shot: ".lmsa-settings-rail",
    html: settingsView("", 720, "general"),
  },
};
