# Contributing

Thanks for your interest in contributing to Writing Assistant Chat. This document covers getting the project running locally, the codebase layout, and the standards I follow.

This is a creative writing tool with a local-first approach. Beyond chat, it offers plan and edit modes, vault-wide RAG retrieval, a knowledge graph, agentic tool use, note context, and reusable prompt commands. If you want to contribute, please follow the [Obsidian plugin guidelines](https://docs.obsidian.md/Plugins/Releasing/Plugin+guidelines) and keep that philosophy in mind.

---

## Prerequisites

- [Node.js](https://nodejs.org) 20 or later (the test runner requires it)
- npm (bundled with Node.js)
- [Obsidian](https://obsidian.md) desktop for manual testing (this is a desktop-only plugin)
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
| `npm run dev` | Watch mode, rebuilds on every file change |
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
  main.ts, Plugin entry point. Registers views, commands, settings.
  constants.ts, View type, defaults, thresholds.
  utils.ts, Root-level helpers.

  api/, Provider-agnostic ChatClient interface + implementations.
    sdk/, Claude Agent SDK integration (query engine, MCP bridge, session registry).
  providers/, Provider registry, descriptors, factory.
  chat/, Chat UI, conversation logic, streaming, message rendering.
    actions/, Send message orchestration, validation, API message prep.
    composer/, Message input, command bar, context picker.
    conversation/, Session store, conversation lifecycle, persistence.
    finalization/, Post-stream save and auto-insert.
    messages/, Message rendering, diff display, bubble actions.
    models/, Model selector, profile controls.
    rendering/, Markdown bubble renderers.
    streaming/, Streaming renderer.
    view/, DOM layout, history drawer.
  editing/, Diff engine, edit block parsing, apply logic.
    inlineDiff/, In-document inline diff rendering.
  tools/, Agentic tool definitions and registry.
    vault/, Read-only vault tools (read file, search, directory tree).
    editing/, In-document edit tools (propose edit, update frontmatter).
    vault-ops/, Vault operation tools (create, overwrite, move, trash, mkdir).
    formatters/, Provider-specific tool result formatting.
    think/, Think/reasoning tool.
  vault-ops/, Approval gateway, gate resolution, apply plan, path safety.
  mcp/, In-process MCP server exposing the toolstack to Claude Code.
  rag/, Retrieval-augmented generation (embeddings, indexer, retriever).
    graph/, Knowledge graph extraction and retrieval.
  context/, Active note context extraction.
  commands/, Prompt command definitions and registration.
  services/, ServiceContainer and runtime services (Claude Code, RAG, graph, storage).
  settings/, Settings tab UI, modals.
    benchmark/, Provider benchmark tools.
    modals/, Model profile, API keys, and command modals.
  shared/, Cross-module types (3+ consumers) and utilities.
  styles/, Tailwind entry point + component styles.

tests/
  __mocks__/obsidian.ts, Mock for the obsidian package.
  unit/, Pure logic tests (no side effects).
  integration/, Tests involving multiple modules.
```

---

## Architecture

### Key abstractions

- **ChatClient** (`src/api/chatClient.ts`), Provider-agnostic interface. Implement this to add a new provider.
- **ProviderDescriptor** (`src/providers/descriptors.ts`), Declarative metadata per provider (supported params, auth type, billing model). The current providers are LM Studio, Anthropic, OpenAI, and Claude Code.
- **ChatView** (`src/chat/ChatView.ts`), Main `ItemView`. Orchestrates layout, transcript, composer, model selector, history drawer.
- **ChatSessionStore** (`src/chat/conversation/ChatSessionStore.ts`), Conversation state management and persistence.
- **ServiceContainer** (`src/services/ServiceContainer.ts`), Owns construction and lifecycle of runtime services (conversation storage, model availability, RAG, knowledge graph, Claude Code). Created once in `onload()` and passed to consumers.

### Adding a new provider

1. Create a client class implementing `ChatClient` in `src/api/`.
2. Add a `ProviderDescriptor` entry in `src/providers/descriptors.ts`.
3. Add the provider key to the `ProviderOption` union in `src/shared/types.ts`.
4. Handle in `createChatClient()` in `src/providers/registry.ts`.
5. Add migration logic in `main.ts` if needed.

### Agentic tools and the Claude Code provider

The plugin exposes a canonical toolstack (read-only vault tools, in-document edit tools, and vault-operation tools) to tool-capable providers. The toolstack is grouped under `src/tools/` and assembled through the tool registry.

The Claude Code provider is different: it runs its own agent harness, so it does not receive tools via `request.tools`. Instead, the plugin stands up an in-process MCP server (`src/mcp/VaultMcpServer.ts`) that exposes the same toolstack to the Claude Code subprocess over loopback HTTP, guarded by a per-session bearer token.

### Vault writes and the approval gateway

Any tool that mutates the vault (create, overwrite, move, trash, mkdir, and in-document edits) is routed through the approval gateway in `src/vault-ops/`. `resolveGate` is a pure, total predicate: every operation resolves to `deny`, `ask`, or `auto`, with scope and budget limits as defense-in-depth behind any `auto` choice. Path-boundary safety (operations must never escape the vault) is enforced here. This design is recorded in ADR-0003; see the ADR convention below.

### Settings persistence

Plugin data is stored via Obsidian's `loadData()` / `saveData()` API. `main.ts` includes normalization logic that handles missing or malformed fields on load. Chat state is persisted with a 300ms debounce on draft changes.

---

## Decision records (ADRs)

Architectural decisions are recorded as ADRs in `docs/reference/adr/`. When you make a decision with lasting structural impact, add a numbered ADR there and reference it as `ADR-NNNN` from code and docs. Existing records cover the second write-proposal channel, the annotation-driven approval gateway, the single write-file tool, trash-only deletion, and the unified dependency-ordered apply plan. See `docs/reference/adr/README.md` for the convention.

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

- Use `this.app`, never the global `app` reference.
- Get active view via `this.app.workspace.getActiveViewOfType(MarkdownView)`, not `workspace.activeLeaf`.
- Never store leaf/view references long-term.

### Files

- Active file edits: use the **Editor API** (preserves cursor, selection, folds).
- Background file edits: use **`Vault.process()`** (atomic, not `Vault.modify()`).
- Frontmatter: use **`FileManager.processFrontMatter()`**.
- Look up files with `vault.getFileByPath()`, not by iterating all files.
- User-supplied paths: always pass through `normalizePath()`, and never let an operation escape the vault.

### Commands

- Never assign default hotkeys.
- Use the right callback: `callback`, `checkCallback`, `editorCallback`, or `editorCheckCallback`.

---

## Testing

- Framework: **Vitest** with `obsidian` module mocked (`tests/__mocks__/obsidian.ts`).
- Test files mirror source: `tests/unit/<module>/<name>.test.ts`.
- Environment: Node (not jsdom). Extract pure logic from UI for testability.
- No globals, import `describe`, `it`, `expect` from `vitest`.
- Prove new tests are non-vacuous: watch them fail against broken code before trusting the green.

---

## Releasing

Releases are automated via GitHub Actions. When you push a tag, the workflow builds the plugin and creates a draft release with `main.js`, `manifest.json`, and `styles.css` attached.

### Version bump and release

```bash
npm version patch    # or minor, or major
git push origin main --tags
```

`npm version` automatically:

1. Bumps `package.json`
2. Syncs the version into `manifest.json` and `versions.json` (via `version-bump.mjs`)
3. Commits and creates a git tag

After pushing, go to **Releases** on GitHub, review the draft, and publish it.

### Versioning

- Follow [semantic versioning](https://semver.org): `patch` for fixes, `minor` for features, `major` for breaking changes.
- `manifest.json`, `package.json`, and git tags must always match. The `version` script handles this, never bump versions manually.

---

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
