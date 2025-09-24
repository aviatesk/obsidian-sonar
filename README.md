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
