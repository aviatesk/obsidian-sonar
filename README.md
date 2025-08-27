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
- Query model (e.g., Gemma 3): `ollama pull gemma3n:e4b`

## Installation

```bash
git clone https://github.com/aviatesk/obsidian-sonar.git
cd obsidian-sonar
npm install
npm run build
```

## Usage

### As Obsidian Plugin

1. Copy `main.js` and `manifest.json` to `.obsidian/plugins/obsidian-sonar/`
2. Enable the plugin in Obsidian settings
3. Configure your embedding model (default: `bge-m3`)
4. Open the "Related Notes" view from the command palette

### Search Modes

- **Simple Mode**: Extract search query from the entire active note
- **Follow Cursor**: Update search based on the paragraph at cursor position
- **With extraction**: Extract comprehensive summary from active context with
  LLM

### CLI Tools

#### Index Your Notes

```bash
# Index current directory
npm run sonar:index

# Index specific directory
npm run sonar:index -- /path/to/notes

# With options
npm run sonar:index -- ~/vault --model bge-m3:latest --db ./index.json
```

#### Semantic search

```bash
# Semantic search
npm run sonar:search "your search query"

# Get top 10 results
npm run sonar:search -- "machine learning concepts" --top 10
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
- Summary model (default: `gemma3n:e4b`)
- Max chunk size (default: 512 tokens)
- Chunk overlap (default: 64 tokens)
- Max query tokens (default: 128 tokens)

### CLI Configuration (`.config.json`)

```json
{
  "ollamaUrl": "http://localhost:11434",
  "embeddingModel": "bge-m3:latest",
  "summaryModel": "gemma3n:e4b",
  "maxChunkSize": 512,
  "chunkOverlap": 64,
  "maxQueryTokens": 128,
  "defaultTopK": 5,
  "indexPath": "./documents",
  "dbPath": "./db/sonar-index.json"
}
```

## Development

```bash
# Run tests
npm test

# Development build with watch
npm run dev

# Format code
npm run prettier
```

## Technical Details

### Architecture

- **Embedding Search**: Uses vector embeddings for semantic similarity
- **Smart Chunking**: Intelligently splits documents with configurable overlap
- **Token-aware Processing**: Respects model token limits for optimal
  performance
- **Unified Query Processing**: Flexible query extraction with multiple
  strategies

### Supported Models

Tested with:

- **Embeddings**: BGE-M3, Nomic-Embed, All-MiniLM, Snowflake-Arctic
- **Summaries**: Gemma 3, Llama 3, Mistral, Qwen

## License

MIT

## Acknowledgments

Built with:

- [Ollama](https://ollama.ai/) for local LLM inference
- [Transformers.js](https://huggingface.co/docs/transformers.js) for
  tokenization
- [Obsidian API](https://docs.obsidian.md/) for vault integration
