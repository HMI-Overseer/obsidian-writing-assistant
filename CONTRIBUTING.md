# Contributing

Thanks for your interest in contributing to Writing Assistant Chat. This document covers getting the project running locally, the codebase layout, and the standards I follow.

This is a creative writing tool with a local-first approach. If you want to contribute, please follow the [Obsidian plugin guidelines](https://docs.obsidian.md/Plugins/Releasing/Plugin+guidelines) and keep that philosophy in mind.

---

## Prerequisites

- [Node.js](https://nodejs.org) 18 or later
- npm (bundled with Node.js)
- [Obsidian](https://obsidian.md) desktop for manual testing
- At least one LLM provider for end-to-end testing (e.g. [LM Studio](https://lmstudio.ai) running locally)

---

## Setting up

```bash
git clone https://github.com/Resolve-public/obsidian-writing-assistant.git
cd obsidian-writing-assistant
npm install
```

Symlink or copy the project folder into your vault's plugin directory:

```
<your-vault>/.obsidian/plugins/writing-assistant-chat/
```

Then start the dev watcher:

```bash
npm run dev
```

Obsidian picks up the rebuilt `main.js` on plugin reload (**Ctrl/Cmd + P > Reload app without saving**).

---

## Scripts

| Command | Purpose |
|---------|---------|
| `npm run dev` | Watch mode — rebuilds on every file change |
| `npm run build` | Production build (no source maps, tree-shaken) |
| `npm run build:css` | Rebuild Tailwind styles only |
| `npm run lint` | Run ESLint across `src/` |
| `npm run lint:fix` | ESLint with auto-fixes |
| `npm test` | Run all tests (Vitest) |
| `npm run test:unit` | Unit tests only |
| `npm run test:integration` | Integration tests only |
| `npm run test:coverage` | Tests with coverage report |
| `npm run test:watch` | Watch mode for tests |

Before considering any work complete, run:

```bash
npm run lint && npm test
```

Both must pass clean.

---

## Project structure

```
src/
  main.ts            — Plugin entry point. Registers views, commands, settings.
  constants.ts       — View type, defaults, thresholds.
  utils.ts           — Root-level helpers.

  api/               — Provider-agnostic ChatClient interface + implementations.
  providers/         — Provider registry, descriptors, factory.
  chat/              — Chat UI, conversation logic, streaming, message rendering.
    actions/         — Send message orchestration, validation, API message prep.
    composer/        — Message input and command bar.
    conversation/    — Session store, conversation lifecycle.
    finalization/    — Post-stream save and auto-insert.
    messages/        — Message rendering, diff display.
    models/          — Model selector, profile controls.
    streaming/       — Streaming renderer.
    view/            — DOM layout, history drawer.
  editing/           — Diff engine, edit block parsing, apply logic.
  tools/             — Agentic tool definitions.
    vault/           — Read-only vault tools (read file, search, directory tree).
    editing/         — Write tools (propose edit, update frontmatter).
    formatters/      — Tool result formatting.
    think/           — Think/reasoning tool.
  rag/               — Retrieval-augmented generation.
    graph/           — Knowledge graph extraction and retrieval.
  context/           — Active note context extraction.
  commands/          — Prompt command definitions and registration.
  services/          — Shared services.
  settings/          — Settings tab UI, modals.
    benchmark/       — Provider benchmark tools.
    modals/          — Model profile and command modals.
  shared/            — Cross-module types (3+ consumers) and utilities.
  styles/            — Tailwind entry point + component styles.

tests/
  __mocks__/obsidian.ts   — Mock for the obsidian package.
  unit/                   — Pure logic tests (no side effects).
  integration/            — Tests involving multiple modules.
```

---

## Architecture

### Key abstractions

- **ChatClient** (`src/api/chatClient.ts`) — Provider-agnostic interface. Implement this to add a new provider.
- **ProviderDescriptor** (`src/providers/descriptors.ts`) — Declarative metadata per provider (supported params, auth type, billing model).
- **ChatView** (`src/chat/ChatView.ts`) — Main `ItemView`. Orchestrates layout, transcript, composer, model selector, history drawer.
- **ChatSessionStore** (`src/chat/conversation/ChatSessionStore.ts`) — Conversation state management and persistence.

### Adding a new provider

1. Create a client class implementing `ChatClient` in `src/api/`.
2. Add a `ProviderDescriptor` entry in `src/providers/descriptors.ts`.
3. Add the provider key to the `ProviderOption` union in `src/shared/types.ts`.
4. Handle in `createChatClient()` in `src/providers/registry.ts`.
5. Add migration logic in `main.ts` if needed.

### Settings persistence

Plugin data is stored via Obsidian's `loadData()` / `saveData()` API. `main.ts` includes normalization logic that handles missing or malformed fields on load. Chat state is persisted with a 300ms debounce on draft changes.

---

## Obsidian API rules

Follow the official [Obsidian plugin guidelines](https://docs.obsidian.md/Plugins/Releasing/Plugin+guidelines) and [developer policies](https://docs.obsidian.md/Developer+policies). The most common pitfalls:

### DOM

- **Never use `innerHTML`, `outerHTML`, or `insertAdjacentHTML`.** Use Obsidian DOM helpers: `createEl()`, `createDiv()`, `createSpan()`, `el.empty()`.
- No inline styles. Use CSS classes and Obsidian CSS variables.

### Resource management

- Use `this.registerEvent()`, `this.addCommand()`, `this.registerDomEvent()`, `this.registerInterval()` for automatic cleanup on plugin unload.
- Don't detach leaves in `onunload()` that you didn't create.

### Workspace

- Use `this.app` — never the global `app` reference.
- Get active view via `this.app.workspace.getActiveViewOfType(MarkdownView)`, not `workspace.activeLeaf`.
- Never store leaf/view references long-term.

### Files

- Active file edits: use the **Editor API** (preserves cursor, selection, folds).
- Background file edits: use **`Vault.process()`** (atomic, not `Vault.modify()`).
- Frontmatter: use **`FileManager.processFrontMatter()`**.
- Look up files with `vault.getFileByPath()`, not by iterating all files.
- User-supplied paths: always pass through `normalizePath()`.

### Commands

- Never assign default hotkeys.
- Use the right callback: `callback`, `checkCallback`, `editorCallback`, or `editorCheckCallback`.

---

## Testing

- Framework: **Vitest** with `obsidian` module mocked (`tests/__mocks__/obsidian.ts`).
- Test files mirror source: `tests/unit/<module>/<name>.test.ts`.
- Environment: Node (not jsdom). Extract pure logic from UI for testability.
- No globals — import `describe`, `it`, `expect` from `vitest`.

---

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
