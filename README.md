# Obsidian Sonar

**Deep semantic search for your Obsidian notes, completely offline.**

Obsidian Sonar is a plugin that brings AI-powered semantic search to your
Obsidian vault. Detecting hidden objects in the deep, it discovers meaningful
connections between your notes using local embeddings and lightweight LLMs. All
running privately on your device.

## Requirements

- Node.js 18+
- [Ollama](https://ollama.ai/) installed and running
- Embedding model (e.g., BGE-M3): `ollama pull bge-m3`

## Installation

### Build

```bash
git clone https://github.com/aviatesk/obsidian-sonar.git
cd obsidian-sonar
npm install
npm run build
```

## Usage

### Install as Obsidian plugin

1. Build the plugin: `npm run build`
2. Copy to your vault:
   ```bash
   cp main.js manifest.json styles.css /path/to/vault/.obsidian/plugins/obsidian-sonar/
   ```
3. Reload Obsidian and enable the plugin in Settings → Community plugins
4. Configure your embedding model (default: `bge-m3`)

### CLI Tools

#### Index your notes

```bash
# Index current directory
npm run sonar:index

# Index specific directory
npm run sonar:index /path/to/notes

# With options
npm run sonar:index /path/to/docs --embedding-model bge-m3:latest --db ./db/sonar-index.json
```

#### Semantic search

```bash
# Semantic search
npm run sonar:search "your search query"

# Get top 10 results
npm run sonar:search "machine learning concepts" -- --top 10
```

#### View statistics

```bash
npm run sonar:stats
```

#### Configuration

```bash
npm run sonar:config -- --list
npm run sonar:config -- --embedding-model nomic-embed-text
```

## Configuration

### Plugin Settings

Configure via Obsidian settings:

- Ollama URL (default: `http://localhost:11434`)
- Embedding model (default: `bge-m3:latest`)
- Max chunk size (default: `512` tokens)
- Chunk overlap (default: `64` tokens)
- Max query tokens (default: `128` tokens)
- Auto-indexing (default: `disabled`)
- Excluded paths (default: none)

## Development

```bash
# Development build with watch
npm run dev

# Code quality checks
npm run check  # Format check + lint check + type check
npm run build  # Quick build with type checking

# Auto-fix issues
npm run fix    # Auto-format + auto-fix linting (combined)
npm run format # Auto-format code only
npm run lint   # Auto-fix linting only
```

## Technical Details

### Architecture

- **Embedding Search**: Uses vector embeddings for semantic similarity
- **Smart Chunking**: Intelligently splits documents with configurable overlap
- **Token-aware Processing**: Respects model token limits for optimal
  performance
- **Auto-indexing**: Automatically indexes new and modified files

## License

MIT

## Acknowledgments

Built with:

- [Ollama](https://ollama.ai/) for local LLM inference
- [Transformers.js](https://huggingface.co/docs/transformers.js) for
  tokenization
- [Obsidian API](https://docs.obsidian.md/) for vault integration
