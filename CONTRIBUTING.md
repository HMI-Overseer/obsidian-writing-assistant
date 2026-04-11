# Contributing

Thanks for your interest in contributing to Writing Assistant Chat. This document covers everything you need to get the project running locally and working on it effectively.

---

## Prerequisites

- [Node.js](https://nodejs.org) 18 or later
- npm (bundled with Node.js)
- [LM Studio](https://lmstudio.ai) for manual testing

---

## Setting Up

```bash
git clone https://github.com/HMI-Overseer/writing-assistant-chat.git
cd writing-assistant-chat
npm install
```

To see changes live inside Obsidian, symlink (or copy) the project folder into your vault's plugin directory:

```
<your-vault>/.obsidian/plugins/writing-assistant-chat/
```

Then run the dev watcher:

```bash
npm run dev
```

Obsidian will pick up the rebuilt `main.js` automatically when you reload the plugin (**Ctrl/Cmd + P → Reload app without saving**).

---

## Scripts

| Command | What it does |
|---------|-------------|
| `npm run dev` | Watch mode — rebuilds `main.js` on every file change |
| `npm run build` | Production build (no source maps, tree-shaken) |
| `npm run lint` | Run ESLint across `src/` |
| `npm run lint:fix` | Run ESLint and apply auto-fixes |
| `npm run format` | Run Prettier and write changes |
| `npm run format:check` | Run Prettier in check mode (no writes) — useful in CI |

Before committing, run:

```bash
npm run format && npm run lint && npm run build
```

All three must pass clean.

---

## Project Structure

```
src/
├── main.ts                                # Plugin entry point — registers views, commands, settings tab
├── constants.ts                           # Plugin-wide defaults and VIEW_TYPE_CHAT
├── utils.ts                               # Shared utilities (ID generation, model resolution)
├── shared/
│   └── types.ts                           # Cross-cutting domain types (Message, PluginSettings, etc.)
├── api/
│   ├── index.ts                           # Barrel export
│   ├── types.ts                           # LM Studio API types (LMStudioModel, LMStudioModelDigest, etc.)
│   ├── parsing.ts                         # Generic JSON parsing utilities
│   ├── urlResolution.ts                   # URL normalization and resolution
│   ├── modelNormalization.ts              # Model data normalization (native + OpenAI formats)
│   ├── httpTransport.ts                   # HTTP request layer (Node.js + fetch dual transport)
│   ├── streamingTransport.ts              # SSE streaming generators
│   ├── LMStudioClient.ts                  # Thin orchestrator composing the above modules
│   └── LMStudioModelsService.ts           # Model discovery with caching
├── chat/
│   ├── index.ts                           # Barrel export
│   ├── types.ts                           # Chat UI types (BubbleRefs, ChatLayoutRefs, etc.)
│   ├── ChatView.ts                        # Main chat view (Obsidian ItemView) — slim coordinator
│   ├── ChatGenerationController.ts        # Generation state (isGenerating, abort)
│   ├── ChatConversationController.ts      # Conversation lifecycle (new, switch, delete, history)
│   ├── actions/
│   │   ├── sendMessage.ts                 # Send message orchestrator
│   │   ├── validateSendRequest.ts         # Pre-send validation
│   │   ├── prepareApiMessages.ts          # API message array builder
│   │   ├── StreamingRenderer.ts           # Debounced markdown render queue
│   │   └── finalizeResponse.ts            # Post-stream save + auto-insert
│   ├── composer/
│   │   └── ChatComposer.ts               # Message input and command bar
│   ├── conversation/
│   │   ├── ChatSessionStore.ts            # Chat state management + persistence
│   │   └── conversationUtils.ts           # Conversation helpers (title gen, normalization)
│   ├── messages/
│   │   └── ChatTranscript.ts              # Message rendering with markdown
│   ├── models/
│   │   └── ChatModelSelector.ts           # Model dropdown selector
│   └── view/
│       ├── createChatLayout.ts            # DOM layout builder
│       └── ChatHistoryDrawer.ts           # Conversation history sidebar
├── context/
│   └── noteContext.ts                     # Reads active note text from the vault
└── settings/
    ├── SettingsTab.ts                     # Tab router (Obsidian PluginSettingTab)
    ├── ModelProfileTab.ts                 # Generic model profile tab renderer
    ├── GeneralTab.ts
    ├── CompletionModelsTab.ts             # Config wrapper for completion profiles
    ├── EmbeddingModelsTab.ts              # Config wrapper for embedding profiles
    ├── CommandsTab.ts
    ├── AdvancedTab.ts
    ├── ui.ts                              # Settings section builder
    └── modals/
        ├── index.ts                       # Barrel export
        ├── ModelProfileModal.ts           # Abstract base modal for model profiles
        ├── CompletionModelModal.ts        # Completion-specific fields
        ├── EmbeddingModelModal.ts         # Embedding-specific (no extra fields)
        └── CommandModal.ts
```

### Key rules

- `shared/types.ts` holds **cross-cutting interfaces only** — types used by 3+ modules
- `api/types.ts` holds **LM Studio API types** — used by api/ and settings/
- `chat/types.ts` holds **chat UI types** — used only within chat/
- Constants and default values live in `constants.ts`
- Utility functions live in `utils.ts`
- Each class gets its own file
- Each folder exposes a barrel `index.ts` for clean external imports
- New modals go in `src/settings/modals/`

---

## Coding Standards

See `CLAUDE.md` at the project root for the full coding standards document.

### TypeScript

- `strict: true` is enabled — no implicit `any`, strict null checks, etc.
- Use `import type` for type-only imports (enforced by ESLint)
- Prefer `const` over `let`; never use `var`

### ESLint + Prettier

The project enforces:

- `@typescript-eslint/consistent-type-imports` — type-only imports must use `import type`
- `@typescript-eslint/no-unused-vars` — unused variables are errors
- `eqeqeq` — always use `===`
- `no-console` — warns on `console.*` calls

Prettier settings: 100-char print width, double quotes, trailing commas (`es5`), 2-space indent.

### CSS

All CSS classes use the `lmsa-*` prefix. Styles are organized as co-located CSS files with each component, aggregated via `src/styles/index.css`. Use Obsidian's CSS variables (`--text-normal`, `--background-primary`, etc.) rather than hard-coded colours wherever possible.

---

## Architecture Notes

### API layer (`src/api/`)

The API layer is split into focused modules:

- **`parsing.ts`** — Generic JSON parsing utilities for safe data extraction
- **`urlResolution.ts`** — Handles LM Studio URL normalization (strips known suffixes, resolves base URLs)
- **`httpTransport.ts`** — Dual HTTP transport: Node.js (`http`/`https` via Electron, bypasses CORS) and fetch (fallback)
- **`streamingTransport.ts`** — SSE streaming via `AsyncGenerator` in both Node.js and fetch modes
- **`modelNormalization.ts`** — Normalizes model data from both native and OpenAI-compatible LM Studio endpoints
- **`LMStudioClient.ts`** — Thin orchestrator composing the above. Public API: `listModels()`, `stream()`, `complete()`

### Settings deduplication

The Completion and Embedding model tabs share a generic `ModelProfileTab` renderer configured via a `ModelProfileTabConfig` object. Similarly, `ModelProfileModal` is an abstract base class — subclasses only override `renderExtraFields()` and `createDefaultModel()`.

### Settings persistence

Plugin data is stored via Obsidian's `loadData()` / `saveData()` API (a JSON file in the vault). `main.ts` includes normalization logic that safely handles missing or malformed fields when loading settings.

### Chat state

The current conversation and draft are persisted to plugin settings on every change (with a 300ms debounce on the draft). `ChatSessionStore` owns all state management and persistence logic. `ChatView` delegates to `ChatGenerationController` (generation state) and `ChatConversationController` (conversation lifecycle) for cleaner separation of concerns.
