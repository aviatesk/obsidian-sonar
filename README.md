# Obsidian Sonar

> **Deep knowledge retrieval for Obsidian, completely offline.**

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
  vault search, note editing, with extensibility through custom tools

## Installation

Sonar runs entirely on your local machine — all embedding, reranking, and LLM
inference happens locally. This requires machine resources depending on your
model configuration. For the default models, the following specifications are
recommended:

- 32GB+ RAM[^RAM-recommendation]
- GPU (Metal on macOS, CUDA on Linux/Windows)[^GPU-recommendation]

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

You can install Sonar either via

- **BRAT:**
  1. Install [BRAT](https://github.com/TfTHacker/obsidian42-brat) from the
     community plugins
  2. Open BRAT settings and select **Add Beta plugin**
  3. Enter `https://github.com/aviatesk/obsidian-sonar` and click **Add Plugin**

- **Manual installation** (requires Node.js 18+):
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

Sonar automatically indexes your vault in the background. When you create or
edit notes, they are re-indexed to keep search results up to date.

> _Sonar shows the indexing status in the status bar as follows_
>
> <img width="600" alt="Progress status during chunking" src="https://github.com/user-attachments/assets/71f621f8-1a73-4d5c-bbeb-b517ddc0fa01" />
> <img width="600" alt="Progress status during embedding vector generation" src="https://github.com/user-attachments/assets/c804ccd2-f4a3-4a8f-9360-90303bacb4c0" />
> <img width="600" alt="Status bar after indexing completed" src="https://github.com/user-attachments/assets/6e23fe7a-0f70-4336-b5b4-1ddc6b5ab280" />

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

- **Embedder model**[^model-change]: Specify model repository and file. Default:
  [`ggml-org/bge-m3-Q8_0-GGUF`](https://huggingface.co/ggml-org/bge-m3-Q8_0-GGUF).
  Models are cached in `~/Library/Caches/llama.cpp/` (macOS),
  `~/.cache/llama.cpp/` (Linux), or `%LOCALAPPDATA%\llama.cpp` (Windows). If a
  model is not cached, a confirmation dialog will ask you to permit the
  download.
- **Index path**: Limit indexing to a specific folder (e.g., `notes/`). Leave
  empty to index the entire vault.
- **Excluded paths**: Comma-separated list of paths to exclude from indexing
  (e.g., `templates/, daily/`). Paths are matched as prefixes.
- **Auto index**: When enabled (default), Sonar automatically indexes new and
  modified files. When disabled, you must manually run
  `Sonar: Sync search index with vault` or `Sonar: Index current file` to update
  the index.

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

Find notes by meaning using natural language queries. Unlike keyword search,
semantic search understands concepts and returns relevant results even when
exact words don't match.

> _Searching for input query with reranking enabled_
>
> <img width="600" alt="Semantic note finder for 'Sonar agentic RAG'" src="https://github.com/user-attachments/assets/da452a91-ec19-44dd-a799-177e777f03ad" />

**Getting started:**

1. Run `Sonar: Open Semantic note finder` from the command palette
2. Type your query in natural language
3. Results are ranked by semantic similarity

Sonar uses hybrid search (vector + BM25) with optional cross-encoder reranking
for best results. Toggle reranking via the sparkles icon in the search bar.

**Configuration** (in **Settings → Sonar**):

- **Reranker model**[^model-change]: Specify model repository and file. Default:
  [`gpustack/bge-reranker-v2-m3-GGUF`](https://huggingface.co/gpustack/bge-reranker-v2-m3-GGUF)

### Related notes view

Discover notes related to what you're currently reading. The panel updates
automatically as you edit, scroll, or switch notes — showing results relevant to
your current context.

> _Auto-following mode: Related notes based on current cursor position_
>
> <img width="600" alt="Auto-following mode" src="https://github.com/user-attachments/assets/5deeee7e-e681-4f65-8fb6-d62aa3449860" />
>
> _Edit mode: Manually editing query with knowledge graph visualization_
>
> <img width="600" alt="Edit mode with knowledge graph" src="https://github.com/user-attachments/assets/34e69fc9-16b3-463b-8698-085e67bab104" />

**Getting started:**

1. Run `Sonar: Open related notes view` from the command palette
2. The sidebar shows notes semantically related to your current note
3. Click any result to navigate to that note

**Options** (toggle via toolbar icons or in **Settings → Sonar**):

- **Query visibility** (eye icon): Show/hide the current search query
- **Excerpts** (file icon): Show matching text snippets for context
- **Knowledge graph** (graph icon): Toggle graph visualization to see note
  relationships
- **Reranking** (sparkles icon): Enable for higher quality results (slower)

**Query editing**: When the query is visible, click the pencil icon to enter
edit mode. This freezes auto-updates and lets you search with a custom query.
Click again to resume automatic context tracking.

### Agentic assistant chat

Chat with an AI assistant that has access to your knowledge base. The assistant
can search your vault, read files, edit notes, and search the web.

> _Vault integration: Search your knowledge base and get grounded answers_
>
> <img width="600" alt="Vault integration demo" src="https://github.com/user-attachments/assets/13065ee7-72ec-48cf-9661-22e2c2ca522a" />
>
> _[Extension tools](./extension-tools/README.md): Agent performs web search via
> SearXNG_
>
> <img width="600" alt="Extension tools demo" src="https://github.com/user-attachments/assets/f337e917-1224-4741-ab74-65ff20f4b6c4" />

**Getting started:**

1. Run `Sonar: Open chat view` from the command palette
2. Type your question or request
3. The assistant will use tools as needed to help you

**Voice input**: Click the microphone button to speak your query. Requires
whisper.cpp ([setup](#audio-transcription)).

**Configuration** (in **Settings → Sonar**):

- **Chat model**[^model-change]: Specify model repository and file. Default:
  [`bartowski/Qwen3-8B-GGUF`](https://huggingface.co/bartowski/Qwen3-8B-GGUF)

#### Tools

Tools allow the assistant to take actions beyond generating text — such as
searching your vault, reading files, or making web requests. The assistant
decides when to use tools based on your request.

<!-- prettier-ignore-start -->
> [!WARNING]
> Some models don't support tool calling. Sonar automatically detects this via 
> llama.cpp's `/props` endpoint and disables tools when unsupported. 
> To manually check, run `curl http://localhost:<port>/props | jq '.chat_template_caps'` and look for `"supports_tool_calls": true`.
> Models like Gemma typically lack tool support, while Qwen and Llama models generally support it.
<!-- prettier-ignore-end -->

**Built-in tools**:

| Tool           | Description                                                  |
| -------------- | ------------------------------------------------------------ |
| `search_vault` | Search your knowledge base semantically                      |
| `read_file`    | Read content from markdown, PDF, or audio                    |
| `edit_note`    | Create or modify notes in your vault                         |
| `fetch_url`    | Fetch and extract text from a web page (disabled by default) |

**Extension tools**: Extend the assistant with custom tools. Several
[example tools](./extension-tools/README.md#example-extension-tools) are
provided, including web search via SearXNG and calendar integrations. See
[extension-tools/README.md](./extension-tools/README.md) for the API and setup
instructions.

---

## Development

See [AGENTS.md](./AGENTS.md) for detailed development guidelines.

## Benchmarks

- [retrieval-bench](./retrieval-bench/README.md): Retrieval accuracy and
  performance using TREC-style evaluation
- [rag-bench](./rag-bench/README.md): End-to-end RAG accuracy using the
  [CRAG](https://github.com/facebookresearch/CRAG) dataset. Results show Sonar
  with a local 8B model achieves comparable accuracy (43%) to a cloud
  configuration using `gpt-4.1-mini` (42%) on a 60K-page corpus, with lower
  hallucination rate (32% vs 35%)

## License

This project is licensed under the GNU Affero General Public License v3.0 or
later (AGPL-3.0-or-later). See [LICENSE](./LICENSE) for details.

## Acknowledgments

This project was selected for
[IPA MITOU Advanced 2025](https://www.ipa.go.jp/jinzai/mitou/advanced/2025first/koubokekka.html)
and developed with their support.

<!-- Foot notes -->

[^RAM-recommendation]:
    The default models (BGE-M3 for embeddings, Qwen3-8B for chat) require
    substantial memory. You can configure smaller models in settings to run on
    machines with less RAM.

[^GPU-recommendation]:
    GPU acceleration significantly improves performance for both indexing
    (embedding generation) and agentic chat (LLM inference). Without a GPU,
    these operations will be noticeably slower.

[^model-change]:
    After changing model settings, run `Sonar: Reinitialize Sonar` from the
    command palette (or select **Reinitialize Sonar** in **Settings → Sonar →
    Actions**) to apply the new configuration.
