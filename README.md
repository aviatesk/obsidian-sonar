# Obsidian Sonar

**Deep semantic search for your knowledges, completely offline.**

Sonar is a [Obsidian.md](https://obsidian.md/) plugin that brings advanced
semantic search to your Obsidian vault. Like detecting hidden objects under the
sea, it discovers meaningful connections between your notes using local
embeddings and lightweight LLMs. All running privately on your device.

## Requirements

- Node.js 18+
- [Ollama](https://ollama.ai/) installed and running
- Embedding model (e.g., [BGE-M3](https://ollama.com/library/bge-m3)):
  `ollama pull bge-m3`
- (Optional) Query model (e.g., [Gemma 3n](https://ollama.com/library/gemma3n)):
  `ollama pull gemma3n:e4b`

## Installation

```bash
git clone https://github.com/aviatesk/obsidian-sonar.git
cd obsidian-sonar
npm install
npm run build
cp main.js manifest.json styles.css /path/to/vault/.obsidian/plugins/obsidian-sonar/
```

## Development

See [CLAUDE.md](./CLAUDE.md) for detailed development guidelines

## License

MIT

## Acknowledgments

Built with:

- [Ollama](https://ollama.ai/) for local LLM inference
- [Transformers.js](https://huggingface.co/docs/transformers.js) for
  tokenization
- [Svelte](https://svelte.dev/) for reactive UI components
- [Obsidian API](https://docs.obsidian.md/) for vault integration
