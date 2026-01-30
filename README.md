# Obsidian Sonar

**Deep knowledge retrieval for Obsidian, completely offline.**

Like sonar detecting hidden objects beneath the surface, Sonar discovers
meaningful connections across your notes through semantic search and AI-powered
chat. Index markdown, PDF, and audio files, then explore your knowledge base via
direct search or interactive conversations — all running locally on your device
with [llama.cpp](https://github.com/ggerganov/llama.cpp).

## Features

Core features run entirely on your device — no cloud services, no data leaving
your machine.

- [**Automatic indexing**](#automatic-indexing): Index your vault automatically
  as you create and edit notes, with support for markdown, PDF, and audio files
  (via transcription)
- [**Semantic note finder**](#semantic-note-finder): Find notes by meaning, not
  just keywords — powered by hybrid search and cross-encoder reranking for high
  accuracy
- [**Related notes view**](#related-notes-view): Automatically discover
  connections to your current note, with optional knowledge graph visualization
- [**Agentic assistant chat**](#agentic-assistant-chat): Have conversations with
  an assistant grounded in your knowledge base — supports tool use including
  vault search, note editing, and web search, with extensibility through custom
  tools

## Installation

Before installing, ensure you have:

- 32GB+ RAM recommended[^1]
- GPU recommended (Metal on macOS, CUDA on Linux/Windows)[^2]
- Node.js 18+

[^1]:
    The default models (BGE-M3 for embeddings, Qwen3-8B for chat) require
    substantial memory. You can configure smaller models in settings to run on
    machines with less RAM.

[^2]:
    GPU acceleration significantly improves performance for both indexing
    (embedding generation) and agentic chat (LLM inference). Without a GPU,
    these operations will be noticeably slower.

### 1. Install llama.cpp

```bash
# macOS (Homebrew)
brew install llama.cpp

# Windows (winget)
winget install llama.cpp
```

On Linux, download prebuilt binaries from the
[releases page](https://github.com/ggerganov/llama.cpp/releases) or build from
source:

```bash
# Linux (build from source)
sudo apt install git cmake build-essential libcurl4-openssl-dev
git clone https://github.com/ggerganov/llama.cpp
cd llama.cpp
cmake -B build
cmake --build build --config Release
# Binaries are in ./build/bin/
```

### 2. Install the plugin

```bash
git clone https://github.com/aviatesk/obsidian-sonar.git
cd obsidian-sonar
npm install
npm run build
cp main.js manifest.json styles.css /path/to/your/vault/.obsidian/plugins/obsidian-sonar/
```

### 3. Enable the plugin

1. Open Obsidian and go to **Settings → Community plugins**
2. Enable **Sonar** from your installed plugins list
3. Open **Settings → Sonar** and configure **Server path**:
   - Use `llama-server` if installed via Homebrew or winget (resolved
     automatically)
   - Or run `which llama-server` (macOS/Linux) or `where llama-server` (Windows)
     to find the absolute path
4. On first launch, you will be asked to permit downloading the required models
   (a confirmation dialog appears for each model)

## Feature guide

### Automatic indexing

<!-- TODO: Screenshot of indexing progress in status bar -->

Sonar automatically indexes your vault in the background. When you create or
edit notes, they are re-indexed to keep search results up to date.

Files are split into chunks and converted to vector embeddings, which are stored
locally in an IndexedDB database along with a BM25 index for hybrid search.

**Supported file types**:

- **Markdown** (`.md`): Full text with metadata extraction
- **PDF** (`.pdf`): Text extraction from PDF documents
- **Audio** (`.m4a`, `.mp3`, `.wav`, etc.): Transcription via whisper.cpp
  (requires [additional setup](#audio-transcription))

**Commands**:

- `Sonar: Index current file` — Index only the active file
- `Sonar: Sync search index with vault` — Add new files and remove deleted ones
- `Sonar: Rebuild current search index` — Full reindex of all files
- `Sonar: Clear current search index` — Clear the current index
- `Sonar: Delete all search databases for this vault` — Delete all databases
- `Sonar: Show files that failed to index` — Show files that failed to index
- `Sonar: Show indexable files statistics` — Show statistics of indexable files

**Context menu** (creates a new note with extracted content):

- Right-click an audio file → **Create transcription note**
- Right-click a PDF file → **Create PDF extract note**

**Configuration** (in **Settings → Sonar**):

- **Embedder model**: Specify model repository and file. Default:
  [`ggml-org/bge-m3-Q8_0-GGUF`](https://huggingface.co/ggml-org/bge-m3-Q8_0-GGUF).
  Models are cached in `~/Library/Caches/llama.cpp/` (macOS),
  `~/.cache/llama.cpp/` (Linux), or `%LOCALAPPDATA%\llama.cpp` (Windows). If a
  model is not cached, a confirmation dialog will ask you to permit the
  download.

After changing model settings, run `Sonar: Reinitialize Sonar` from the command
palette (or click **Reinitialize Sonar** in **Settings → Sonar → Actions**) to
apply the new configuration.

#### Audio transcription

To index audio files, install
[whisper.cpp](https://github.com/ggerganov/whisper.cpp),
[ffmpeg](https://ffmpeg.org/download.html), and
[huggingface-cli](https://huggingface.co/docs/huggingface_hub/en/guides/cli).
Then download a Whisper model from https://huggingface.co/ggerganov/whisper.cpp.

Configure in **Settings → Sonar**:

- **Whisper CLI path**: `whisper-cli` (or absolute path)
- **Whisper model path**: Path to downloaded model (e.g.,
  `~/whisper-models/ggml-large-v3-turbo-q5_0.bin`)
- **ffmpeg path**: `ffmpeg` (or absolute path)

<details>
<summary>macOS setup example</summary>

```bash
brew install whisper-cpp ffmpeg
pip install huggingface-hub

mkdir -p ~/whisper-models
huggingface-cli download ggerganov/whisper.cpp \
  ggml-large-v3-turbo-q5_0.bin \
  --local-dir ~/whisper-models/
```

</details>

### Semantic note finder

<!-- TODO: Screenshot of Semantic Note Finder modal -->

Find notes by meaning using natural language queries. Unlike keyword search,
semantic search understands concepts and returns relevant results even when
exact words don't match.

1. Run `Sonar: Open Semantic note finder` from the command palette
2. Type your query in natural language
3. Results are ranked by semantic similarity

Sonar uses hybrid search (vector + BM25) with optional cross-encoder reranking
for best results. Toggle reranking via the sparkles icon in the search bar.

**Configuration** (in **Settings → Sonar**):

- **Reranker model**: Specify model repository and file. Default:
  [`gpustack/bge-reranker-v2-m3-GGUF`](https://huggingface.co/gpustack/bge-reranker-v2-m3-GGUF)

### Related notes view

<!-- TODO: Screenshot of Related Notes sidebar view -->
<!-- TODO: Screenshot of knowledge graph visualization -->

Discover notes related to what you're currently reading. The panel updates
automatically as you edit, scroll, or switch notes — showing results relevant to
your current context.

1. Run `Sonar: Open related notes view` from the command palette
2. The sidebar shows notes semantically related to your current note
3. Click any result to navigate to that note

**Options** (toggle via toolbar icons or in **Settings → Sonar**):

- **Knowledge graph** (graph icon): Toggle graph visualization to see note
  relationships
- **Excerpts** (file icon): Show matching text snippets for context
- **Reranking**: Enable for higher quality results (slower, settings only)

### Agentic assistant chat

<!-- TODO: Screenshot of chat view with conversation -->
<!-- TODO: Screenshot showing tool use (e.g., searching vault) -->

Chat with an AI assistant that has access to your knowledge base. The assistant
can search your vault, read files, edit notes, and search the web.

1. Run `Sonar: Open chat view` from the command palette
2. Type your question or request
3. The assistant will use tools as needed to help you

**Voice input**: Click the microphone button to speak your query. Requires
whisper.cpp ([setup](#audio-transcription)).

**Configuration** (in **Settings → Sonar**):

- **Chat model**: Specify model repository and file. Default:
  [`bartowski/Qwen3-8B-GGUF`](https://huggingface.co/bartowski/Qwen3-8B-GGUF)

#### Tools

Tools allow the assistant to take actions beyond generating text — such as
searching your vault, reading files, or making web requests. The assistant
decides when to use tools based on your request.

**Built-in tools**:

| Tool           | Description                                                           |
| -------------- | --------------------------------------------------------------------- |
| `search_vault` | Search your knowledge base semantically                               |
| `read_file`    | Read content from markdown, PDF, or audio files                       |
| `edit_note`    | Create or modify notes in your vault                                  |
| `web_search`   | Search the web via SearXNG (requires [additional setup](#web-search)) |
| `fetch_url`    | Fetch and analyze web page content                                    |

**Custom tools**: Extend the assistant with your own tools to provide any
context you want — the model will fetch it when needed. See
[extension-tools/README.md](./extension-tools/README.md) for the API and
examples.

##### Web search

The `web_search` tool uses [SearXNG](https://github.com/searxng/searxng), a
self-hosted metasearch engine — no API keys required, no search history stored
on third-party services. To set it up:

1. Install and run a SearXNG instance (see
   [installation docs](https://docs.searxng.org/admin/installation.html))

2. Enable JSON output in SearXNG's `settings.yml`:

   ```yaml
   search:
     formats:
       - html
       - json
   ```

3. Configure **SearXNG URL** in **Settings → Sonar** (default:
   `http://localhost:8080`)

---

## Development

See [CLAUDE.md](./CLAUDE.md) for detailed development guidelines.

## Benchmark

See [bench/README.md](./bench/README.md) for benchmarks on accuracy and
performance.

## License

This project is licensed under the GNU Affero General Public License v3.0 or
later (AGPL-3.0-or-later). See [LICENSE](./LICENSE) for details.

## Acknowledgments

Built with:

- [llama.cpp](https://github.com/ggerganov/llama.cpp) — Local LLM inference
- [whisper.cpp](https://github.com/ggerganov/whisper.cpp) — Audio transcription
- [Svelte](https://svelte.dev/) — Reactive UI components
- [Obsidian API](https://docs.obsidian.md/) — Vault integration
