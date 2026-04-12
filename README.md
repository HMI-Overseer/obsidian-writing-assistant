# Writing Assistant Chat

AI writing assistant for [Obsidian](https://obsidian.md) with chat, plan, and edit modes. Connects to local or cloud LLM providers. Features vault-wide RAG retrieval, knowledge graph, agentic tool use, note context, and reusable prompt commands.

Desktop only.

---

## Features

### Three operating modes

- **Conversation** — Back-and-forth chat with your chosen model in a persistent side panel.
- **Plan** — Outline and brainstorm with tool use support for vault-aware planning.
- **Edit** — Targeted document editing with diff preview and human review before applying changes.

### Multi-provider support

Connect to one or more LLM providers:

- **LM Studio** — Local inference via OpenAI-compatible API. No cloud, no API keys, no data leaving your machine.
- **Anthropic** — Claude models with native API support and prompt caching.
- **OpenAI** — GPT models via the OpenAI API (or any OpenAI-compatible endpoint).

Switch between providers and model profiles from the chat panel.

### Agentic tool use

When enabled, the model can use tools across multiple reasoning rounds:

- **Read file** — Retrieve full content of notes in your vault.
- **List directory / Directory tree** — Explore vault structure.
- **Search files** — Glob-based file searching.
- **Semantic search** — RAG-powered vault retrieval.
- **Propose edit** — Search-and-replace proposals for prose edits with diff review. This tool will never edit your documents without your explicit consent.
- **Update frontmatter** — YAML frontmatter management.

All vault tools are read-only by default. Edit proposals require explicit approval before applying.

### Vault-wide retrieval (RAG)

Semantic search over your entire vault using local or cloud embeddings. Configurable chunk size, overlap, similarity threshold, and metadata enrichment (tags, folder paths, wikilinks).

### Knowledge graph

LLM-powered entity and relationship extraction from your vault. Enables entity-based retrieval and graph-aware ranking of search results.

### Note context

The active note is automatically available to conversations, so the model writes with awareness of your current document. Configurable context size.

### Prompt commands

Reusable prompt templates (e.g. "Tighten dialogue", "Expand this scene") that appear as buttons in the chat panel and in the editor right-click context menu. Supports `{{selection}}` and `{{noteText}}` placeholders.

### Streaming and message management

- Real-time streaming responses.
- Message version history with regeneration.
- Token usage tracking and cost estimation.
- Inline message editing.
- Chat history with conversation switching.
- Draft auto-save.

### Model profiles

Save multiple configurations per provider, each with its own system prompt, temperature, max tokens, top-p, top-k, and reasoning level. Switch profiles from the chat panel.

---

## Requirements

- [Obsidian](https://obsidian.md) v1.12.7 or later (desktop only)
- At least one LLM provider:
  - **LM Studio** — [lmstudio.ai](https://lmstudio.ai), running locally with at least one model loaded
  - **Anthropic** — An API key from [console.anthropic.com](https://console.anthropic.com)
  - **OpenAI** — An API key from [platform.openai.com](https://platform.openai.com)

---

## Installation

### From community plugins

1. Open **Settings > Community plugins > Browse**
2. Search for **Writing Assistant Chat**
3. Click **Install**, then **Enable**

### Beta via BRAT

1. Install the [BRAT plugin](https://github.com/TfTHacker/obsidian42-brat) from community plugins
2. Open **Settings > BRAT > Add Beta plugin**
3. Enter `Resolve-public/obsidian-writing-assistant` and click **Add Plugin**
4. Enable **Writing Assistant Chat** in **Settings > Community plugins**

### Manual

1. Clone or download this repository
2. Run `npm install && npm run build`
3. Copy `main.js`, `manifest.json`, and `styles.css` into:
   ```
   <your-vault>/.obsidian/plugins/writing-assistant-chat/
   ```
4. In Obsidian: **Settings > Community plugins > Reload plugins**, then enable **Writing Assistant Chat**

---

## Getting started

1. Open **Settings > Writing Assistant Chat**
2. Choose a provider and configure it:
   - **LM Studio** — Start the local server (default `http://localhost:1234`) and the plugin will discover loaded models
   - **Anthropic / OpenAI** — Enter your API key
3. Add a model profile with your preferred system prompt, temperature, and token limit
4. Click the chat icon in the ribbon, or run the command **Open writing assistant chat**
5. Start writing

---

## Network and privacy

### Remote services

When using **cloud providers**, the plugin sends your messages (and any note context you include) to the provider's API:

| Provider | Endpoint | Purpose |
|----------|----------|---------|
| Anthropic | `api.anthropic.com` | Chat completions |
| OpenAI | `api.openai.com` (or custom base URL) | Chat completions, embeddings |
| LM Studio | `localhost` (configurable) | Chat completions, embeddings, model discovery |

When using **Local providers** exclusively, **no data leaves your machine**.

### Data handling

- **API keys** are stored locally in Obsidian's plugin data file and are only sent to their respective provider.
- **Conversations**, **RAG embeddings**, and **knowledge graph data** are stored locally on your device.
- **No telemetry, analytics, or tracking.** The plugin makes no network requests beyond what is required to communicate with your chosen provider.
- **No account required.** LM Studio needs no account; Anthropic and OpenAI require their own API accounts.

### Vault access

The plugin reads files in your vault to provide note context, RAG retrieval, and knowledge graph features. It can propose edits to notes in edit mode, but all changes require your explicit approval before being applied.

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup instructions, project structure, coding standards, and the development workflow.

---

## License

MIT — see [LICENSE](LICENSE) for details.
