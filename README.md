# LM Studio Writing Assistant

An [Obsidian](https://obsidian.md) plugin that brings a local AI writing assistant into your vault. It connects directly to a running [LM Studio](https://lmstudio.ai) instance over its OpenAI-compatible API — no cloud, no API keys, no data leaving your machine.

---

## Features

- **Chat panel** — A persistent side panel for back-and-forth conversation with your chosen model
- **Streaming responses** — Tokens appear in real time as the model generates them
- **Note context** — Optionally feed the active note into the system prompt so the model writes in the right voice and style
- **Insert into note** — Send the last response back into your note with one click; replaces selected text or appends at the cursor
- **Quick commands** — Configurable prompt templates (e.g. "Tighten dialogue", "Expand this scene") that appear as buttons in the chat panel and support `{{selection}}` and `{{note}}` placeholders
- **Model profiles** — Save multiple completion model configurations, each with its own system prompt, temperature, and token limit, and switch between them from the settings
- **CORS-free by default** — Uses Electron's Node.js HTTP stack to talk to LM Studio, so you don't need to enable CORS in LM Studio's settings
- **Fully offline** — All inference runs locally via LM Studio; Obsidian never contacts the internet

---

## Requirements

- [Obsidian](https://obsidian.md) 1.0.0 or later (desktop only)
- [LM Studio](https://lmstudio.ai) running locally with at least one model loaded
- The LM Studio local server started (default: `http://localhost:1234`)

---

## Installation

### Manual (development build)

1. Clone or download this repository
2. Run `npm install` to install dependencies
3. Run `npm run build` to compile
4. Copy `main.js`, `manifest.json`, and `styles.css` into your vault's plugins folder:
   ```
   <your-vault>/.obsidian/plugins/lm-studio-writing-assistant/
   ```
5. In Obsidian: **Settings → Community plugins → Reload plugins**, then enable **LM Studio Writing Assistant**

---

## Getting Started

1. Start LM Studio and load a model
2. Start the local server in LM Studio (default port 1234)
3. Open Obsidian and enable the plugin
4. Open **Settings → LM Studio Writing Assistant → Completion Models** and add a model profile:
   - Set the **Model ID** to match what LM Studio shows (the plugin will suggest loaded models if LM Studio is running)
   - Adjust the system prompt, temperature, and max tokens to taste
5. Click the **message square** icon in the ribbon, or run the command **Open LM Studio Chat**
6. Start writing

---

## Configuration

All settings are in **Settings → LM Studio Writing Assistant**.

---

## Development

### Prerequisites

- Node.js 18+
- npm

### Scripts

```bash
npm install          # install dependencies
npm run dev          # watch mode — rebuilds on file changes
npm run build        # production build
npm run lint         # ESLint
npm run lint:fix     # ESLint with auto-fix
npm run format       # Prettier (writes files)
npm run format:check # Prettier (check only, no writes)
```

### Project Structure

```
src/
├── main.ts                        # Plugin entry point — registers views, commands, settings tab
├── constants.ts                   # Plugin-wide defaults and the VIEW_TYPE_CHAT constant
├── utils.ts                       # Shared utility functions (ID generation, model resolution)
├── shared/
│   └── types.ts                   # TypeScript interfaces (Message, PluginSettings, etc.)
├── api/
│   ├── LMStudioClient.ts          # HTTP client — supports Node.js and fetch transports, streaming
│   └── index.ts
├── chat/
│   ├── ChatView.ts                # Main chat UI (Obsidian ItemView)
│   ├── chatState.ts               # State normalisation and hydration helpers
│   └── index.ts
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
        └── index.ts
```

### Coding Standards

- **TypeScript** with `strict: true`
- **ESLint** (`npm run lint`) — enforces `consistent-type-imports`, no unused vars, `eqeqeq`
- **Prettier** (`npm run format`) — 100-char line width, double quotes, trailing commas
- CSS class prefix: `lmsa-*`
- One class per file; barrel `index.ts` exports per folder

---

## Embedding Models

The **Embedding Models** tab is reserved for a future semantic search and retrieval feature. Adding embedding model profiles now will make migration seamless when that feature ships.

---

## License

MIT — see [LICENSE](LICENSE) for details.
