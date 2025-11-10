# Obsidian Sonar

**Deep semantic search for your knowledges, completely offline.**

Sonar is a [Obsidian.md](https://obsidian.md/) plugin that brings advanced
semantic search to your Obsidian vault. Like detecting hidden objects under the
sea, it discovers meaningful connections between your notes. All running
privately on your device.

## Requirements

- Node.js 18+
- (Optional) [llama.cpp](https://github.com/ggerganov/llama.cpp) for embedding
  generation
  - Build llama.cpp with the `llama-server` binary
  - Models are downloaded automatically from HuggingFace on first use
  - Example models:
    - [BAAI/bge-m3-gguf](https://huggingface.co/BAAI/bge-m3-gguf) (multilingual)
    - [BAAI/bge-small-en-v1.5-gguf](https://huggingface.co/BAAI/bge-small-en-v1.5-gguf)
      (English)

## Installation

```bash
git clone https://github.com/aviatesk/obsidian-sonar.git
cd obsidian-sonar
npm install
npm run build
cp main.js manifest.json styles.css /path/to/vault/.obsidian/plugins/obsidian-sonar/
```

## Development

See [CLAUDE.md](./CLAUDE.md) for detailed development guidelines.

## Benchmark

See [bench/README.md](./bench/README.md) for the benchmarks regarding the
accuracy and performance of the features provided by this plugin.

## License

TODO

## Acknowledgments

Built with:

- [llama.cpp](https://github.com/ggerganov/llama.cpp) for local embedding
  generation
- [Transformers.js](https://huggingface.co/docs/transformers.js) for
  browser-based embeddings
- [Svelte](https://svelte.dev/) for reactive UI components
- [Obsidian API](https://docs.obsidian.md/) for vault integration
