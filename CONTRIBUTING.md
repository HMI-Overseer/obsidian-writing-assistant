# Contributing

Thanks for your interest in contributing to the LM Studio Writing Assistant. This document covers everything you need to get the project running locally and working on it effectively.

---

## Prerequisites

- [Node.js](https://nodejs.org) 18 or later
- npm (bundled with Node.js)
- [LM Studio](https://lmstudio.ai) for manual testing

---

## Setting Up

```bash
git clone https://github.com/HMI-Overseer/local-obsidian-writing-assistant.git
cd local-obsidian-writing-assistant
npm install
```

To see changes live inside Obsidian, symlink (or copy) the project folder into your vault's plugin directory:

```
<your-vault>/.obsidian/plugins/lm-studio-writing-assistant/
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
├── main.ts                        # Plugin entry point — registers views, commands, settings tab
├── constants.ts                   # Plugin-wide defaults and the VIEW_TYPE_CHAT constant
├── utils.ts                       # Shared utility functions (ID generation, model resolution)
├── shared/
│   └── types.ts                   # TypeScript interfaces only (Message, PluginSettings, etc.)
├── api/
│   ├── LMStudioClient.ts          # HTTP client — Node.js and fetch transports, streaming via SSE
│   └── index.ts                   # Barrel export
├── chat/
│   ├── ChatView.ts                # Main chat UI (Obsidian ItemView)
│   ├── chatState.ts               # State normalisation and hydration helpers
│   └── index.ts                   # Barrel export
├── context/
│   └── noteContext.ts             # Reads active note text from the vault
└── settings/
    ├── SettingsTab.ts             # Tab router (Obsidian PluginSettingTab)
    ├── GeneralTab.ts
    ├── CompletionModelsTab.ts
    ├── EmbeddingModelsTab.ts
    ├── CommandsTab.ts
    ├── AdvancedTab.ts
    └── modals/
        ├── CompletionModelModal.ts
        ├── EmbeddingModelModal.ts
        ├── CommandModal.ts
        └── index.ts               # Barrel export
```

### Key rules

- `shared/types.ts` holds **interfaces only** — no functions, no constants
- Constants and default values live in `constants.ts`
- Utility functions live in `utils.ts`
- Each class gets its own file
- Each folder exposes a barrel `index.ts` for clean external imports
- New modals go in `src/settings/modals/`

---

## Coding Standards

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

All CSS classes use the `lmsa-*` prefix. Styles live in `styles.css` at the project root. Use Obsidian's CSS variables (`--text-normal`, `--background-primary`, etc.) rather than hard-coded colours wherever possible.

---

## Architecture Notes

### Dual transport in `LMStudioClient`

The client supports two HTTP transports:

- **Node.js** (`http`/`https` modules via Electron) — default, bypasses CORS entirely
- **Fetch** — fallback for environments where Node.js modules are unavailable

The `bypassCors` setting in plugin settings controls which is used. Streaming is implemented as an `AsyncGenerator` over SSE in both transports.

### Settings persistence

Plugin data is stored via Obsidian's `loadData()` / `saveData()` API (a JSON file in the vault). `main.ts` includes a legacy migration path that converts old single-model settings into the current multi-model array format — keep this in mind when changing the `PluginSettings` interface.

### Chat state

The current conversation and draft are persisted to plugin settings on every change (with a 300ms debounce on the draft). `chatState.ts` owns all normalisation logic for loading and saving this state safely.
