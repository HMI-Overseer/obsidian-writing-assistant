# Writing Assistant Chat

AI writing assistant for [Obsidian](https://obsidian.md) with a unified chat and editing surface. Connects to local or cloud LLM providers. Features vault-wide RAG retrieval, knowledge graph, agentic tool use, note context, and reusable prompt commands.

Desktop only.

---

## Features

### One conversation, two ways to work

- **Ask before edits**, The default. Write operations follow the per-operation policy in settings, which
  normally asks you to review changes before they are applied.
- **Edit automatically**, Applies proposed changes without per-operation review. Use it for trusted
  sessions where hands-off editing is intentional.

### Multi-provider support

Connect to one or more LLM providers:

- **LM Studio**, Local inference via OpenAI-compatible API. No cloud, no API keys, no data leaving your machine.
- **Anthropic**, Claude models with native API support and prompt caching.
- **OpenAI**, GPT models via the OpenAI API (or any OpenAI-compatible endpoint).
- **Claude Code**, Anthropic's agent harness via the local `claude` CLI. Runs its own tool loop over the vault toolstack and uses your existing Claude Code login, so no API key is needed.

Switch between providers and model profiles from the chat panel.

### Agentic tool use

When enabled, the model can use tools across multiple reasoning rounds.

Every operation that changes your vault is routed through an approval gateway. By default each kind (create, overwrite, move, trash, create folder, in-document edit) is set to **Ask**, so nothing is applied without your review. In settings you can set any kind to **Auto-apply** or **Deny** (the tool is removed entirely so the model is never offered it).

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

- [Obsidian](https://obsidian.md) v1.0.0 or later (desktop only; tested on recent 1.12.x releases)
- At least one LLM provider:
  - **LM Studio**, [lmstudio.ai](https://lmstudio.ai), running locally with at least one model loaded
  - **Anthropic**, An API key from [console.anthropic.com](https://console.anthropic.com)
  - **OpenAI**, An API key from [platform.openai.com](https://platform.openai.com)
  - **Claude Code**, The [Claude Code](https://claude.com/claude-code) CLI installed and signed in (no API key needed, will use your existing Subscription)

---

## Installation

### From community plugins

1. Open **Settings > Community plugins > Browse**
2. Search for **Writing Assistant Chat**
3. Click **Install**, then **Enable**

### Beta via BRAT

1. Install the [BRAT plugin](https://github.com/TfTHacker/obsidian42-brat) from community plugins
2. Open **Settings > BRAT > Add Beta plugin**
3. Enter `Resolve-public/writing-assistant-chat` and click **Add Plugin**
4. Enable **Writing Assistant Chat** in **Settings > Community plugins**

---

## Getting started

1. Open **Settings > Writing Assistant Chat**
2. Choose a provider and configure it:
   - **LM Studio**, Start the local server (default `http://localhost:1234`) and the plugin will discover loaded models
   - **Anthropic / OpenAI**, Enter your API key
   - **Claude Code**, Make sure the `claude` CLI is installed and signed in (set its path only if it isn't on your `PATH`)
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
| Claude Code | Local `claude` CLI, which calls Anthropic | Agentic chat (the CLI runs its own tool loop) |

When using **Local providers** exclusively, **no data leaves your machine**.

### Data handling

- **API keys** are stored locally in Obsidian's plugin data file and are only sent to their respective provider.
- **Conversations**, **RAG embeddings**, and **knowledge graph data** are stored locally on your device.
- **No telemetry, analytics, or tracking.** The plugin makes no network requests beyond what is required to communicate with your chosen provider.
- **No account required.** LM Studio needs no account; Anthropic and OpenAI require their own API accounts.
- **Cloud usage is billed to you.** The plugin is free. When you use a cloud provider, Anthropic and OpenAI charge metered usage against your own API key (this includes OpenAI embeddings if you select an OpenAI embedding model for RAG), and Claude Code draws on your existing Claude subscription. Local providers such as LM Studio are free to run.

### External tools and files outside your vault

The **Claude Code** provider is the only part of the plugin that reaches outside your vault:

- **It launches an external program.** When you use this provider, the plugin runs the `claude` command-line tool as a subprocess, with its working directory set to your vault. To find the executable it searches the directories on your system `PATH`, and on Windows it reads the npm shim files (`claude.cmd` / `claude.bat`) to resolve the real program. It only ever runs a `claude` binary that you have already installed; it never downloads, installs, or updates one.
- **The CLI keeps its own files outside the vault.** The `claude` tool stores its login, configuration, and per-conversation session files in its own home-directory folder (`~/.claude`), outside your Obsidian vault. The plugin relies on these to resume a conversation after a restart. These files are created and managed by the Claude Code CLI itself.

Every other tool the plugin offers the model (read, edit, create, move, trash) is path-restricted to your vault.

---

## Support

This plugin and all of its features are, and will always be, free. If it helped you get closer to achieving your creative goals, you can support this project in the following ways:

- [Buy Me a Coffee](https://buymeacoffee.com/resolvepublic)

You can also find these links in **Settings > Writing Assistant Chat > General**.

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup instructions, project structure, coding standards, and the development workflow.

---

## License

MIT, see [LICENSE](LICENSE) for details.

The distributed build bundles third-party components under their own licenses,
including one proprietary Anthropic component that is not covered by this
plugin's MIT license. See [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) for
the full list and terms.
