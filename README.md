# Obsidian Sonar

**Deep semantic search for your Obsidian notes, completely offline.**

Obsidian Sonar is a plugin that brings AI-powered semantic search to your
Obsidian vault. Detecting hidden objects in the deep, it discovers meaningful
connections between your notes using local embeddings and lightweight LLMs - all
running privately on your device.

## Requirements

- Node.js 18+
- [Ollama](https://ollama.ai/) installed and running
- Embedding model (e.g., BGE-M3): `ollama pull bge-m3`

## Installation

```bash
git clone https://github.com/aviatesk/obsidian-sonar.git
cd obsidian-sonar
npm install
npm run build
```

## Usage

### As Obsidian Plugin

1. Copy `main.js`, `manifest.json` and `styles.css` to
   `.obsidian/plugins/obsidian-sonar/`
2. Enable the plugin in Obsidian settings
3. Configure your embedding model (default: `bge-m3`)

### CLI Tools

#### Index Your Notes

```bash
# Index current directory
npm run sonar:index

# Index specific directory
npm run sonar:index /path/to/notes

# With options
npm run sonar:index /path/to/docs --model bge-m3:latest --db ./db/sonar-index.json
```

#### Semantic search

```bash
# Semantic search
npm run sonar:search "your search query"

# Get top 10 results
npm run sonar:search "machine learning concepts" -- --top 10
```

#### View Statistics

```bash
npm run sonar:stats
```

## Configuration

### Plugin Settings

Configure via Obsidian settings:

- Ollama URL (default: `http://localhost:11434`)
- Embedding model (default: `bge-m3:latest`)
- Max chunk size (default: 512 tokens)
- Chunk overlap (default: 64 tokens)
- Max query tokens (default: 128 tokens)
- Auto-indexing (default: disabled)
- Excluded paths (for selective indexing)

### CLI Configuration

```bash
# View config
npm run sonar:config -- --list

# Set model
npm run sonar:config -- --model nomic-embed-text
```

## Development

```bash
# Development build with watch
npm run dev

# Code quality checks
npm run check  # Format + lint + type check
npm run build  # Quick build

# Format and fix
npm run format
npm run lint
```

## Technical Details

### Architecture

- **Embedding Search**: Uses vector embeddings for semantic similarity
- **Smart Chunking**: Intelligently splits documents with configurable overlap
- **Token-aware Processing**: Respects model token limits for optimal
  performance
- **Auto-indexing**: Automatically indexes new and modified files

### Supported Models

Tested with:

- **Embeddings**: BGE-M3, Nomic-Embed, mxbai-embed-large, Snowflake-Arctic

## License

MIT

## Acknowledgments

Built with:

- [Ollama](https://ollama.ai/) for local LLM inference
- [Transformers.js](https://huggingface.co/docs/transformers.js) for
  tokenization
- [Obsidian API](https://docs.obsidian.md/) for vault integration
